import type {
  CompletionItem
} from "vscode-languageserver/node.js";
import type {
  FloatLiteral,
  Identifier,
  IntLiteral,
  Expr,
  ObjectLiteral,
  ObjectProperty,
  Program,
  StringLiteral
} from "compiler/ast/ast";
import { typeToString } from "compiler/analysis/types";
import { baseTypeName, findMatchingTypeDelimiter, findTopLevelTypeCharacter, splitTopLevelDelimitedTypeText, splitTopLevelTypeText, stripEnclosingTypeParens } from "compiler/analysis/typeNames";
import { Analysis } from "compiler/analysis/Analysis";
import { walkAst } from "compiler/ast/traversal";
import {
  createClassResolverCache,
  type ResolvedFunctionSignature,
  resolveCallableSignature,
  resolveClassMember,
  resolveClassMemberNames,
  resolveClassStatementAcrossFiles,
  resolveConstructorSignature,
  resolveInterfaceMember,
  resolveInterfaceMemberNames,
  resolveInterfaceStatementAcrossFiles
} from "./classResolver";
import type { CompletionRequestOptions } from "./completionModel";
import { CompletionItemKind, classResolverOptionsFromCompletionOptions } from "./completionModel";
import { findArgumentCompletionContext } from "./argumentCompletion";
import { containsPosition, nodeRange } from "./ranges";

interface ObjectLiteralCompletionContext {
  kind: "call" | "new";
  callee: Expr;
  argumentIndex: number;
  objectLiteral: ObjectLiteral;
  usedPropertyNames: Set<string>;
}

interface ObjectLiteralMemberInfo {
  name: string;
  typeName: string;
}

interface ResolvedObjectLiteralShape {
  members: ObjectLiteralMemberInfo[];
  allowsAdditionalProperties: boolean;
}

function formatResolvedFunctionSignature(signature: ResolvedFunctionSignature): string {
  const parameters = signature.parameters
    .map((parameter) => {
      const optionalSuffix = parameter.optional ? "?" : "";
      const restPrefix = parameter.rest ? "..." : "";
      return `${restPrefix}${parameter.name}${optionalSuffix}: ${parameter.typeName}`;
    })
    .join(", ");
  return `(${parameters}) => ${signature.returnTypeName}`;
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
  const argumentContext = findArgumentCompletionContext(ast, line, character);
  if (!argumentContext) {
    return null;
  }

  const position = { line, character };
  let best: ObjectLiteral | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  const expressionRange = nodeRange(argumentContext.callee);
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
  if (!objectLiteral || !expressionRange) {
    return null;
  }

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
  options: CompletionRequestOptions
): Promise<string | null> {
  const calleeRange = nodeRange(context.callee);
  if (calleeRange) {
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

  const expectedTypeName = await resolveExpectedArgumentTypeName(ast, analysis, context, options);
  if (!expectedTypeName) {
    return [];
  }

  const shape = await resolveObjectLiteralShape(expectedTypeName, ast, analysis, options);
  if (!shape || shape.members.length === 0) {
    return [];
  }

  return shape.members
    .filter((member) => !context.usedPropertyNames.has(member.name))
    .map((member, index) => ({
      label: member.name,
      kind: CompletionItemKind.Field,
      detail: `Object property: ${member.typeName}`,
      insertText: `${member.name}: `,
      sortText: `0-${String(index).padStart(4, "0")}-${member.name}`
    }));
}
