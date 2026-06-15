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
  ExportStatement,
  FunctionStatement,
  Identifier,
  ImportStatement,
  MemberExpression,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import {
  resolveTopLevelDeclarationAcrossFiles
} from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { Hover, Location, PrepareRenameResult, WorkspaceEdit } from "vscode-languageserver/node.js";
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
  ambientDeclarationLocationForSymbol,
  collectAmbientFunctionStatements,
  declarationRangeForName,
  effectiveSourceRoots,
  findAmbientNamedExportRange,
  findImportForSymbolNode,
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
  VIRTUAL_DOM_DECLARATION_FILE_PATH,
  VIRTUAL_ECMA_DECLARATION_FILE_PATH,
  VIRTUAL_VEXA_DECLARATION_FILE_PATH,
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
import { candidateCharacters, createDefinitionLocation, createHover, createPrepareRename } from "./navigation";
import { buildFunctionTypeFromStatement } from "./importedDeclarations";
import { isDomRuntimeNode } from "compiler/runtime/domDeclarations";
import { isEcmaScriptRuntimeNode, isVexaScriptRuntimeNode } from "compiler/runtime/ecmascriptDeclarations";

function findAmbientImportedOverloadRange(
  context: ResolveContext,
  declarations: readonly Statement[],
  importedName: string
) {
  // Selects the best overload declaration for definition navigation.
  // The counterpart for display (active signature selection at call sites) is
  // `bestActiveSignature` in `signatureHelp.ts`, which uses argument count
  // rather than the analysis-resolved overload index used here.
  const selectedResolution = context.session.analysis?.getSelectedCallResolutionAt(context.line, context.character);
  if (!selectedResolution) {
    return null;
  }
  const overloadDeclarations = collectAmbientFunctionStatements(declarations, importedName);
  const indexedDeclaration = overloadDeclarations[selectedResolution.overloadIndex];
  if (indexedDeclaration) {
    return nodeRange(indexedDeclaration.name);
  }
  const selectedSignature = typeToString(selectedResolution.overload);
  for (const declaration of overloadDeclarations) {
    const declarationType = buildFunctionTypeFromStatement(declaration);
    if (declarationType.kind !== "function") {
      continue;
    }
    if (typeToString(declarationType) === selectedSignature) {
      return nodeRange(declaration.name);
    }
  }
  return null;
}

function resolveAmbientReceiverDeclarationFilePath(
  context: ResolveContext,
  symbolNode: unknown,
  symbolName: string
): string | null {
  return ambientDeclarationLocationForSymbol(context.session, symbolNode, symbolName)?.filePath ?? null;
}

async function resolveAmbientImportedSymbolDefinition(
  context: ResolveContext
): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const symbolAt =
    context.session.analysis.getSymbolAt(context.line, context.character) ??
    context.session.analysis.getOperatorSymbolAt(context.line, context.character);
  if (!symbolAt) {
    return null;
  }

  const importBinding = findImportForSymbolNode(context.session.ast, symbolAt.symbol.node);
  if (!importBinding) {
    return null;
  }

  const moduleCandidates = [importBinding.from];
  if (importBinding.from.startsWith("node:")) {
    moduleCandidates.push(importBinding.from.slice("node:".length));
  }

  for (const moduleName of moduleCandidates) {
    const declarations = context.session.ambientModuleDeclarations?.get(moduleName);
    const location = context.session.ambientModuleLocations?.get(moduleName);
    if (!declarations || !location) {
      continue;
    }

    const overloadRange = findAmbientImportedOverloadRange(context, declarations, importBinding.name);
    if (overloadRange) {
      return {
        uri: pathToUri(location.filePath),
        range: overloadRange
      };
    }

    const range = findAmbientNamedExportRange(declarations, importBinding.name);
    if (!range) {
      continue;
    }

    return {
      uri: pathToUri(location.filePath),
      range
    };
  }

  return null;
}

async function resolveAmbientModuleObjectMemberDefinition(
  context: ResolveContext,
  memberExpression: MemberExpression,
  memberName: string
): Promise<Location | null> {
  if (memberExpression.object.kind !== "Identifier" || !context.session.ast) {
    return null;
  }

  const receiverName = (memberExpression.object as Identifier).name;
  for (const statement of context.session.ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const defaultImport = importStatement.defaultImport as Identifier | undefined;
    const namespaceImport = importStatement.namespaceImport as Identifier | undefined;
    const defaultImportMatches =
      defaultImport?.kind === "Identifier"
      && defaultImport.name === receiverName;
    const namespaceImportMatches =
      namespaceImport?.kind === "Identifier"
      && namespaceImport.name === receiverName;
    const bindsModuleObject =
      defaultImportMatches || namespaceImportMatches;
    if (!bindsModuleObject) {
      continue;
    }

    const moduleCandidates = [importStatement.from.value];
    if (importStatement.from.value.startsWith("node:")) {
      moduleCandidates.push(importStatement.from.value.slice("node:".length));
    }

    for (const moduleName of moduleCandidates) {
      const declarations = context.session.ambientModuleDeclarations?.get(moduleName);
      const location = context.session.ambientModuleLocations?.get(moduleName);
      if (!declarations || !location) {
        continue;
      }

      const overloadRange = findAmbientImportedOverloadRange(context, declarations, memberName);
      if (overloadRange) {
        return {
          uri: pathToUri(location.filePath),
          range: overloadRange
        };
      }

      const range = findAmbientNamedExportRange(declarations, memberName);
      if (!range) {
        continue;
      }

      return {
        uri: pathToUri(location.filePath),
        range
      };
    }
  }

  return null;
}

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
  const ambientModuleObjectDefinition = await resolveAmbientModuleObjectMemberDefinition(
    context,
    memberExpression,
    memberName
  );
  if (ambientModuleObjectDefinition) {
    return ambientModuleObjectDefinition;
  }
  const objectTypeLabel = typeToString(objectType);
  const structuralMember = parseObjectTypeMemberInfo(objectTypeLabel, memberName);
  const receiverSymbol =
    memberExpression.object.kind === "Identifier"
      ? context.session.analysis.getSymbolAt(
        memberExpression.object.firstToken?.range.start.line ?? context.line,
        memberExpression.object.firstToken?.range.start.column ?? context.character
      )
      : null;
  const preferredAmbientReceiverFilePath = receiverSymbol
    ? resolveAmbientReceiverDeclarationFilePath(context, receiverSymbol.symbol.node, receiverSymbol.symbol.name)
    : null;

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
    const classResolution = await resolveTypeDefinitionAcrossFiles(
      context,
      resolvedReceiverTypeName,
      preferredAmbientReceiverFilePath ?? undefined
    );
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
  if (resolvedPath) {
    return {
      uri: pathToUri(resolvedPath),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    };
  }

  // Fall back to ambient module declarations (e.g. `declare module "node:path"` in @types/node)
  const ambientLoc = context.session.ambientModuleLocations?.get(importPath);
  if (ambientLoc) {
    return {
      uri: pathToUri(ambientLoc.filePath),
      range: {
        start: { line: ambientLoc.line, character: ambientLoc.character },
        end: { line: ambientLoc.line, character: ambientLoc.character }
      }
    };
  }

  return null;
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

function findEnclosingReceiverTypeName(
  ast: Program,
  line: number,
  character: number
): string | null {
  for (const statement of ast.body) {
    let candidate: (FunctionStatement | VarStatement) | null = null;
    if (statement.kind === "FunctionStatement" || statement.kind === "VarStatement") {
      candidate = statement as FunctionStatement | VarStatement;
    } else if (statement.kind === "ExportStatement") {
      const decl = (statement as ExportStatement).declaration;
      if (decl && (decl.kind === "FunctionStatement" || decl.kind === "VarStatement")) {
        candidate = decl as FunctionStatement | VarStatement;
      }
    }
    if (!candidate?.receiverType) {
      continue;
    }
    const range = nodeRange(candidate);
    if (!range) {
      continue;
    }
    const { start, end } = range;
    const afterStart =
      line > start.line || (line === start.line && character >= start.character);
    const beforeEnd =
      line < end.line || (line === end.line && character <= end.character);
    if (afterStart && beforeEnd) {
      return candidate.receiverType.name;
    }
  }
  return null;
}

async function resolveImplicitReceiverMemberDefinition(
  context: ResolveContext
): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const symbolAt = context.session.analysis.getSymbolAt(context.line, context.character);
  if (!symbolAt || symbolAt.symbol.implicitReceiver !== true || symbolAt.symbol.implicitReceiverClassName) {
    return null;
  }

  const receiverTypeName = findEnclosingReceiverTypeName(
    context.session.ast,
    context.line,
    context.character
  );
  if (!receiverTypeName) {
    return null;
  }

  const memberName = symbolAt.symbol.name;
  const resolvedReceiverTypeName = boxedPrimitiveTypeName(receiverTypeName);
  const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedReceiverTypeName);
  if (!classResolution) {
    return null;
  }

  const resolverContext = {
    ast: context.session.ast,
    options: {
      uri: context.uri,
      sourceRoots: context.sourceRoots,
      ...(context.getSessionForFilePath ? { getSessionForFilePath: context.getSessionForFilePath } : {})
    },
    analysis: context.session.analysis,
    cache: createClassResolverCache()
  };

  const interfaceMemberDeclaration = classResolution.declaration.kind === "InterfaceStatement"
    ? await resolveInterfaceMemberDeclaration(
      { interfaceStatement: classResolution.declaration, filePath: classResolution.filePath },
      memberName,
      resolvedReceiverTypeName,
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
    return { uri: pathToUri(memberFilePath), range };
  }
  return null;
}

export async function resolveDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  const importPathDefinition = await resolveImportPathDefinition(context);
  if (importPathDefinition) {
    return importPathDefinition;
  }

  const importSpecifierDefinition = await resolveImportSpecifierDefinition(context);
  if (importSpecifierDefinition) {
    return importSpecifierDefinition;
  }

  const memberDefinition = await resolveMemberDefinitionAcrossFiles(context);
  if (memberDefinition) {
    return memberDefinition;
  }

  const implicitReceiverDefinition = await resolveImplicitReceiverMemberDefinition(context);
  if (implicitReceiverDefinition) {
    return implicitReceiverDefinition;
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

  const ambientImportedSymbolDefinition = await resolveAmbientImportedSymbolDefinition(context);
  if (ambientImportedSymbolDefinition) {
    return ambientImportedSymbolDefinition;
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

/**
 * Resolves go-to-definition preferring cross-file navigation (imports, member
 * access across modules) and falling back to local navigation (doc comment
 * parameter refs, annotation refs, local symbol declarations).
 *
 * This is the canonical resolution order: cross-file first so that clicking an
 * imported name jumps to its declaration in the source file rather than to the
 * import specifier on the current file.
 */
export async function resolveDefinitionWithLocalFallback(
  context: ResolveContext
): Promise<Location | null> {
  const crossFile = await resolveDefinitionAcrossFiles(context);
  if (crossFile) {
    return crossFile;
  }
  return createDefinitionLocation(
    context.session.analysis!,
    context.uri,
    context.line,
    context.character,
    context.session.ast ?? undefined
  );
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
  const typeLabel = resolvedMember?.typeName ?? fallbackMember?.typeLabel ?? structuralMember!.typeLabel;
  const documentation = resolvedMember?.documentation;
  const hoverValue = documentation ? `${memberName}: ${typeLabel}\n\n${documentation}` : `${memberName}: ${typeLabel}`;
  return {
    contents: {
      kind: "plaintext",
      value: hoverValue
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

/**
 * Handles the case where the cursor is on an import specifier name (e.g.,
 * `Point` in `import { Point } from "./a"`). Jumps to the declaration in the
 * target file instead of stopping at the import site.
 */
async function resolveImportSpecifierDefinition(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast) {
    return null;
  }
  const importerFilePath = uriToFilePath(context.uri);
  if (!importerFilePath) {
    return null;
  }
  for (const statement of context.session.ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      const first = specifier.imported.firstToken;
      const last = specifier.imported.lastToken;
      if (!first || !last) {
        continue;
      }
      const afterStart =
        context.line > first.range.start.line ||
        (context.line === first.range.start.line && context.character >= first.range.start.column);
      const beforeEnd =
        context.line < last.range.end.line ||
        (context.line === last.range.end.line && context.character <= last.range.end.column);
      if (!afterStart || !beforeEnd) {
        continue;
      }
      const targetFilePath = await resolveImportTargetInContext(importerFilePath, importStatement.from.value, context);
      if (!targetFilePath) {
        return null;
      }
      const targetSession = await getSessionForFilePath(targetFilePath, context);
      if (!targetSession?.ast) {
        return null;
      }
      const declaration = findTopLevelDeclarationByName(targetSession.ast, specifier.imported.name);
      if (!declaration) {
        return null;
      }
      const range = declarationRangeForName(declaration, specifier.imported.name);
      if (!range) {
        return null;
      }
      return {
        uri: pathToUri(targetFilePath),
        range
      };
    }
  }
  return null;
}

/**
 * Unified hover entrypoint. Runs the full cascade:
 * 1. Import path hover (cursor on a string literal import path)
 * 2. Member hover (cursor on a member access expression), with candidate
 *    character probing
 * 3. Local hover fallback (doc-comment params, annotations, analysis hover)
 */
export async function resolveHoverWithLocalFallback(context: ResolveContext): Promise<Hover | null> {
  const importHover = await resolveImportPathHover(context);
  if (importHover) {
    return importHover;
  }

  for (const character of candidateCharacters(context.character)) {
    const memberHover = await resolveMemberHoverAcrossFiles({ ...context, character });
    if (memberHover) {
      return memberHover;
    }
  }

  if (!context.session.analysis) {
    return null;
  }
  return createHover(context.session.analysis, context.line, context.character, context.session.ast ?? undefined);
}

function isVirtualRuntimeFilePath(filePath: string): boolean {
  return (
    filePath === VIRTUAL_DOM_DECLARATION_FILE_PATH ||
    filePath === VIRTUAL_ECMA_DECLARATION_FILE_PATH ||
    filePath === VIRTUAL_VEXA_DECLARATION_FILE_PATH
  );
}

/**
 * Returns true when the symbol at the cursor belongs to the built-in
 * ECMAScript/DOM/VexaScript runtime or an ambient (non-project) declaration.
 * These symbols cannot be fully renamed because their declaration lives in a
 * read-only file, so the rename would only patch usage sites.
 */
function isNonRenameableSymbol(context: ResolveContext, symbol: { filePath: string } | null): boolean {
  // Virtual path guard — covers the normal LSP server path where the VFS maps
  // the runtime declarations to well-known virtual paths.
  if (symbol && isVirtualRuntimeFilePath(symbol.filePath)) {
    return true;
  }

  if (!context.session.analysis) {
    return false;
  }

  const symbolAt = context.session.analysis.getSymbolAt(context.line, context.character);
  if (!symbolAt) {
    return false;
  }

  // Direct runtime-node check — covers test scenarios where the runtime
  // declarations are loaded as ambient declarations without a VFS and the
  // resolved filePath is the real disk path rather than a virtual path.
  if (
    isEcmaScriptRuntimeNode(symbolAt.symbol.node) ||
    isVexaScriptRuntimeNode(symbolAt.symbol.node) ||
    isDomRuntimeNode(symbolAt.symbol.node)
  ) {
    return true;
  }

  // Ambient declaration guard — covers symbols declared in @types packages or
  // other non-project declaration files loaded via ambientDeclarations.
  if (context.session.ast) {
    const ambientLocation = ambientDeclarationLocationForSymbol(
      context.session,
      symbolAt.symbol.node,
      symbolAt.symbol.name
    );
    if (ambientLocation) {
      return true;
    }
  }

  return false;
}

/**
 * Cross-file prepareRename: returns null (blocking rename) if the canonical
 * symbol resolves to a virtual runtime file or an ambient declaration that
 * lives outside the editable workspace. Otherwise delegates to the local
 * `createPrepareRename` so the editor shows the correct placeholder.
 */
export async function resolvePrepareRenameAcrossFiles(
  context: ResolveContext
): Promise<PrepareRenameResult | null> {
  const symbol = await resolveCanonicalSymbol(context);

  // Block rename for symbols that live in virtual runtime files or ambient
  // declaration files — renaming them would only touch usage sites while the
  // declaration itself stays unchanged, producing a broken half-rename.
  if (isNonRenameableSymbol(context, symbol)) {
    return null;
  }

  if (!context.session.analysis) {
    return null;
  }
  return createPrepareRename(
    context.session.analysis,
    context.line,
    context.character,
    context.session.ast ?? undefined
  );
}

export async function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): Promise<WorkspaceEdit | null> {
  // Block rename for virtual runtime symbols and ambient declarations.
  // These renames would only touch usage sites while the declaration lives
  // in a file that cannot be edited, producing a broken half-rename.
  const symbol = await resolveCanonicalSymbol(context);
  if (isNonRenameableSymbol(context, symbol)) {
    return null;
  }

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
