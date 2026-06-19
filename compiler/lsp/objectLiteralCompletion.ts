import type {
  CompletionItem
} from "vscode-languageserver/node.js";
import type { Hover } from "vscode-languageserver/node.js";
import type { Location } from "vscode-languageserver/node.js";
import type {
  EnumStatement,
  FloatLiteral,
  Identifier,
  ImportStatement,
  IntLiteral,
  Expr,
  ObjectLiteral,
  ObjectProperty,
  Program,
  StringLiteral
} from "compiler/ast/ast";
import { typeToString } from "compiler/analysis/types";
import { baseTypeName, findMatchingTypeDelimiter, findTopLevelTypeCharacter, parseTypeNameShape, splitTopLevelDelimitedTypeText, splitTopLevelTypeText, stripEnclosingTypeParens } from "compiler/analysis/typeNames";
import { Analysis } from "compiler/analysis/Analysis";
import { walkAst } from "compiler/ast/traversal";
import {
  createClassResolverCache,
  type ResolvedFunctionSignature,
  resolveCallableSignature,
  resolveClassMemberDeclaration,
  resolveClassMember,
  resolveClassMemberNames,
  resolveClassStatementAcrossFiles,
  resolveConstructorSignature,
  resolveInterfaceMemberDeclaration,
  resolveInterfaceMember,
  resolveInterfaceMemberNames,
  resolveInterfaceStatementAcrossFiles
} from "./classResolver";
import type { CompletionRequestOptions } from "./completionModel";
import { CompletionCommand, CompletionItemKind, classResolverOptionsFromCompletionOptions } from "./completionModel";
import type { ResolveContext } from "./crossFileContext";
import { resolveDeclaredMemberDefinitionAcrossFiles } from "./crossFileDeclaredMemberDefinition";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { findArgumentCompletionContext } from "./argumentCompletion";
import { pathToUri, uriToFilePath } from "./importFixes";
import {
  classMemberDeclarationRangeByName,
  fallbackInterfaceMemberRangeInFile,
  fallbackTypeAliasMemberRangeInFile,
  resolveTypeAliasDefinitionAcrossFiles
} from "./crossFileTypeResolution";
import { formatFunctionTypeLabel } from "./functionTypeDisplay";
import { containsPosition, nodeRange } from "./ranges";
import { fileURLToPath } from "compiler/utils/path";
import { findNodeModuleMemberLocation, findNodeModuleStructuralMemberLocation } from "./nodeModulesTypings";

interface ObjectLiteralCompletionContext {
  kind: "call" | "new";
  callee: Expr;
  argumentIndex: number;
  objectLiteral: ObjectLiteral;
  usedPropertyNames: Set<string>;
}

interface ObjectLiteralPropertyDefinitionContext {
  completionContext: ObjectLiteralCompletionContext;
  propertyName: string;
}

interface ObjectLiteralPropertyValueContext {
  completionContext: ObjectLiteralCompletionContext;
  propertyName: string;
}

interface ObjectLiteralMemberInfo {
  name: string;
  typeName: string;
}

interface ResolvedObjectLiteralShape {
  members: ObjectLiteralMemberInfo[];
  allowsAdditionalProperties: boolean;
}

interface ObjectLiteralValueCandidate {
  label: string;
  insertText: string;
  detail: string;
  kind: CompletionItemKind;
}

function formatResolvedFunctionSignature(signature: ResolvedFunctionSignature): string {
  return formatFunctionTypeLabel(signature.parameters, signature.returnTypeName);
}

function staticObjectPropertyName(property: ObjectProperty): string | null {
  if (property.computed) {
    return null;
  }
  if (property.key.kind === "Identifier") {
    return (property.key as Identifier).name;
  }
  if (property.key.kind === "StringLiteral") {
    return (property.key as StringLiteral).value;
  }
  if (property.key.kind === "IntLiteral" || property.key.kind === "FloatLiteral") {
    return String((property.key as IntLiteral | FloatLiteral).value);
  }
  return null;
}

function findObjectLiteralCompletionContext(
  ast: Program,
  line: number,
  character: number
): ObjectLiteralCompletionContext | null {
  const baseContext = findInnermostObjectLiteralCompletionContext(ast, line, character);
  if (!baseContext) {
    return null;
  }

  const { argumentContext, objectLiteral, position } = baseContext;
  const usedPropertyNames = new Set<string>();
  let activePropertyName: string | null = null;
  for (const property of objectLiteral.properties) {
    if (property.kind !== "ObjectProperty") {
      continue;
    }
    const objectProperty = property as ObjectProperty;
    const propertyName = staticObjectPropertyName(objectProperty);
    const keyRange = nodeRange(objectProperty.key);
    const valueRange = nodeRange(objectProperty.value);
    const cursorInKey = keyRange ? containsPosition(keyRange, position) : false;
    const cursorInValue = valueRange ? containsPosition(valueRange, position) : false;
    if (cursorInValue && !cursorInKey) {
      return null;
    }
    if (cursorInKey && propertyName) {
      activePropertyName = propertyName;
    }
    if (propertyName) {
      usedPropertyNames.add(propertyName);
    }
  }

  if (activePropertyName) {
    usedPropertyNames.delete(activePropertyName);
  }

  return {
    kind: argumentContext.kind,
    callee: argumentContext.callee,
    argumentIndex: argumentContext.argumentIndex,
    objectLiteral,
    usedPropertyNames
  };
}

function findInnermostObjectLiteralCompletionContext(
  ast: Program,
  line: number,
  character: number
): {
  argumentContext: NonNullable<ReturnType<typeof findArgumentCompletionContext>>;
  objectLiteral: ObjectLiteral;
  position: { line: number; character: number };
} | null {
  const argumentContext = findArgumentCompletionContext(ast, line, character);
  if (!argumentContext) {
    return null;
  }

  const position = { line, character };
  let best: ObjectLiteral | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  walkAst(ast, (node) => {
    if (node.kind === "ObjectLiteral") {
      const objectLiteral = node as ObjectLiteral;
      const range = nodeRange(objectLiteral);
      if (range && containsPosition(range, position)) {
        const size =
          (range.end.line - range.start.line) * 100000 +
          (range.end.character - range.start.character);
        if (size <= bestSize) {
          best = objectLiteral;
          bestSize = size;
        }
      }
    }
  });

  const objectLiteral = best as ObjectLiteral | null;
  return objectLiteral ? { argumentContext, objectLiteral, position } : null;
}

function findContextualObjectLiteralPropertyDefinitionContext(
  ast: Program,
  line: number,
  character: number
): ObjectLiteralPropertyDefinitionContext | null {
  const completionContext = findObjectLiteralCompletionContext(ast, line, character);
  if (!completionContext) {
    return null;
  }

  const position = { line, character };
  for (const property of completionContext.objectLiteral.properties) {
    if (property.kind !== "ObjectProperty") {
      continue;
    }
    const objectProperty = property as ObjectProperty;
    const propertyName = staticObjectPropertyName(objectProperty);
    const keyRange = nodeRange(objectProperty.key);
    if (propertyName && keyRange && containsPosition(keyRange, position)) {
      return {
        completionContext,
        propertyName
      };
    }
  }

  return null;
}

function positionToOffset(text: string, line: number, character: number): number {
  if (line <= 0) {
    return Math.max(0, Math.min(character, text.length));
  }
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line && offset < text.length) {
    const newlineIndex = text.indexOf("\n", offset);
    if (newlineIndex < 0) {
      return text.length;
    }
    offset = newlineIndex + 1;
    currentLine += 1;
  }
  return Math.max(0, Math.min(offset + character, text.length));
}

function cursorLooksLikeMissingObjectPropertyValue(
  text: string,
  property: ObjectProperty,
  line: number,
  character: number
): boolean {
  const propertyRange = nodeRange(property);
  const keyRange = nodeRange(property.key);
  if (!propertyRange || !keyRange) {
    return false;
  }

  const cursorOffset = positionToOffset(text, line, character);
  const keyEndOffset = positionToOffset(text, keyRange.end.line, keyRange.end.character);
  const propertyEndOffset = positionToOffset(text, propertyRange.end.line, propertyRange.end.character);
  if (cursorOffset < keyEndOffset || cursorOffset > propertyEndOffset) {
    return false;
  }

  const betweenKeyAndCursor = text.slice(keyEndOffset, cursorOffset);
  return betweenKeyAndCursor.includes(":") && /^[\s:]*$/u.test(betweenKeyAndCursor);
}

function findContextualObjectLiteralPropertyValueContext(
  ast: Program,
  line: number,
  character: number,
  text: string | undefined
): ObjectLiteralPropertyValueContext | null {
  const position = { line, character };
  const baseContext = findInnermostObjectLiteralCompletionContext(ast, line, character)
    ?? findInnermostObjectLiteralCompletionContext(ast, line, Math.max(0, character - 1));
  if (!baseContext) {
    return null;
  }
  const completionContext: ObjectLiteralCompletionContext = {
    kind: baseContext.argumentContext.kind,
    callee: baseContext.argumentContext.callee,
    argumentIndex: baseContext.argumentContext.argumentIndex,
    objectLiteral: baseContext.objectLiteral,
    usedPropertyNames: new Set<string>()
  };

  for (const property of completionContext.objectLiteral.properties) {
    if (property.kind !== "ObjectProperty") {
      continue;
    }
    const objectProperty = property as ObjectProperty;
    const propertyName = staticObjectPropertyName(objectProperty);
    const keyRange = nodeRange(objectProperty.key);
    const valueRange = nodeRange(objectProperty.value);
    const cursorInKey = keyRange ? containsPosition(keyRange, position) : false;
    const cursorInValue = valueRange ? containsPosition(valueRange, position) : false;
    if (propertyName && cursorInValue && !cursorInKey) {
      return {
        completionContext,
        propertyName
      };
    }
    if (propertyName && text && cursorLooksLikeMissingObjectPropertyValue(text, objectProperty, line, character)) {
      return {
        completionContext,
        propertyName
      };
    }
  }

  return null;
}

function parseObjectTypeMembers(typeName: string): ResolvedObjectLiteralShape | null {
  const trimmed = stripEnclosingTypeParens(typeName);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) {
    return { members: [], allowsAdditionalProperties: false };
  }

  const members: ObjectLiteralMemberInfo[] = [];
  let allowsAdditionalProperties = false;
  for (const part of splitTopLevelDelimitedTypeText(body, new Set([",", ";"]))) {
    const trimmedPart = part.trim();
    if (trimmedPart.length === 0) {
      continue;
    }
    if (trimmedPart.startsWith("[") || trimmedPart.startsWith("readonly [")) {
      allowsAdditionalProperties = true;
      continue;
    }

    const colonIndex = findTopLevelTypeCharacter(trimmedPart, ":");
    const signatureParenIndex = trimmedPart.indexOf("(");
    if (signatureParenIndex > 0 && (colonIndex < 0 || signatureParenIndex < colonIndex)) {
      const closeParenIndex = findMatchingTypeDelimiter(trimmedPart, signatureParenIndex, "(", ")");
      if (closeParenIndex >= 0) {
        const returnTypeSeparator = trimmedPart.slice(closeParenIndex + 1).trimStart();
        if (returnTypeSeparator.startsWith(":")) {
          let name = trimmedPart.slice(0, signatureParenIndex).trim();
          if (name.startsWith("readonly ")) {
            name = name.slice("readonly ".length).trim();
          }
          if (name.endsWith("?")) {
            name = name.slice(0, -1).trim();
          }
          const parameterText = trimmedPart.slice(signatureParenIndex, closeParenIndex + 1);
          const returnTypeName = returnTypeSeparator.slice(1).trim();
          members.push({ name, typeName: `${parameterText} => ${returnTypeName}` });
          continue;
        }
      }
    }

    if (colonIndex < 0) {
      continue;
    }

    let name = trimmedPart.slice(0, colonIndex).trim();
    const propertyType = trimmedPart.slice(colonIndex + 1).trim();
    if (name.startsWith("readonly ")) {
      name = name.slice("readonly ".length).trim();
    }
    if (name.endsWith("?")) {
      name = name.slice(0, -1).trim();
    }
    if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1);
    }
    members.push({ name, typeName: propertyType || "unknown" });
  }

  return { members, allowsAdditionalProperties };
}

function mergeObjectLiteralShapes(shapes: ResolvedObjectLiteralShape[]): ResolvedObjectLiteralShape {
  const members = new Map<string, ObjectLiteralMemberInfo>();
  let allowsAdditionalProperties = false;
  for (const shape of shapes) {
    allowsAdditionalProperties ||= shape.allowsAdditionalProperties;
    for (const member of shape.members) {
      if (!members.has(member.name)) {
        members.set(member.name, member);
      }
    }
  }
  return {
    members: [...members.values()].sort((left, right) => left.name.localeCompare(right.name)),
    allowsAdditionalProperties
  };
}

async function resolveObjectLiteralShape(
  typeName: string,
  ast: Program,
  analysis: Analysis,
  options: CompletionRequestOptions,
  cache = createClassResolverCache(),
  visited = new Set<string>()
): Promise<ResolvedObjectLiteralShape | null> {
  const trimmed = stripEnclosingTypeParens(typeName);
  if (trimmed.length === 0) {
    return null;
  }
  if (visited.has(trimmed)) {
    return null;
  }
  visited.add(trimmed);

  if (trimmed === "any" || trimmed === "unknown" || trimmed === "object") {
    return { members: [], allowsAdditionalProperties: true };
  }

  const unionMembers = splitTopLevelTypeText(trimmed, "|");
  if (unionMembers.length > 1) {
    const shapes = (await Promise.all(
      unionMembers.map((member) => resolveObjectLiteralShape(member, ast, analysis, options, cache, visited))
    )).filter((shape): shape is ResolvedObjectLiteralShape => shape !== null);
    return shapes.length > 0 ? mergeObjectLiteralShapes(shapes) : null;
  }

  const intersectionMembers = splitTopLevelTypeText(trimmed, "&");
  if (intersectionMembers.length > 1) {
    const shapes = (await Promise.all(
      intersectionMembers.map((member) => resolveObjectLiteralShape(member, ast, analysis, options, cache, visited))
    )).filter((shape): shape is ResolvedObjectLiteralShape => shape !== null);
    return shapes.length > 0 ? mergeObjectLiteralShapes(shapes) : null;
  }

  const objectShape = parseObjectTypeMembers(trimmed);
  if (objectShape) {
    return objectShape;
  }

  const parsedType = parseTypeNameShape(trimmed);
  if (
    (parsedType.baseName === "Partial" || parsedType.baseName === "Readonly" || parsedType.baseName === "Required")
    && parsedType.typeArguments.length === 1
  ) {
    return resolveObjectLiteralShape(parsedType.typeArguments[0]!, ast, analysis, options, cache, visited);
  }

  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
    ast,
    baseTypeName(trimmed),
    resolverOptions,
    cache
  );
  if (interfaceResolution) {
    const names = await resolveInterfaceMemberNames(interfaceResolution.interfaceStatement, trimmed, {
      ast,
      analysis,
      options: resolverOptions,
      cache
    });
    const members: ObjectLiteralMemberInfo[] = [];
    for (const name of names) {
      const member = await resolveInterfaceMember(interfaceResolution.interfaceStatement, name, trimmed, {
        ast,
        analysis,
        options: resolverOptions,
        cache
      });
      members.push({
        name,
        typeName: member?.signature
          ? formatResolvedFunctionSignature(member.signature)
          : member?.typeName ?? "unknown"
      });
    }
    return { members: members.sort((left, right) => left.name.localeCompare(right.name)), allowsAdditionalProperties: false };
  }

  const classResolution = await resolveClassStatementAcrossFiles(
    ast,
    baseTypeName(trimmed),
    resolverOptions,
    cache
  );
  if (classResolution) {
    const names = await resolveClassMemberNames(classResolution.classStatement, trimmed, {
      ast,
      analysis,
      options: resolverOptions,
      cache
    });
    const members: ObjectLiteralMemberInfo[] = [];
    for (const name of names) {
      const member = await resolveClassMember(classResolution.classStatement, name, trimmed, {
        ast,
        analysis,
        options: resolverOptions,
        cache
      });
      members.push({
        name,
        typeName: member?.signature
          ? formatResolvedFunctionSignature(member.signature)
          : member?.typeName ?? "unknown"
      });
    }
    return { members: members.sort((left, right) => left.name.localeCompare(right.name)), allowsAdditionalProperties: false };
  }

  return null;
}

async function resolveExpectedArgumentTypeName(
  ast: Program,
  analysis: Analysis,
  context: ObjectLiteralCompletionContext,
  options: CompletionRequestOptions,
  preferSelectedResolution = true
): Promise<string | null> {
  const calleeRange = nodeRange(context.callee);
  if (preferSelectedResolution && calleeRange) {
    const selectedResolution = analysis.getSelectedCallResolutionAt(
      calleeRange.start.line,
      calleeRange.start.character
    );
    const selectedParameterType = selectedResolution?.overload.parameters[context.argumentIndex]?.type;
    if (selectedParameterType) {
      return typeToString(selectedParameterType);
    }
  }

  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  if (context.kind === "call") {
    const signature = await resolveCallableSignature(context.callee, analysis, ast, resolverOptions);
    return signature?.parameters[context.argumentIndex]?.typeName ?? null;
  }
  const signature = await resolveConstructorSignature(context.callee, analysis, ast, resolverOptions);
  return signature?.parameters[context.argumentIndex]?.typeName ?? null;
}

function unwrapOptionalTypeText(typeName: string): string {
  const trimmed = typeName.trim();
  if (!trimmed.endsWith("?")) {
    return trimmed;
  }
  return stripEnclosingTypeParens(trimmed.slice(0, -1).trim());
}

function numericLiteralInsertText(value: string): string {
  return /^-?\d+$/u.test(value) ? value : String(Number(value));
}

function literalCandidateFromTypeText(typeName: string): ObjectLiteralValueCandidate | null {
  const trimmed = stripEnclosingTypeParens(typeName.trim());
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const value = trimmed.slice(1, -1);
    return {
      label: value,
      insertText: JSON.stringify(value),
      detail: "String literal value",
      kind: CompletionItemKind.Value
    };
  }
  if (trimmed === "true" || trimmed === "false") {
    return {
      label: trimmed,
      insertText: trimmed,
      detail: "Boolean literal value",
      kind: CompletionItemKind.Value
    };
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    return {
      label: trimmed,
      insertText: numericLiteralInsertText(trimmed),
      detail: "Numeric literal value",
      kind: CompletionItemKind.Value
    };
  }
  return null;
}

async function enumValueCandidatesFromTypeText(
  typeName: string,
  ast: Program,
  options: CompletionRequestOptions
): Promise<ObjectLiteralValueCandidate[]> {
  const enumStatement = (await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: baseTypeName(typeName),
    currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
    predicate: (statement): statement is EnumStatement => statement.kind === "EnumStatement",
    includeRuntime: true,
    sourceRoots: options.sourceRoots ?? [],
    ...(options.vfs ? { vfs: options.vfs } : {}),
    ...(options.getSessionForFilePath ? { getSessionForFilePath: options.getSessionForFilePath } : {})
  }))?.declaration;
  if (!enumStatement) {
    return [];
  }

  return enumStatement.members.map((member) => ({
    label: member.name.name,
    insertText: `${enumStatement.name.name}.${member.name.name}`,
    detail: `Enum value: ${enumStatement.name.name}.${member.name.name}`,
    kind: CompletionItemKind.EnumMember
  }));
}

async function collectObjectLiteralValueCandidates(
  typeName: string,
  ast: Program,
  options: CompletionRequestOptions
): Promise<ObjectLiteralValueCandidate[]> {
  const members = splitTopLevelTypeText(unwrapOptionalTypeText(typeName), "|");
  const seen = new Set<string>();
  const candidates: ObjectLiteralValueCandidate[] = [];

  for (const member of members) {
    const trimmed = stripEnclosingTypeParens(member.trim());
    if (trimmed.length === 0 || trimmed === "undefined" || trimmed === "null") {
      continue;
    }
    const literalCandidate = literalCandidateFromTypeText(trimmed);
    if (literalCandidate) {
      const key = `${literalCandidate.kind}:${literalCandidate.insertText}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(literalCandidate);
      }
      continue;
    }
    for (const enumCandidate of await enumValueCandidatesFromTypeText(trimmed, ast, options)) {
      const key = `${enumCandidate.kind}:${enumCandidate.insertText}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(enumCandidate);
      }
    }
  }

  return candidates;
}

async function resolveObjectLiteralPropertyTypeName(
  ast: Program,
  analysis: Analysis,
  context: ObjectLiteralCompletionContext,
  propertyName: string,
  options: CompletionRequestOptions
): Promise<string | null> {
  const expectedType = resolveExpectedArgumentType(analysis, context);
  const expectedTypeName = expectedType
    ? typeToString(expectedType)
    : await resolveExpectedArgumentTypeName(ast, analysis, context, options);
  if (!expectedTypeName) {
    return null;
  }

  const shape = await resolveObjectLiteralShape(expectedTypeName, ast, analysis, options);
  const member = shape?.members.find((candidate) => candidate.name === propertyName);
  return member?.typeName ?? null;
}

function resolveExpectedArgumentType(
  analysis: Analysis,
  context: ObjectLiteralCompletionContext
) {
  const calleeRange = nodeRange(context.callee);
  if (!calleeRange) {
    return null;
  }
  const selectedResolution = analysis.getSelectedCallResolutionAt(
    calleeRange.start.line,
    calleeRange.start.character
  );
  return selectedResolution?.overload.parameters[context.argumentIndex]?.type ?? null;
}

async function resolveImportedNodeModuleObjectLiteralPropertyDefinition(
  context: ResolveContext,
  typeName: string,
  propertyName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  for (const statement of context.session.ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const from = importStatement.from.value;
    if (from.startsWith(".") || from.startsWith("/")) {
      continue;
    }
    const location = await findNodeModuleMemberLocation(
      currentFilePath,
      from,
      typeName,
      propertyName,
      context.vfs ? { vfs: context.vfs } : {}
    );
    if (location) {
      return {
        uri: pathToUri(location.typingsPath),
        range: location.range
      };
    }
  }

  return null;
}

async function resolveImportedNodeModuleStructuralObjectLiteralPropertyDefinition(
  context: ResolveContext,
  propertyName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  for (const statement of context.session.ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const from = importStatement.from.value;
    if (from.startsWith(".") || from.startsWith("/")) {
      continue;
    }
    const location = await findNodeModuleStructuralMemberLocation(
      currentFilePath,
      from,
      propertyName,
      context.vfs ? { vfs: context.vfs } : {}
    );
    if (location) {
      return {
        uri: pathToUri(location.typingsPath),
        range: location.range
      };
    }
  }

  return null;
}

async function resolveDeclaredObjectLiteralPropertyDefinitionFromTypeName(
  context: ResolveContext,
  objectTypeName: string,
  propertyName: string
): Promise<Location | null> {
  const trimmed = stripEnclosingTypeParens(objectTypeName);
  if (trimmed.length === 0 || !context.session.ast || !context.session.analysis) {
    return null;
  }

  const unionMembers = splitTopLevelTypeText(trimmed, "|");
  if (unionMembers.length > 1) {
    for (const member of unionMembers) {
      const resolved = await resolveDeclaredObjectLiteralPropertyDefinitionFromTypeName(context, member, propertyName);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  const intersectionMembers = splitTopLevelTypeText(trimmed, "&");
  if (intersectionMembers.length > 1) {
    for (const member of intersectionMembers) {
      const resolved = await resolveDeclaredObjectLiteralPropertyDefinitionFromTypeName(context, member, propertyName);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return null;
  }

  const parsedType = parseTypeNameShape(trimmed);
  if (
    (parsedType.baseName === "Partial" || parsedType.baseName === "Readonly" || parsedType.baseName === "Required")
    && parsedType.typeArguments.length === 1
  ) {
    return resolveDeclaredObjectLiteralPropertyDefinitionFromTypeName(
      context,
      parsedType.typeArguments[0]!,
      propertyName
    );
  }
  const baseName = baseTypeName(trimmed);
  const resolverCache = createClassResolverCache();
  const resolverOptions = {
    uri: context.uri,
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  };
  const resolverContext = {
    ast: context.session.ast,
    options: resolverOptions,
    analysis: context.session.analysis,
    cache: resolverCache
  };

  const interfaceResolution = await resolveInterfaceStatementAcrossFiles(
    context.session.ast,
    baseName,
    resolverOptions,
    resolverCache
  );
  if (interfaceResolution) {
    if (interfaceResolution.filePath.includes("/node_modules/")) {
      const nodeModuleDefinition = await resolveImportedNodeModuleObjectLiteralPropertyDefinition(
        context,
        baseName,
        propertyName
      );
      if (nodeModuleDefinition) {
        return nodeModuleDefinition;
      }
    }

    const memberDeclaration = await resolveInterfaceMemberDeclaration(
      interfaceResolution,
      propertyName,
      trimmed,
      resolverContext
    );
    if (memberDeclaration) {
      const range = classMemberDeclarationRangeByName(memberDeclaration.declaration, propertyName)
        ?? await fallbackInterfaceMemberRangeInFile(
          context,
          memberDeclaration.filePath,
          memberDeclaration.declaration.name.name,
          propertyName
        );
      if (range) {
        return {
          uri: pathToUri(memberDeclaration.filePath),
          range
        };
      }
    }
  }

  const classResolution = await resolveClassStatementAcrossFiles(
    context.session.ast,
    baseName,
    resolverOptions,
    resolverCache
  );
  if (classResolution) {
    if (classResolution.filePath.includes("/node_modules/")) {
      const nodeModuleDefinition = await resolveImportedNodeModuleObjectLiteralPropertyDefinition(
        context,
        baseName,
        propertyName
      );
      if (nodeModuleDefinition) {
        return nodeModuleDefinition;
      }
    }

    const memberDeclaration = await resolveClassMemberDeclaration(
      classResolution,
      propertyName,
      trimmed,
      resolverContext
    );
    if (memberDeclaration) {
      const range = classMemberDeclarationRangeByName(memberDeclaration.declaration, propertyName)
        ?? (memberDeclaration.declaration.kind === "InterfaceStatement"
          ? await fallbackInterfaceMemberRangeInFile(
            context,
            memberDeclaration.filePath,
            memberDeclaration.declaration.name.name,
            propertyName
          )
          : null);
      if (range) {
        return {
          uri: pathToUri(memberDeclaration.filePath),
          range
        };
      }
    }
  }

  const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, baseName);
  if (typeAliasResolution) {
    const range = await fallbackTypeAliasMemberRangeInFile(
      context,
      typeAliasResolution.filePath,
      typeAliasResolution.declaration.name.name,
      propertyName
    );
    if (range) {
      return {
        uri: pathToUri(typeAliasResolution.filePath),
        range
      };
    }
  }

  for (const typeArgument of parsedType.typeArguments) {
    const resolved = await resolveDeclaredObjectLiteralPropertyDefinitionFromTypeName(context, typeArgument, propertyName);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export async function resolveContextualObjectLiteralPropertyDefinition(
  context: ResolveContext
): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const propertyContext = findContextualObjectLiteralPropertyDefinitionContext(
    context.session.ast,
    context.line,
    context.character
  );
  if (!propertyContext) {
    return null;
  }

  const expectedType = resolveExpectedArgumentType(context.session.analysis, propertyContext.completionContext);
  if (expectedType) {
    const directDefinition = await resolveDeclaredMemberDefinitionAcrossFiles(
      context,
      expectedType,
      propertyContext.propertyName
    );
    if (directDefinition) {
      return directDefinition;
    }
    const structuralShape = parseObjectTypeMembers(typeToString(expectedType));
    if (structuralShape?.members.some((member) => member.name === propertyContext.propertyName)) {
      const structuralDefinition = await resolveImportedNodeModuleStructuralObjectLiteralPropertyDefinition(
        context,
        propertyContext.propertyName
      );
      if (structuralDefinition) {
        return structuralDefinition;
      }
    }
  }

  const expectedTypeName = await resolveExpectedArgumentTypeName(
    context.session.ast,
    context.session.analysis,
    propertyContext.completionContext,
    {
      uri: context.uri,
      sourceRoots: context.sourceRoots,
      ...(context.getSessionForFilePath
        ? { getSessionForFilePath: context.getSessionForFilePath }
        : {})
    },
    false
  );
  if (!expectedTypeName) {
    return null;
  }

  return resolveDeclaredObjectLiteralPropertyDefinitionFromTypeName(
    context,
    expectedTypeName,
    propertyContext.propertyName
  );
}

export async function resolveContextualObjectLiteralPropertyHover(
  context: ResolveContext
): Promise<Hover | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const propertyContext = findContextualObjectLiteralPropertyDefinitionContext(
    context.session.ast,
    context.line,
    context.character
  );
  if (!propertyContext) {
    return null;
  }

  const propertyTypeName = await resolveObjectLiteralPropertyTypeName(
    context.session.ast,
    context.session.analysis,
    propertyContext.completionContext,
    propertyContext.propertyName,
    {
      uri: context.uri,
      sourceRoots: context.sourceRoots,
      ...(context.getSessionForFilePath
        ? { getSessionForFilePath: context.getSessionForFilePath }
        : {})
    }
  );
  if (!propertyTypeName) {
    return null;
  }

  const property = propertyContext.completionContext.objectLiteral.properties.find((candidate) =>
    candidate.kind === "ObjectProperty"
    && staticObjectPropertyName(candidate as ObjectProperty) === propertyContext.propertyName
  ) as ObjectProperty | undefined;
  const keyRange = property ? nodeRange(property.key) : null;

  return {
    contents: {
      kind: "plaintext",
      value: `${propertyContext.propertyName}: ${propertyTypeName}`
    },
    ...(keyRange ? { range: keyRange } : {})
  };
}

export async function buildContextualObjectLiteralCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[]> {
  const context = findObjectLiteralCompletionContext(ast, line, character);
  if (!context) {
    return [];
  }

  const expectedType = resolveExpectedArgumentType(analysis, context);
  const expectedTypeName = expectedType ? typeToString(expectedType) : await resolveExpectedArgumentTypeName(ast, analysis, context, options);
  if (!expectedTypeName) {
    return [];
  }

  const shape = await resolveObjectLiteralShape(expectedTypeName, ast, analysis, options);
  if (!shape || shape.members.length === 0) {
    return [];
  }

  const availableMembers = shape.members
    .filter((member) => !context.usedPropertyNames.has(member.name));

  const memberSuggestions = await Promise.all(availableMembers.map(async (member, index) => {
    const valueCandidates = await collectObjectLiteralValueCandidates(member.typeName, ast, options);
    return {
      label: member.name,
      kind: CompletionItemKind.Field,
      detail: `Object property: ${member.typeName}`,
      insertText: `${member.name}: `,
      sortText: `0-${String(index).padStart(4, "0")}-${member.name}`,
      ...(valueCandidates.length > 0
        ? {
            command: {
              title: "Trigger suggest",
              command: CompletionCommand.TriggerSuggest
            }
          }
        : {})
    };
  }));

  return memberSuggestions;
}

export async function buildContextualObjectLiteralValueCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[]> {
  let propertyContext = findContextualObjectLiteralPropertyValueContext(ast, line, character, options.text);
  let resolvedAst = ast;
  let resolvedAnalysis = analysis;
  let resolvedText = options.text;
  if (!propertyContext && options.text && options.recoverAnalysisSession) {
    const offset = positionToOffset(options.text, line, character);
    const recoveredText = `${options.text.slice(0, offset)}null${options.text.slice(offset)}`;
    const recoveredSession = await options.recoverAnalysisSession(recoveredText);
    if (recoveredSession.ast && recoveredSession.analysis) {
      const recoveredContext = findContextualObjectLiteralPropertyValueContext(
        recoveredSession.ast,
        line,
        character,
        recoveredText
      );
      if (recoveredContext) {
        propertyContext = recoveredContext;
        resolvedAst = recoveredSession.ast;
        resolvedAnalysis = recoveredSession.analysis;
        resolvedText = recoveredText;
      }
    }
  }
  if (!propertyContext) {
    return [];
  }

  const propertyTypeName = await resolveObjectLiteralPropertyTypeName(
    resolvedAst,
    resolvedAnalysis,
    propertyContext.completionContext,
    propertyContext.propertyName,
    {
      ...options,
      ...(resolvedText !== undefined ? { text: resolvedText } : {})
    }
  );
  if (!propertyTypeName) {
    return [];
  }

  const candidates = await collectObjectLiteralValueCandidates(propertyTypeName, resolvedAst, options);
  return candidates.map((candidate, index) => ({
    label: candidate.label,
    kind: candidate.kind,
    detail: `${candidate.detail} for ${propertyContext.propertyName}`,
    insertText: candidate.insertText,
    sortText: `0-${String(index).padStart(4, "0")}-${candidate.label}`
  }));
}
