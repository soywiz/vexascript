import { ArrayType, NamedType, BuiltinType, ObjectType, UnionType, IntersectionType } from "../analysis/types";
import { ClassStatement, Identifier, MemberExpression, NodeKind } from "compiler/ast/ast";
import type { TypeAliasStatement } from "compiler/ast/ast";
export { resolveMemberHoverAcrossFiles } from "./crossFileMemberHover";

/**
 * Cross-file navigation operations: go-to-definition, hover, references, and
 * rename across local module imports. The shared plumbing lives in sibling
 * modules — resolve-context/session contracts and canonical symbol resolution
 * in crossFileContext.ts, member/type shape and declaration resolution in
 * crossFileTypeResolution.ts — so each operation here stays focused on
 * orchestrating those helpers into an LSP response.
 */

import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type { Hover, Location } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import { nodeRange } from "./ranges";
import {
  declarationRangeForName,
  findModuleReceiverImport,
  findImportForSymbolNode,
  findImportBindingByLocalName,
  readTextDocument,
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
  resolveNodeModulesMemberDefinition,
  resolveNodeModulesStructuralMemberDefinition
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
import {
  candidateCharacters,
  createDefinitionLocation,
  createHover,
  createTypeAliasHoverContents,
  createTypeAliasHoverContentsFromDeclaration
} from "./navigation";
import { findNodeModuleExportLocation, findNodeModuleMemberLocation, type NodeModuleMemberLocation } from "./nodeModulesTypings";
import { extname } from "compiler/utils/path";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";

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

async function resolveJsxDefinition(context: ResolveContext): Promise<Location | null> {
  const analysis = context.session.analysis;
  if (!analysis) {
    return null;
  }
  for (const character of candidateCharacters(context.character)) {
    const element = analysis.getJsxElementResolutionAt(context.line, character);
    if (element) {
      const definition = await resolveTypeDefinitionAcrossFiles(context, element.resolution.symbol.name);
      const range = definition ? nodeRange(definition.declaration.name) : null;
      if (definition && range) {
        return { uri: pathToUri(definition.filePath), range };
      }
    }

    const attribute = analysis.getJsxAttributeResolutionAt(context.line, character);
    const ownerTypeName = attribute?.resolution.ownerTypeName;
    if (attribute && ownerTypeName) {
      const definition = await resolveNodeModulesMemberDefinition(
        context,
        ownerTypeName,
        attribute.resolution.attribute.name
      );
      if (definition) {
        return definition;
      }
    }
  }
  return null;
}

function containsStructuralObjectType(type: AnalysisType): boolean {
  if (type instanceof ObjectType) {
    return true;
  }
  if (type instanceof IntersectionType || type instanceof UnionType) {
    return type.types.some((member) => containsStructuralObjectType(member));
  }
  return false;
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
  const typeAliasContents = createTypeAliasHoverContents(context.session.ast ?? undefined, identifier.name, typeLabel);
  if (typeAliasContents) {
    return {
      contents: typeAliasContents,
      range
    };
  }
  const importBinding = context.session.ast
    ? findImportForSymbolNode(context.session.ast, symbol.node)
    : null;
  const importedDeclaration = importBinding
    ? context.session.importedSymbols?.get(importBinding.localName)?.declarationOrigin?.statement
    : undefined;
  if (importedDeclaration?.kind === NodeKind.TypeAliasStatement) {
    return {
      contents: createTypeAliasHoverContentsFromDeclaration(
        importedDeclaration as TypeAliasStatement,
        identifier.name,
        typeLabel
      ),
      range
    };
  }
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
          value: `${typeDefinition.declaration instanceof ClassStatement ? "class" : "interface"} ${typeIdentifier.name}`
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
    if (type instanceof ArrayType) {
      push("Array");
      return;
    }
    if ((type instanceof NamedType || type instanceof BuiltinType) && type.name === "int") {
      push("int");
      push("number");
      return;
    }
    if (type instanceof NamedType || type instanceof BuiltinType) {
      push(type.name);
      return;
    }
    if (type instanceof UnionType || type instanceof IntersectionType) {
      for (const memberType of type.types) {
        visit(memberType);
      }
    }
  };

  visit(objectType);
  return names;
}

interface JsonMemberAccess {
  receiverName: string;
  propertyPath: string[];
}

function jsonMemberAccess(memberExpression: MemberExpression): JsonMemberAccess | null {
  const propertyPath: string[] = [];
  let current: unknown = memberExpression;
  while (current instanceof MemberExpression) {
    if (current.computed || !(current.property instanceof Identifier)) {
      return null;
    }
    propertyPath.unshift(current.property.name);
    current = current.object;
  }
  return current instanceof Identifier && propertyPath.length > 0
    ? { receiverName: current.name, propertyPath }
    : null;
}

function jsonWhitespace(source: string, offset: number): number {
  while (/\s/.test(source[offset] ?? "")) {
    offset += 1;
  }
  return offset;
}

function jsonStringEnd(source: string, offset: number): number {
  let escaped = false;
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      return index + 1;
    }
  }
  return source.length;
}

function jsonPosition(source: string, offset: number): { line: number; character: number } {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return {
    line: source.slice(0, offset).split("\n").length - 1,
    character: offset - lineStart
  };
}

function findJsonPropertyRange(source: string, targetPath: readonly string[]): Location["range"] | null {
  try {
    JSON.parse(source);
  } catch {
    return null;
  }

  let found: Location["range"] | null = null;
  const scanValue = (initialOffset: number, path: readonly string[]): number => {
    const offset = jsonWhitespace(source, initialOffset);
    const character = source[offset];
    if (character === "\"") {
      return jsonStringEnd(source, offset);
    }
    if (character === "{") {
      let next = jsonWhitespace(source, offset + 1);
      while (source[next] !== "}" && next < source.length) {
        next = jsonWhitespace(source, next);
        const keyStart = next;
        const keyEnd = jsonStringEnd(source, keyStart);
        let key: string;
        try {
          key = JSON.parse(source.slice(keyStart, keyEnd)) as string;
        } catch {
          return source.length;
        }
        next = jsonWhitespace(source, keyEnd);
        if (source[next] !== ":") {
          return source.length;
        }
        next = jsonWhitespace(source, next + 1);
        const memberPath = [...path, key];
        if (!found && memberPath.length === targetPath.length && memberPath.every((part, index) => part === targetPath[index])) {
          found = {
            start: jsonPosition(source, keyStart + 1),
            end: jsonPosition(source, keyEnd - 1)
          };
        }
        next = scanValue(next, memberPath);
        next = jsonWhitespace(source, next);
        if (source[next] === ",") {
          next += 1;
        }
      }
      return next + 1;
    }
    if (character === "[") {
      let next = jsonWhitespace(source, offset + 1);
      while (source[next] !== "]" && next < source.length) {
        next = scanValue(next, path);
        next = jsonWhitespace(source, next);
        if (source[next] === ",") {
          next += 1;
        }
      }
      return next + 1;
    }
    let next = offset;
    while (next < source.length && !",]}".includes(source[next] ?? "")) {
      next += 1;
    }
    return next;
  };

  scanValue(0, []);
  return found;
}

async function resolveJsonMemberDefinition(
  context: ResolveContext,
  memberExpression: MemberExpression
): Promise<Location | null> {
  if (!context.session.ast) {
    return null;
  }
  const access = jsonMemberAccess(memberExpression);
  const currentFilePath = uriToFilePath(context.uri);
  if (!access || !currentFilePath) {
    return null;
  }
  const importBinding = findImportBindingByLocalName(context.session.ast.body, access.receiverName);
  if (!importBinding || (importBinding.kind !== "default" && importBinding.kind !== "namespace")) {
    return null;
  }
  const targetFilePath = await resolveImportTargetFilePath(currentFilePath, importBinding.from, {
    vfs: context.vfs,
    importMappings: context.importMappings
  });
  if (!targetFilePath || extname(targetFilePath).toLowerCase() !== ".json") {
    return null;
  }
  const source = await readTextDocument(context, targetFilePath);
  const range = source ? findJsonPropertyRange(source, access.propertyPath) : null;
  return range
    ? { uri: pathToUri(targetFilePath), range }
    : null;
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
  if (!memberExpression || !(memberExpression.property instanceof Identifier)) {
    return null;
  }

  const jsonDefinition = await resolveJsonMemberDefinition(context, memberExpression);
  if (jsonDefinition) {
    return jsonDefinition;
  }

  const objectType = context.session.analysis.getExpressionType(memberExpression.object);
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
    memberExpression.object instanceof Identifier
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
    memberExpression.object instanceof Identifier
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

  if (containsStructuralObjectType(objectType)) {
    const structuralDefinition = await resolveNodeModulesStructuralMemberDefinition(context, memberName);
    if (structuralDefinition) {
      return structuralDefinition;
    }
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

  const jsxDefinition = await resolveJsxDefinition(context);
  if (jsxDefinition) {
    return jsxDefinition;
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
  const openingTagTarget = context.session.analysis?.getJsxOpeningTagTargetAt(
    context.line,
    context.character
  );
  if (openingTagTarget) {
    return resolveDefinitionWithLocalFallback({
      ...context,
      line: openingTagTarget.position.line,
      character: openingTagTarget.position.character
    });
  }

  const crossFile = await resolveDefinitionAcrossFiles(context);
  if (crossFile) {
    return crossFile;
  }
  if (!context.session.analysis) {
    return null;
  }
  return createDefinitionLocation(
    context.session.analysis,
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
  const openingTagTarget = context.session.analysis?.getJsxOpeningTagTargetAt(
    context.line,
    context.character
  );
  if (openingTagTarget) {
    const openingHover = await resolveHoverWithLocalFallback({
      ...context,
      line: openingTagTarget.position.line,
      character: openingTagTarget.position.character
    });
    return openingHover
      ? { ...openingHover, range: openingTagTarget.closingRange }
      : null;
  }

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
