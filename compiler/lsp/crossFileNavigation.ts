/**
 * Cross-file navigation operations: go-to-definition, hover, references, and
 * rename across local module imports. The shared plumbing lives in sibling
 * modules — resolve-context/session contracts and canonical symbol resolution
 * in crossFileContext.ts, member/type shape and declaration resolution in
 * crossFileTypeResolution.ts — so each operation here stays focused on
 * orchestrating those helpers into an LSP response.
 */
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type {
  FunctionStatement,
  Identifier,
  ImportStatement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import {
  resolveTopLevelDeclarationAcrossFiles
} from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { Hover, Location, WorkspaceEdit } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import { nodeRange } from "./ranges";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveInterfaceMember,
  resolveInterfaceMemberDeclaration,
} from "./classResolver";
import {
  getProjectIndex,
  scanProjectMyFiles
} from "./projectAnalysis";
import { findNodeModuleMemberLocation } from "./nodeModulesTypings";
import { resolve } from "compiler/utils/path";
import {
  declarationRangeForName,
  effectiveSourceRoots,
  findImportStringLiteralAtPosition,
  findMatchingImportSpecifierPositions,
  findTopLevelDeclarationByName,
  getSessionForFilePath,
  localReferencesFromContext,
  localRenameWorkspaceEdit,
  preferVirtualRuntimeDeclarationFilePath,
  rangesEqual,
  resolveCanonicalSymbol,
  resolveImportTargetInContext,
  type ResolveContext
} from "./crossFileContext";
import {
  classMemberDeclarationRangeByName,
  classMemberInfoByName,
  collectMemberExpressions,
  fallbackInterfaceMemberRangeInFile,
  fallbackTypeAliasMemberRangeInFile,
  findClassMemberDeclarationAtPosition,
  findMemberExpressionAtPosition,
  findTypeIdentifierAtPosition,
  parseObjectTypeMemberInfo,
  resolveCanonicalMemberSymbol,
  resolveTypeAliasDefinitionAcrossFiles,
  resolveTypeDefinitionAcrossFiles,
  type ClassMemberInfo
} from "./crossFileTypeResolution";


async function resolveMemberDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }
  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const objectTypeLabel = typeToString(objectType);
  const structuralMember = parseObjectTypeMemberInfo(objectTypeLabel, memberName);

  // Candidate receiver type names to match against, mirroring the type checker's
  // extension lookup (e.g. an `int` literal also matches extensions on `number`).
  const receiverTypeNames =
    objectType.kind === "array"
      ? ["Array"]
      : (objectType.kind === "named" || objectType.kind === "builtin") && objectType.name === "int"
        ? ["int", "number"]
        : objectType.kind === "named" || objectType.kind === "builtin"
          ? [objectType.name]
          : [];

  // A member access on a concrete class/interface may resolve to one of its own
  // members first.
  if (objectType.kind === "named" || objectType.kind === "array" || objectType.kind === "builtin") {
    const resolvedReceiverTypeName = objectType.kind === "array"
      ? receiverTypeNames[0]!
      : boxedPrimitiveTypeName(receiverTypeNames[0]!);
    const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedReceiverTypeName);
    if (classResolution) {
      const resolverContext = {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      };
      const interfaceMemberDeclaration = classResolution.declaration.kind === "InterfaceStatement"
        ? await resolveInterfaceMemberDeclaration(
          { interfaceStatement: classResolution.declaration, filePath: classResolution.filePath },
          memberName,
          objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
          resolverContext
        )
        : null;
      const memberOwner = interfaceMemberDeclaration?.declaration ?? classResolution.declaration;
      const memberFilePath = await preferVirtualRuntimeDeclarationFilePath(
        interfaceMemberDeclaration?.filePath ?? classResolution.filePath,
        context
      );
      const range = classMemberDeclarationRangeByName(memberOwner, memberName)
        ?? (
          memberOwner.kind === "InterfaceStatement"
            ? await fallbackInterfaceMemberRangeInFile(context, memberFilePath, memberOwner.name.name, memberName)
            : null
        );
      if (range) {
        return {
          uri: pathToUri(memberFilePath),
          range
        };
      }
    }

    const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, receiverTypeNames[0]!);
    if (typeAliasResolution) {
      const range = await fallbackTypeAliasMemberRangeInFile(
        context,
        typeAliasResolution.filePath,
        typeAliasResolution.declaration.name.name,
        memberName
      );
      if (range) {
        return {
          uri: pathToUri(typeAliasResolution.filePath),
          range
        };
      }
    }
  }

  if (structuralMember && objectType.kind === "named") {
    const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, objectType.name);
    if (typeAliasResolution) {
      const range = await fallbackTypeAliasMemberRangeInFile(
        context,
        typeAliasResolution.filePath,
        typeAliasResolution.declaration.name.name,
        memberName
      );
      if (range) {
        return {
          uri: pathToUri(typeAliasResolution.filePath),
          range
        };
      }
    }
  }

  if (structuralMember) {
    for (const statement of context.session.ast.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      const targetFilePath = await resolveImportTargetInContext(
        uriToFilePath(context.uri)!,
        importStatement.from.value,
        context
      );
      if (!targetFilePath) {
        continue;
      }
      const targetSession = await getSessionForFilePath(targetFilePath, context);
      if (!targetSession?.ast) {
        continue;
      }
      for (const targetStatement of targetSession.ast.body) {
        const declaration = unwrapExportedDeclaration(targetStatement);
        if (!declaration || declaration.kind !== "TypeAliasStatement") {
          continue;
        }
        const candidateRange = await fallbackTypeAliasMemberRangeInFile(
          context,
          targetFilePath,
          (declaration as TypeAliasStatement).name.name,
          memberName
        );
        if (candidateRange) {
          return {
            uri: pathToUri(targetFilePath),
            range: candidateRange
          };
        }
      }
    }
  }

  // Otherwise the member may be an extension property/method (e.g.
  // `val number.seconds` or `fun Point.foo()`) declared at the top level of this
  // or an imported file. These are not class members, so resolve them by
  // matching the receiver type.
  for (const receiverTypeName of receiverTypeNames) {
    const extension = await resolveExtensionMemberDefinitionAcrossFiles(context, receiverTypeName, memberName);
    if (extension) {
      return extension;
    }
  }

  // Fallback: look for the member in node_modules .d.ts declarations. This
  // handles types whose namespace/interface is declared in a package's type
  // definitions rather than a local .vx file.
  const nodeModulesDefinition = await resolveNodeModulesMemberDefinition(
    context,
    receiverTypeNames[0]!,
    memberName
  );
  if (nodeModulesDefinition) {
    return nodeModulesDefinition;
  }

  return null;
}

/**
 * Searches node_modules .d.ts files (reachable via bare-specifier imports in
 * the current file) for a member named `memberName` on a type named `typeName`.
 * Returns the location within the .d.ts file if found.
 */
async function resolveNodeModulesMemberDefinition(
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

/**
 * Resolves a member access (`receiver.member`) to a top-level extension
 * declaration whose receiver type matches the static type of `receiver`.
 * Handles both extension properties (`val number.seconds: ...`) and extension
 * methods (`fun Point.foo(): ...`) declared in the current file or any file the
 * current document imports.
 */
async function resolveExtensionMemberDefinitionAcrossFiles(
  context: ResolveContext,
  receiverTypeName: string,
  memberName: string
): Promise<Location | null> {
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
      if (statement.kind !== "VarStatement" && statement.kind !== "FunctionStatement") {
        return false;
      }
      return (statement as VarStatement | FunctionStatement).receiverType?.name === receiverTypeName;
    },
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    return null;
  }

  const range = nodeRange(resolved.declaration.name);
  if (!range) {
    return null;
  }

  return {
    uri: pathToUri(resolved.filePath === "" ? currentFilePath : resolved.filePath),
    range
  };
}

async function resolveMemberReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Promise<Location[]> {
  const memberSymbol = await resolveCanonicalMemberSymbol(context);
  if (!memberSymbol) {
    return [];
  }

  const roots = effectiveSourceRoots(context.sourceRoots, memberSymbol.filePath);
  const files = await scanProjectMyFiles(roots, context.vfs);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  if (includeDeclaration) {
    addLocation(pathToUri(memberSymbol.filePath), memberSymbol.range);
  }

  for (const filePath of files) {
    const session = await getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }

    const expressionTypes = session.analysis.getExpressionTypes();
    for (const member of collectMemberExpressions(session.ast)) {
      if (member.computed || member.property.kind !== "Identifier") {
        continue;
      }
      const memberName = (member.property as Identifier).name;
      if (memberName !== memberSymbol.memberName) {
        continue;
      }
      const objectType = expressionTypes.get(member.object);
      if (!objectType || (objectType.kind !== "named" && objectType.kind !== "array")) {
        continue;
      }
      const objectClassName = objectType.kind === "array" ? "Array" : objectType.name;
      if (objectClassName !== memberSymbol.className) {
        continue;
      }
      const range = nodeRange(member.property);
      if (!range) {
        continue;
      }
      addLocation(pathToUri(filePath), range);
    }
  }

  return locations;
}

async function resolveImportPathDefinition(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast) return null;
  const importStatement = findImportStringLiteralAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!importStatement) return null;

  const importerFilePath = uriToFilePath(context.uri);
  if (!importerFilePath) return null;
  const importPath = importStatement.from.value;

  const resolvedPath =
    await resolveImportTargetInContext(importerFilePath, importPath, context) ??
    await resolveNodeModulesTypingsPath(importerFilePath, importPath, { vfs: context.vfs });
  if (!resolvedPath) return null;

  return {
    uri: pathToUri(resolvedPath),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  };
}

export async function resolveImportPathHover(context: ResolveContext): Promise<Hover | null> {
  if (!context.session.ast) return null;
  const importStatement = findImportStringLiteralAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!importStatement) return null;

  const importerFilePath = uriToFilePath(context.uri);
  if (!importerFilePath) return null;
  const importPath = importStatement.from.value;

  const resolvedPath =
    await resolveImportTargetInContext(importerFilePath, importPath, context) ??
    await resolveNodeModulesTypingsPath(importerFilePath, importPath, { vfs: context.vfs });

  const fromRange = nodeRange(importStatement.from);
  const rangeOpts = fromRange ? { range: fromRange } : {};

  if (!resolvedPath) {
    return {
      contents: { kind: "plaintext", value: `module: ${importPath} (unresolved)` },
      ...rangeOpts
    };
  }
  return {
    contents: { kind: "plaintext", value: `module: ${resolvedPath}` },
    ...rangeOpts
  };
}

export async function resolveDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  const importPathDefinition = await resolveImportPathDefinition(context);
  if (importPathDefinition) {
    return importPathDefinition;
  }

  const memberDefinition = await resolveMemberDefinitionAcrossFiles(context);
  if (memberDefinition) {
    return memberDefinition;
  }

  const typeIdentifier = context.session.ast
    ? findTypeIdentifierAtPosition(context.session.ast, context.line, context.character)
    : null;
  if (typeIdentifier) {
    const typeDefinition = await resolveTypeDefinitionAcrossFiles(context, typeIdentifier.name);
    if (typeDefinition) {
      return {
        uri: pathToUri(typeDefinition.filePath),
        range: nodeRange(typeDefinition.declaration.name) ?? nodeRange(typeIdentifier)!
      };
    }
  }

  const symbol = await resolveCanonicalSymbol(context);
  if (symbol) {
    return {
      uri: pathToUri(symbol.filePath),
      range: symbol.range
    };
  }
  return null;
}

function createMemberHoverContents(
  member: ClassMemberInfo
): string {
  return `${member.memberName}: ${member.typeLabel}`;
}

export async function resolveMemberHoverAcrossFiles(context: ResolveContext): Promise<Hover | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const declaration = findClassMemberDeclarationAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (declaration) {
    return {
      contents: {
        kind: "plaintext",
        value: createMemberHoverContents(declaration.member)
      },
      range: declaration.member.range
    };
  }

  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const objectTypeLabel = typeToString(objectType);
  const structuralMember = parseObjectTypeMemberInfo(objectTypeLabel, memberName);
  const resolvedClassName = objectType.kind === "array"
    ? "Array"
    : objectType.kind === "named" || objectType.kind === "builtin"
      ? boxedPrimitiveTypeName(objectType.name)
      : null;
  const classResolution = resolvedClassName
    ? await resolveTypeDefinitionAcrossFiles(context, resolvedClassName)
    : null;
  if (!classResolution) {
    if (!structuralMember) {
      return null;
    }
    const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
    return {
      contents: {
        kind: "plaintext",
        value: `${memberName}: ${structuralMember.typeLabel}`
      },
      ...(memberRange ? { range: memberRange } : {})
    };
  }
  const resolvedMember = classResolution.declaration.kind === "ClassStatement"
    ? await resolveClassMember(
      classResolution.declaration,
      memberName,
      objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
      {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      }
    )
    : await resolveInterfaceMember(
      classResolution.declaration,
      memberName,
      objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
      {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      }
    );
  const fallbackMember = classMemberInfoByName(classResolution.declaration, memberName);
  if (!resolvedMember && !fallbackMember && !structuralMember) {
    return null;
  }
  const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
  return {
    contents: {
      kind: "plaintext",
      value: `${memberName}: ${resolvedMember?.typeName ?? fallbackMember?.typeLabel ?? structuralMember!.typeLabel}`
    },
    ...(memberRange ? { range: memberRange } : {})
  };
}

export async function resolveReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Promise<Location[]> {
  const memberLocations = await resolveMemberReferencesAcrossFiles(context, includeDeclaration);
  if (memberLocations.length > 0) {
    return memberLocations;
  }

  const localFallbackReferences = localReferencesFromContext(context, includeDeclaration);
  const symbol = await resolveCanonicalSymbol(context);
  if (!symbol) {
    return localFallbackReferences;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, symbol.filePath);
  const projectIndex = getProjectIndex(roots, context.vfs);
  const files = await scanProjectMyFiles(roots, context.vfs);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  const importerByPath = new Map<string, Array<{ line: number; character: number }>>();
  for (const importer of await projectIndex.findFilesImportingSymbol(symbol.filePath, symbol.name)) {
    const existing = importerByPath.get(importer.importerFilePath);
    if (existing) {
      existing.push(importer.importRange.start);
    } else {
      importerByPath.set(importer.importerFilePath, [importer.importRange.start]);
    }
  }

  for (const filePath of files) {
    const session = await getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }
    const uri = pathToUri(filePath);

    if (resolve(filePath) === resolve(symbol.filePath)) {
      const declaration = findTopLevelDeclarationByName(session.ast, symbol.name);
      const declarationRange = declaration ? declarationRangeForName(declaration, symbol.name) : null;
      if (!declarationRange) {
        for (const location of localFallbackReferences) {
          addLocation(location.uri, location.range);
        }
        continue;
      }

      const references = session.analysis.getReferenceRangesAt(
        declarationRange.start.line,
        declarationRange.start.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
      continue;
    }

    const importPositions =
      importerByPath.get(filePath) ??
      await findMatchingImportSpecifierPositions(session.ast, filePath, symbol, context);
    for (const position of importPositions) {
      const references = session.analysis.getReferenceRangesAt(
        position.line,
        position.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
    }
  }

  if (!includeDeclaration) {
    return locations.filter((location) => !(
      location.uri === pathToUri(symbol.filePath) && rangesEqual(location.range, symbol.range)
    ));
  }

  return locations;
}

export async function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): Promise<WorkspaceEdit | null> {
  const locations = await resolveReferencesAcrossFiles(context, true);
  if (locations.length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }

  const changes: Record<string, Array<{ range: Location["range"]; newText: string }>> = {};
  for (const location of locations) {
    if (!changes[location.uri]) {
      changes[location.uri] = [];
    }
    changes[location.uri]?.push({
      range: location.range,
      newText: newName
    });
  }

  if (Object.keys(changes).length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }
  return { changes };
}
