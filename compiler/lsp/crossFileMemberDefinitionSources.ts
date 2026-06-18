import { parseTypeNameShape } from "compiler/analysis/typeNames";
import type { AnalysisType } from "compiler/analysis/types";
import type { ClassStatement, FunctionStatement, ImportStatement, InterfaceStatement, VarStatement } from "compiler/ast/ast";
import type { Location } from "vscode-languageserver/node.js";
import { resolveTypeDefinitionAcrossFiles } from "./crossFileTypeResolution";
import type { ResolveContext } from "./crossFileContext";
import { effectiveSourceRoots } from "./crossFileContext";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { pathToUri, uriToFilePath } from "./importFixes";
import { findNodeModuleMemberLocation } from "./nodeModulesTypings";
import { nodeRange } from "./ranges";

export async function resolveNodeModulesMemberDefinition(
  context: ResolveContext,
  typeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) return null;

  for (const stmt of context.session.ast.body) {
    if (stmt.kind !== "ImportStatement") continue;
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
  const queue = [...directReceiverTypeNamesForObjectType(objectType)];
  const collected: string[] = [];
  const visited = new Set<string>();

  const enqueue = (typeName: string | undefined): void => {
    const normalized = normalizeReceiverTypeName(typeName);
    if (!normalized || visited.has(normalized)) {
      return;
    }
    queue.push(normalized);
  };

  while (queue.length > 0) {
    const next = normalizeReceiverTypeName(queue.shift());
    if (!next || visited.has(next)) {
      continue;
    }
    visited.add(next);
    collected.push(next);

    const resolved = await resolveTypeDefinitionAcrossFiles(context, next);
    if (!resolved) {
      continue;
    }

    if (resolved.declaration.kind === "ClassStatement") {
      const classStatement = resolved.declaration as ClassStatement;
      enqueue(classStatement.extendsType?.name);
      for (const implementedType of classStatement.implementsTypes ?? []) {
        enqueue(implementedType.name);
      }
      continue;
    }

    const interfaceStatement = resolved.declaration as InterfaceStatement;
    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      enqueue(parentType.name);
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
        if (statement.kind === "FunctionStatement" && (statement as FunctionStatement).operator) {
          return false;
        }
        if (statement.kind !== "VarStatement" && statement.kind !== "FunctionStatement") {
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
      if (statement.kind === "FunctionStatement" && (statement as FunctionStatement).operator) {
        return false;
      }
      if (statement.kind !== "VarStatement" && statement.kind !== "FunctionStatement") {
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
