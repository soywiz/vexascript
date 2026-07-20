import { AnalysisTypeKind } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
export { resolveMemberHoverAcrossFiles } from "./crossFileMemberHover";

/**
 * Cross-file navigation operations: go-to-definition, hover, references, and
 * rename across local module imports. The shared plumbing lives in sibling
 * modules — resolve-context/session contracts and canonical symbol resolution
 * in crossFileContext.ts, member/type shape and declaration resolution in
 * crossFileTypeResolution.ts — so each operation here stays focused on
 * orchestrating those helpers into an LSP response.
 */
import type {
  Identifier,
} from "compiler/ast/ast";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type { Hover, Location } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import { nodeRange } from "./ranges";
import {
  declarationRangeForName,
  findModuleReceiverImport,
  findImportForSymbolNode,
  resolveCanonicalSymbol,
  type ResolveContext
} from "./crossFileContext";
import {
  findMemberExpressionAtPosition,
  findTypeIdentifierAtPosition,
  resolveTypeDefinitionAcrossFiles
} from "./crossFileTypeResolution";
import { resolveDeclaredMemberDefinitionAcrossFiles } from "./crossFileDeclaredMemberDefinition";
import {
  resolveNodeModulesModuleObjectMemberDefinition,
  resolveInScopeExtensionMemberDeclarationAcrossFiles,
  resolveImportedExtensionMemberDeclarationAcrossFiles,
  resolveNodeModulesMemberDefinition
} from "./crossFileMemberDefinitionSources";
import {
  resolveImplicitReceiverMemberDefinition
} from "./crossFileImplicitReceiver";
import { resolveReferencesAcrossFiles as resolveReferencesAcrossFilesImpl } from "./crossFileReferences";
import {
  resolvePrepareRenameAcrossFiles as resolvePrepareRenameAcrossFilesImpl,
  resolveRenameAcrossFiles as resolveRenameAcrossFilesImpl
} from "./crossFileRename";
import {
  resolveMemberHoverAcrossFiles
} from "./crossFileMemberHover";
import {
  resolveAmbientImportedSymbolDefinition,
  resolveAmbientModuleObjectMemberDefinition,
  resolveAmbientReceiverDeclarationFilePath
} from "./crossFileAmbientNavigation";
import { resolveContextualObjectLiteralPropertyDefinition } from "./objectLiteralCompletion";
import { resolveContextualObjectLiteralPropertyHover } from "./objectLiteralCompletion";
import {
  resolveImportPathDefinition,
  resolveImportPathHover,
  resolveImportSpecifierDefinition
} from "./importPathNavigation";
import { findAmbientNamespaceLocation } from "./crossFileContext";
import { candidateCharacters, createDefinitionLocation, createHover } from "./navigation";
import { findNodeModuleExportLocation, findNodeModuleMemberLocation, type NodeModuleMemberLocation } from "./nodeModulesTypings";

function resolveImportedSymbolDefinitionLocation(
  context: ResolveContext,
  localName: string
): Location | null {
  const origin = context.session.importedSymbols?.get(localName)?.declarationOrigin;
  if (!origin) {
    return null;
  }

  const range = declarationRangeForName(origin.statement, origin.exportedName) ?? nodeRange(origin.statement);
  if (!range) {
    return null;
  }

  return {
    uri: pathToUri(origin.filePath),
    range
  };
}

function resolveImportedBindingDefinitionFromSession(
  context: ResolveContext,
  character: number
): Location | null {
  if (!context.session.analysis || !context.session.ast) {
    return null;
  }

  const symbolAt =
    context.session.analysis.getSymbolAt(context.line, character) ??
    context.session.analysis.getOperatorSymbolAt(context.line, character);
  if (!symbolAt) {
    return null;
  }

  const importBinding = findImportForSymbolNode(context.session.ast, symbolAt.symbol.node);
  if (!importBinding) {
    return null;
  }

  return resolveImportedSymbolDefinitionLocation(context, importBinding.localName);
}

function splitQualifiedTypeName(typeName: string): { receiverName: string; memberName: string } | null {
  const dotIndex = typeName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === typeName.length - 1) {
    return null;
  }
  return {
    receiverName: typeName.slice(0, dotIndex),
    memberName: typeName.slice(dotIndex + 1)
  };
}

function splitImportTypeMemberName(typeName: string): { packageName: string; memberPath: string[] } | null {
  const match = /^import\("([^"]+)"\)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(typeName);
  const packageName = match?.[1];
  const memberPath = match?.[2]?.split(".").filter(Boolean) ?? [];
  if (!packageName || memberPath.length === 0 || packageName.startsWith(".") || packageName.startsWith("/")) {
    return null;
  }
  return { packageName, memberPath };
}

function visibleSymbolForTypeIdentifier(context: ResolveContext, identifier: Identifier) {
  if (!context.session.analysis || identifier.name.includes(".")) {
    return null;
  }
  const range = nodeRange(identifier);
  if (!range) {
    return null;
  }
  return context.session.analysis
    .getVisibleSymbolsAt(range.start.line, range.start.character)
    .find((candidate) => candidate.name === identifier.name) ?? null;
}

function resolveLocalTypeIdentifierDefinition(context: ResolveContext, identifier: Identifier): Location | null {
  const symbol = visibleSymbolForTypeIdentifier(context, identifier);
  if (symbol && context.session.ast) {
    const importBinding = findImportForSymbolNode(context.session.ast, symbol.node);
    const importedDefinition = importBinding
      ? resolveImportedSymbolDefinitionLocation(context, importBinding.localName)
      : null;
    if (importedDefinition) {
      return importedDefinition;
    }
  }
  const symbolRange = symbol ? nodeRange(symbol.node) : null;
  if (!symbolRange) {
    return null;
  }
  return {
    uri: context.uri,
    range: symbolRange
  };
}

function resolveLocalTypeIdentifierHover(context: ResolveContext, identifier: Identifier): Hover | null {
  const range = nodeRange(identifier);
  if (!range) {
    return null;
  }
  const symbol = visibleSymbolForTypeIdentifier(context, identifier);
  if (!symbol) {
    return null;
  }
  const typeLabel = symbol.valueType ?? (symbol.type ? typeToString(symbol.type) : "unknown");
  return {
    contents: {
      kind: "plaintext",
      value: `${symbol.kind} ${symbol.name}: ${typeLabel}`
    },
    range
  };
}

async function resolveNodeModuleLocation(
  context: ResolveContext,
  lookup: (currentFilePath: string) => Promise<NodeModuleMemberLocation | null>
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath) {
    return null;
  }
  const location = await lookup(currentFilePath);
  if (!location) {
    return null;
  }
  return {
    uri: pathToUri(location.typingsPath),
    range: location.range
  };
}

async function resolveNodeModuleExportDefinition(
  context: ResolveContext,
  packageName: string,
  exportName: string
): Promise<Location | null> {
  return resolveNodeModuleLocation(context, (currentFilePath) =>
    findNodeModuleExportLocation(currentFilePath, packageName, exportName, { vfs: context.vfs })
  );
}

async function resolveNodeModuleMemberDefinition(
  context: ResolveContext,
  packageName: string,
  typeName: string,
  memberName: string
): Promise<Location | null> {
  return resolveNodeModuleLocation(context, (currentFilePath) =>
    findNodeModuleMemberLocation(currentFilePath, packageName, typeName, memberName, { vfs: context.vfs })
  );
}

async function resolveImportTypeMemberDefinition(
  context: ResolveContext,
  identifier: Identifier
): Promise<Location | null> {
  const importType = splitImportTypeMemberName(identifier.name);
  if (!importType) {
    return null;
  }
  const memberName = importType.memberPath.at(-1);
  if (!memberName) {
    return null;
  }
  if (importType.memberPath.length === 1) {
    return resolveNodeModuleExportDefinition(context, importType.packageName, memberName);
  }
  return resolveNodeModuleMemberDefinition(
    context,
    importType.packageName,
    importType.memberPath.slice(0, -1).join("."),
    memberName
  );
}

async function resolveQualifiedTypeMemberDefinition(
  context: ResolveContext,
  identifier: Identifier
): Promise<Location | null> {
  if (!context.session.ast) {
    return null;
  }
  const qualified = splitQualifiedTypeName(identifier.name);
  if (!qualified) {
    return null;
  }
  const receiverImport = findModuleReceiverImport(context.session.ast, qualified.receiverName);
  if (!receiverImport || receiverImport.from.startsWith(".") || receiverImport.from.startsWith("/")) {
    return null;
  }
  return resolveNodeModuleExportDefinition(context, receiverImport.from, qualified.memberName);
}

async function resolveTypeIdentifierDefinition(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast) {
    return null;
  }
  for (const character of candidateCharacters(context.character)) {
    const typeIdentifier = findTypeIdentifierAtPosition(context.session.ast, context.line, character);
    if (!typeIdentifier) {
      continue;
    }
    const importTypeDefinition = await resolveImportTypeMemberDefinition(context, typeIdentifier);
    if (importTypeDefinition) {
      return importTypeDefinition;
    }
    const qualifiedDefinition = await resolveQualifiedTypeMemberDefinition(context, typeIdentifier);
    if (qualifiedDefinition) {
      return qualifiedDefinition;
    }
    const typeDefinition = await resolveTypeDefinitionAcrossFiles(context, typeIdentifier.name);
    if (typeDefinition) {
      return {
        uri: pathToUri(typeDefinition.filePath),
        range: nodeRange(typeDefinition.declaration.name) ?? nodeRange(typeIdentifier)!
      };
    }
    const localDefinition = resolveLocalTypeIdentifierDefinition(context, typeIdentifier);
    if (localDefinition) {
      return localDefinition;
    }
  }
  return null;
}

async function resolveTypeIdentifierHover(context: ResolveContext): Promise<Hover | null> {
  if (!context.session.ast) {
    return null;
  }
  for (const character of candidateCharacters(context.character)) {
    const typeIdentifier = findTypeIdentifierAtPosition(context.session.ast, context.line, character);
    if (!typeIdentifier) {
      continue;
    }
    const localHover = resolveLocalTypeIdentifierHover(context, typeIdentifier);
    if (localHover) {
      return localHover;
    }
    const range = nodeRange(typeIdentifier);
    if (!range) {
      continue;
    }
    const importTypeDefinition = await resolveImportTypeMemberDefinition(context, typeIdentifier);
    if (importTypeDefinition) {
      return {
        contents: {
          kind: "plaintext",
          value: `type ${typeIdentifier.name}`
        },
        range
      };
    }
    const qualifiedDefinition = await resolveQualifiedTypeMemberDefinition(context, typeIdentifier);
    if (qualifiedDefinition) {
      return {
        contents: {
          kind: "plaintext",
          value: `type ${typeIdentifier.name}`
        },
        range
      };
    }
    const typeDefinition = await resolveTypeDefinitionAcrossFiles(context, typeIdentifier.name);
    if (typeDefinition) {
      return {
        contents: {
          kind: "plaintext",
          value: `${typeDefinition.declaration.kind === NodeKind.ClassStatement ? "class" : "interface"} ${typeIdentifier.name}`
        },
        range
      };
    }
  }
  return null;
}

function collectNodeModulesReceiverTypeNames(objectType: AnalysisType): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };
  const visit = (type: AnalysisType) => {
    if (type.kind === AnalysisTypeKind.Array) {
      push("Array");
      return;
    }
    if ((type.kind === AnalysisTypeKind.Named || type.kind === AnalysisTypeKind.Builtin) && type.name === "int") {
      push("int");
      push("number");
      return;
    }
    if (type.kind === AnalysisTypeKind.Named || type.kind === AnalysisTypeKind.Builtin) {
      push(type.name);
      return;
    }
    if (type.kind === AnalysisTypeKind.Union || type.kind === AnalysisTypeKind.Intersection) {
      for (const memberType of type.types) {
        visit(memberType);
      }
    }
  };

  visit(objectType);
  return names;
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
  if (!memberExpression || memberExpression.property.kind !== NodeKind.Identifier) {
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
  const nodeModulesModuleObjectDefinition =
    memberExpression.object.kind === NodeKind.Identifier
      ? await resolveNodeModulesModuleObjectMemberDefinition(
        context,
        (memberExpression.object as Identifier).name,
        memberName
      )
      : null;
  if (nodeModulesModuleObjectDefinition) {
    return nodeModulesModuleObjectDefinition;
  }
  const receiverSymbol =
    memberExpression.object.kind === NodeKind.Identifier
      ? context.session.analysis.getSymbolAt(
        memberExpression.object.firstToken?.range.start.line ?? context.line,
        memberExpression.object.firstToken?.range.start.column ?? context.character
      )
      : null;
  const preferredAmbientReceiverFilePath = receiverSymbol
    ? resolveAmbientReceiverDeclarationFilePath(context, receiverSymbol.symbol.node, receiverSymbol.symbol.name)
    : null;
  // An in-scope extension property/method (e.g. `val number.seconds`,
  // `fun Point.foo()`, or `var Container.position` imported from another file)
  // takes precedence over the receiver's own class member, matching the type
  // checker (`resolveKnownMemberType` checks extensions before class members).
  // Resolving it first keeps definition/hover on the same member the diagnostics
  // use. It is gated on the extension being in scope (see
  // `resolveInScopeExtensionMemberDeclarationAcrossFiles`) so a not-imported
  // cross-file extension does not shadow the class member the type checker uses.
  const extensionDeclaration = await resolveInScopeExtensionMemberDeclarationAcrossFiles(
    context,
    objectType,
    memberName
  );
  if (extensionDeclaration) {
    const range = nodeRange(extensionDeclaration.declaration.name);
    if (range) {
      return {
        uri: pathToUri(extensionDeclaration.filePath),
        range
      };
    }
  }

  const declaredMemberDefinition = await resolveDeclaredMemberDefinitionAcrossFiles(
    context,
    objectType,
    memberName,
    preferredAmbientReceiverFilePath
  );
  if (declaredMemberDefinition) {
    return declaredMemberDefinition;
  }

  const importedExtensionDeclaration = await resolveImportedExtensionMemberDeclarationAcrossFiles(
    context,
    memberName
  );
  if (importedExtensionDeclaration) {
    const range = nodeRange(importedExtensionDeclaration.declaration.name);
    if (range) {
      return {
        uri: pathToUri(importedExtensionDeclaration.filePath),
        range
      };
    }
  }

  // Fallback: look for the member in node_modules .d.ts declarations. This
  // handles types whose namespace/interface is declared in a package's type
  // definitions rather than a local .vx file.
  for (const receiverTypeName of collectNodeModulesReceiverTypeNames(objectType)) {
    const nodeModulesDefinition = await resolveNodeModulesMemberDefinition(
      context,
      receiverTypeName,
      memberName
    );
    if (nodeModulesDefinition) {
      return nodeModulesDefinition;
    }
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

  for (const character of candidateCharacters(context.character)) {
    const objectLiteralPropertyDefinition = await resolveContextualObjectLiteralPropertyDefinition({ ...context, character });
    if (objectLiteralPropertyDefinition) {
      return objectLiteralPropertyDefinition;
    }
  }

  for (const character of candidateCharacters(context.character)) {
    const memberDefinition = await resolveMemberDefinitionAcrossFiles({ ...context, character });
    if (memberDefinition) {
      return memberDefinition;
    }
  }

  const implicitReceiverDefinition = await resolveImplicitReceiverMemberDefinition(context);
  if (implicitReceiverDefinition) {
    return implicitReceiverDefinition;
  }

  const typeIdentifierDefinition = await resolveTypeIdentifierDefinition(context);
  if (typeIdentifierDefinition) {
    return typeIdentifierDefinition;
  }

  for (const character of candidateCharacters(context.character)) {
    const ambientImportedSymbolDefinition = await resolveAmbientImportedSymbolDefinition({ ...context, character });
    if (ambientImportedSymbolDefinition) {
      return ambientImportedSymbolDefinition;
    }
  }

  for (const character of candidateCharacters(context.character)) {
    const importedBindingDefinition = resolveImportedBindingDefinitionFromSession(context, character);
    if (importedBindingDefinition) {
      return importedBindingDefinition;
    }
  }

  for (const character of candidateCharacters(context.character)) {
    const symbol = await resolveCanonicalSymbol({ ...context, character });
    if (symbol) {
      return {
        uri: pathToUri(symbol.filePath),
        range: symbol.range
      };
    }
  }

  if (context.session.analysis) {
    for (const character of candidateCharacters(context.character)) {
      const symbolAt =
        context.session.analysis.getSymbolAt(context.line, character) ??
        context.session.analysis.getOperatorSymbolAt(context.line, character);
      const ambientNamespaceLocation = symbolAt
        ? findAmbientNamespaceLocation(context.session, symbolAt.symbol.name)
        : null;
      if (ambientNamespaceLocation) {
        return {
          uri: pathToUri(ambientNamespaceLocation.filePath),
          range: ambientNamespaceLocation.range
        };
      }
    }
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

export async function resolveReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Promise<Location[]> {
  return resolveReferencesAcrossFilesImpl(context, includeDeclaration);
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
    const objectLiteralPropertyHover = await resolveContextualObjectLiteralPropertyHover({ ...context, character });
    if (objectLiteralPropertyHover) {
      return objectLiteralPropertyHover;
    }
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
  const typeIdentifierHover = await resolveTypeIdentifierHover(context);
  if (typeIdentifierHover) {
    return typeIdentifierHover;
  }
  return createHover(context.session.analysis, context.line, context.character, context.session.ast ?? undefined, {
    ambientModuleDeclarations: context.session.ambientModuleDeclarations
  });
}

export async function resolvePrepareRenameAcrossFiles(
  context: ResolveContext
): Promise<import("vscode-languageserver/node.js").PrepareRenameResult | null> {
  return resolvePrepareRenameAcrossFilesImpl(context);
}

export async function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): Promise<import("vscode-languageserver/node.js").WorkspaceEdit | null> {
  return resolveRenameAcrossFilesImpl(context, newName);
}
