import { NodeKind } from "compiler/ast/ast";
import { parseTypeNameShape } from "compiler/analysis/typeNames";
import type { AnalysisType } from "compiler/analysis/types";
import type { ClassStatement, FunctionStatement, ImportStatement, InterfaceStatement, Statement, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type { Location } from "vscode-languageserver/node.js";
import { resolveTypeDefinitionAcrossFiles } from "./crossFileTypeResolution";
import type { ResolveContext } from "./crossFileContext";
import { effectiveSourceRoots, findModuleReceiverImport } from "./crossFileContext";
import { findTopLevelDeclarationInProgram, resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { pathToUri, uriToFilePath } from "./importFixes";
import { findNodeModuleExportLocation, findNodeModuleMemberLocation } from "./nodeModulesTypings";
import { getProjectSessionForFilePath } from "./projectAnalysis";
import { nodeRange } from "./ranges";

export async function resolveNodeModulesMemberDefinition(
  context: ResolveContext,
  typeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) return null;

  for (const stmt of context.session.ast.body) {
    if (stmt.kind !== NodeKind.ImportStatement) continue;
    const importStmt = stmt as ImportStatement;
    const from = importStmt.from.value;
    if (from.startsWith(".") || from.startsWith("/")) continue;

    const location = await findNodeModuleMemberLocation(currentFilePath, from, typeName, memberName, { vfs: context.vfs });
    if (location) {
      return {
        uri: pathToUri(location.typingsPath),
        range: location.range
      };
    }
  }
  return null;
}

export async function resolveNodeModulesModuleObjectMemberDefinition(
  context: ResolveContext,
  receiverName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const receiverImport = findModuleReceiverImport(context.session.ast, receiverName);
  if (!receiverImport) {
    return null;
  }

  const from = receiverImport.from;
  if (from.startsWith(".") || from.startsWith("/")) {
    return null;
  }

  const location = await findNodeModuleExportLocation(currentFilePath, from, memberName, { vfs: context.vfs });
  if (!location) {
    return null;
  }

  return {
    uri: pathToUri(location.typingsPath),
    range: location.range
  };
}

export interface ResolvedExtensionMemberDeclaration {
  declaration: VarStatement | FunctionStatement;
  filePath: string;
}

function normalizeReceiverTypeName(typeName: string | undefined): string | null {
  if (!typeName) {
    return null;
  }
  const normalized = parseTypeNameShape(typeName).baseName;
  return normalized.length > 0 ? normalized : null;
}

function directReceiverTypeNamesForObjectType(objectType: AnalysisType): string[] {
  if (objectType.kind === "array") {
    return ["Array"];
  }
  if ((objectType.kind === "named" || objectType.kind === "builtin") && objectType.name === "int") {
    return ["int", "number"];
  }
  if (objectType.kind === "named" || objectType.kind === "builtin") {
    return [objectType.name];
  }
  return [];
}

async function collectExtensionReceiverTypeNames(
  context: ResolveContext,
  objectType: AnalysisType
): Promise<string[]> {
  const queue = directReceiverTypeNamesForObjectType(objectType).map((typeName) => ({
    typeName,
    preferredFilePath: null as string | null
  }));
  const collected: string[] = [];
  const visited = new Set<string>();
  const currentFilePath = uriToFilePath(context.uri);
  const roots = currentFilePath ? effectiveSourceRoots(context.sourceRoots, currentFilePath) : context.sourceRoots;

  const enqueue = (typeName: string | undefined, preferredFilePath: string | null = null): void => {
    const normalized = normalizeReceiverTypeName(typeName);
    if (!normalized || visited.has(normalized)) {
      return;
    }
    queue.push({ typeName: normalized, preferredFilePath });
  };

  const resolveTypeFromPreferredFile = async (
    typeName: string,
    preferredFilePath: string | null
  ): Promise<{ declaration: ClassStatement | InterfaceStatement; filePath: string } | null> => {
    if (!preferredFilePath) {
      return null;
    }

    const session = await getProjectSessionForFilePath(preferredFilePath, {
      sourceRoots: roots,
      ...(context.vfs
        ? { vfs: context.vfs }
        : {}),
      ...(context.getSessionForFilePath
        ? { getSessionForFilePath: context.getSessionForFilePath }
        : {})
    });
    if (!session?.ast) {
      return null;
    }

    const declaration = findTopLevelDeclarationInProgram(
      session.ast,
      typeName,
      (statement): statement is ClassStatement | InterfaceStatement =>
        statement.kind === NodeKind.ClassStatement || statement.kind === NodeKind.InterfaceStatement
    );
    if (!declaration) {
      return null;
    }

    return {
      declaration,
      filePath: preferredFilePath
    };
  };

  while (queue.length > 0) {
    const nextEntry = queue.shift();
    const next = normalizeReceiverTypeName(nextEntry?.typeName);
    if (!next || visited.has(next)) {
      continue;
    }
    visited.add(next);
    collected.push(next);

    const resolved = await resolveTypeFromPreferredFile(next, nextEntry?.preferredFilePath ?? null)
      ?? await resolveTypeDefinitionAcrossFiles(context, next);
    if (!resolved) {
      continue;
    }

    if (resolved.declaration.kind === NodeKind.ClassStatement) {
      const classStatement = resolved.declaration as ClassStatement;
      enqueue(classStatement.extendsType?.name, resolved.filePath);
      for (const implementedType of classStatement.implementsTypes ?? []) {
        enqueue(implementedType.name, resolved.filePath);
      }
      continue;
    }

    const interfaceStatement = resolved.declaration as InterfaceStatement;
    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      enqueue(parentType.name, resolved.filePath);
    }
  }

  return collected;
}

async function resolveExtensionMemberDeclarationByReceiverNames(
  context: ResolveContext,
  receiverTypeNames: readonly string[],
  memberName: string
): Promise<ResolvedExtensionMemberDeclaration | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  for (const receiverTypeName of receiverTypeNames) {
    const resolved = await resolveTopLevelDeclarationAcrossFiles({
      ast: context.session.ast,
      name: memberName,
      currentFilePath,
      predicate: (statement): statement is VarStatement | FunctionStatement => {
        if (statement.kind === NodeKind.FunctionStatement && (statement as FunctionStatement).operator) {
          return false;
        }
        if (statement.kind !== NodeKind.VarStatement && statement.kind !== NodeKind.FunctionStatement) {
          return false;
        }
        return normalizeReceiverTypeName((statement as VarStatement | FunctionStatement).receiverType?.name) === receiverTypeName;
      },
      sourceRoots: roots,
      ...(context.getSessionForFilePath
        ? { getSessionForFilePath: context.getSessionForFilePath }
        : {})
    });
    if (!resolved) {
      continue;
    }
    return {
      declaration: resolved.declaration,
      filePath: resolved.filePath === "" ? currentFilePath : resolved.filePath
    };
  }

  return null;
}

export async function resolveExtensionMemberDeclarationAcrossFiles(
  context: ResolveContext,
  objectType: AnalysisType,
  memberName: string
): Promise<ResolvedExtensionMemberDeclaration | null> {
  const receiverTypeNames = await collectExtensionReceiverTypeNames(context, objectType);
  return resolveExtensionMemberDeclarationByReceiverNames(context, receiverTypeNames, memberName);
}

/**
 * True when an extension member for `memberName` on one of `receiverTypeNames`
 * is in the declarations the analysis actually sees — the selectively collected
 * `externalDeclarations` plus the local program. This mirrors
 * `TypeChecker.collectExtensionProperties`, which only registers extensions from
 * those same sets, so a cross-file extension that was not imported (e.g. only a
 * sibling export was imported from its file) is correctly treated as not in
 * effect.
 */
function extensionMemberInScope(
  context: ResolveContext,
  receiverTypeNames: readonly string[],
  memberName: string
): boolean {
  const receiverNames = new Set(receiverTypeNames);
  const inScopeStatements: readonly Statement[] = [
    ...(context.session.externalDeclarations ?? []),
    ...(context.session.ast?.body ?? [])
  ];
  for (const statement of inScopeStatements) {
    if (statement.kind !== NodeKind.VarStatement && statement.kind !== NodeKind.FunctionStatement) {
      continue;
    }
    const declaration = statement as VarStatement | FunctionStatement;
    if (!declaration.receiverType) {
      continue;
    }
    if (statement.kind === NodeKind.FunctionStatement && (declaration as FunctionStatement).operator) {
      continue;
    }
    if (!receiverNames.has(normalizeReceiverTypeName(declaration.receiverType.name) ?? "")) {
      continue;
    }
    const bindingName = statement.kind === NodeKind.VarStatement
      ? bindingIdentifiers((declaration as VarStatement).name)[0]?.name
      : (declaration as FunctionStatement).name?.name;
    if (bindingName === memberName) {
      return true;
    }
  }
  return false;
}

/**
 * Like `resolveExtensionMemberDeclarationAcrossFiles`, but only returns the
 * extension when it is in scope for the analysis (see `extensionMemberInScope`).
 * Definition/hover use this so an extension only takes precedence over a class
 * member when the type checker would also prefer it, keeping all surfaces in
 * agreement about which member is in effect.
 */
export async function resolveInScopeExtensionMemberDeclarationAcrossFiles(
  context: ResolveContext,
  objectType: AnalysisType,
  memberName: string
): Promise<ResolvedExtensionMemberDeclaration | null> {
  const receiverTypeNames = await collectExtensionReceiverTypeNames(context, objectType);
  if (!extensionMemberInScope(context, receiverTypeNames, memberName)) {
    return null;
  }
  return resolveExtensionMemberDeclarationByReceiverNames(context, receiverTypeNames, memberName);
}

export async function resolveImportedExtensionMemberDeclarationAcrossFiles(
  context: ResolveContext,
  memberName: string
): Promise<ResolvedExtensionMemberDeclaration | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: memberName,
    currentFilePath,
    predicate: (statement): statement is VarStatement | FunctionStatement => {
      if (statement.kind === NodeKind.FunctionStatement && (statement as FunctionStatement).operator) {
        return false;
      }
      if (statement.kind !== NodeKind.VarStatement && statement.kind !== NodeKind.FunctionStatement) {
        return false;
      }
      return (statement as VarStatement | FunctionStatement).receiverType !== undefined;
    },
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });
  if (!resolved) {
    return null;
  }
  return {
    declaration: resolved.declaration,
    filePath: resolved.filePath === "" ? currentFilePath : resolved.filePath
  };
}

export async function resolveExtensionMemberDefinitionAcrossFiles(
  context: ResolveContext,
  receiverTypeName: string,
  memberName: string
): Promise<Location | null> {
  const resolved = await resolveExtensionMemberDeclarationByReceiverNames(
    context,
    [receiverTypeName],
    memberName
  );
  if (!resolved) {
    return null;
  }

  const range = nodeRange(resolved.declaration.name);
  if (!range) {
    return null;
  }

  return {
    uri: pathToUri(resolved.filePath),
    range
  };
}
