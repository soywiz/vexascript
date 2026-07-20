import { AnalysisTypeKind } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
import { boxedPrimitiveTypeName, parseTypeNameShape, splitTopLevelTypeText, stripEnclosingTypeParens } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { AnalysisType } from "compiler/analysis/types";
import { COMPLETION_RECOVERY_MEMBER } from "./completionModel";
import type { Analysis } from "compiler/analysis/Analysis";
import type {
  AssignmentExpression,
  CallExpression,
  ChainExpression,
  Expr,
  Identifier,
  MemberExpression,
  Program
} from "compiler/ast/ast";
import { nodeRange, rangeSize } from "./ranges";
import { walkAst } from "compiler/ast/traversal";

export function inferLiteralTypeName(pathSegment: string): string | null {
  if (/^\d+$/.test(pathSegment)) {
    return "int";
  }
  if (/^\d+\.\d+$/.test(pathSegment)) {
    return "number";
  }
  return null;
}

export function nonNullishTypeName(typeName: string | null): string | null {
  if (!typeName) {
    return null;
  }
  const parts = splitTopLevelTypeText(stripEnclosingTypeParens(typeName), "|")
    .map((part) => stripEnclosingTypeParens(part).trim())
    .filter((part) => part.length > 0 && part !== "null" && part !== "undefined");
  if (parts.length === 0) {
    return null;
  }
  return parts[0] ?? null;
}

export function normalizeRecoveredReceiverType(
  type: AnalysisType,
  node: Expr,
  expressionTypes: ReadonlyMap<import("compiler/ast/ast").Node, AnalysisType>
): string {
  if (type.kind === AnalysisTypeKind.Union) {
    const nonNullish = type.types.filter((member) =>
      !(member.kind === AnalysisTypeKind.Builtin && (member.name === "null" || member.name === "undefined"))
    );
    const narrowed = nonNullish.length > 0 ? nonNullish : type.types;
    if (narrowed.length === 1) {
      return normalizeRecoveredReceiverType(narrowed[0]!, node, expressionTypes);
    }
    return narrowed.map((member) => normalizeRecoveredReceiverType(member, node, expressionTypes)).join(" | ");
  }
  if (type.kind === AnalysisTypeKind.Named && node.kind === NodeKind.CallExpression) {
    const calleeType = expressionTypes.get((node as CallExpression).callee);
    const constraint = constraintForRecoveredTypeParameter(calleeType, type.name);
    if (constraint) {
      return typeToString(constraint);
    }
  }
  return typeToString(type);
}

function constraintForRecoveredTypeParameter(
  calleeType: AnalysisType | undefined,
  typeParameterName: string
): AnalysisType | null {
  if (!calleeType) {
    return null;
  }
  if (calleeType.kind === AnalysisTypeKind.Function) {
    return calleeType.typeParameterConstraints?.[typeParameterName] ?? null;
  }
  if (calleeType.kind === AnalysisTypeKind.Union) {
    for (const member of calleeType.types) {
      if (member.kind !== AnalysisTypeKind.Function) {
        continue;
      }
      const constraint = member.typeParameterConstraints?.[typeParameterName];
      if (constraint) {
        return constraint;
      }
    }
  }
  return null;
}

export function receiverTypeNameEndingAt(
  analysis: Analysis,
  line: number,
  character: number
): string | null {
  let best: { node: Expr; type: AnalysisType; size: number } | null = null;
  let nearest: { node: Expr; type: AnalysisType; size: number; distance: number } | null = null;
  for (const [node, type] of analysis.getExpressionTypes()) {
    const range = nodeRange(node);
    if (!range || range.end.line !== line) {
      continue;
    }
    const size = rangeSize(range);
    if (range.end.character === character) {
      if (!best || size > best.size) {
        best = { node: node as Expr, type, size };
      }
      continue;
    }
    if (range.end.character > character) {
      continue;
    }
    const distance = character - range.end.character;
    if (distance > 2) {
      continue;
    }
    if (
      !nearest ||
      distance < nearest.distance ||
      (distance === nearest.distance && size > nearest.size)
    ) {
      nearest = { node: node as Expr, type, size, distance };
    }
  }
  const resolved = best ?? nearest;
  return resolved ? normalizeRecoveredReceiverType(resolved.type, resolved.node, analysis.getExpressionTypes()) : null;
}

function positionIsAtOrBefore(
  left: { line: number; character: number },
  right: { line: number; character: number }
): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}

function positionIsWithinRange(
  line: number,
  character: number,
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
): boolean {
  return (
    positionIsAtOrBefore(range.start, { line, character }) &&
    positionIsAtOrBefore({ line, character }, range.end)
  );
}

export function receiverTypeNameBeforePosition(
  analysis: Analysis,
  line: number,
  character: number
): string | null {
  let best:
    | { node: Expr; type: AnalysisType; size: number; endLine: number; endCharacter: number }
    | null = null;
  for (const [node, type] of analysis.getExpressionTypes()) {
    const range = nodeRange(node);
    if (!range || !positionIsAtOrBefore(range.end, { line, character })) {
      continue;
    }
    const size = rangeSize(range);
    if (
      !best ||
      range.end.line > best.endLine ||
      (range.end.line === best.endLine && range.end.character > best.endCharacter) ||
      (range.end.line === best.endLine && range.end.character === best.endCharacter && size > best.size)
    ) {
      best = {
        node: node as Expr,
        type,
        size,
        endLine: range.end.line,
        endCharacter: range.end.character
      };
    }
  }
  return best ? normalizeRecoveredReceiverType(best.type, best.node, analysis.getExpressionTypes()) : null;
}

function memberAccessReceiverNodeAtPosition(node: Expr, line: number, character: number): Expr | null {
  switch (node.kind) {
    case NodeKind.MemberExpression: {
      const member = node as MemberExpression;
      const propertyRange = nodeRange(member.property);
      if (member.computed || !propertyRange || !positionIsWithinRange(line, character, propertyRange)) {
        return null;
      }
      return member.object as Expr;
    }
    case NodeKind.CallExpression: {
      const call = node as CallExpression;
      if (call.callee.kind !== NodeKind.MemberExpression) {
        return null;
      }
      return memberAccessReceiverNodeAtPosition(call.callee as Expr, line, character);
    }
    case NodeKind.AssignmentExpression: {
      const assignment = node as AssignmentExpression;
      if (assignment.left.kind !== NodeKind.MemberExpression) {
        return null;
      }
      return memberAccessReceiverNodeAtPosition(assignment.left as Expr, line, character);
    }
    case NodeKind.ChainExpression: {
      const chain = node as ChainExpression;
      const operationContainsCursor = chain.operations.some((operation) => {
        const range = nodeRange(operation);
        return range ? positionIsWithinRange(line, character, range) : false;
      });
      return operationContainsCursor ? (chain.receiver as Expr) : null;
    }
    default:
      return null;
  }
}

export function receiverTypeNameFromContainingMemberAccess(
  analysis: Analysis,
  line: number,
  character: number
): string | null {
  let best: { node: Expr; type: AnalysisType; size: number } | null = null;
  for (const [node] of analysis.getExpressionTypes()) {
    const range = nodeRange(node);
    if (!range || !positionIsWithinRange(line, character, range)) {
      continue;
    }
    const receiverNode = memberAccessReceiverNodeAtPosition(node as Expr, line, character);
    if (!receiverNode) {
      continue;
    }
    const receiverType = analysis.getExpressionTypes().get(receiverNode);
    if (!receiverType) {
      continue;
    }
    const size = rangeSize(range);
    if (!best || size < best.size) {
      best = { node: receiverNode, type: receiverType, size };
    }
  }
  return best ? normalizeRecoveredReceiverType(best.type, best.node, analysis.getExpressionTypes()) : null;
}

export function recoveredReceiverTypeName(
  ast: Program,
  analysis: Analysis
): string | null {
  let recovered: { node: Expr; type: AnalysisType; size: number } | undefined;

  walkAst(ast, (node) => {
    if (node.kind !== NodeKind.MemberExpression) {
      return;
    }
    const member = node as MemberExpression;
    if (
      member.computed ||
      member.property.kind !== NodeKind.Identifier ||
      !(member.property as Identifier).name.includes(COMPLETION_RECOVERY_MEMBER)
    ) {
      return;
    }
    const objectType = analysis.getExpressionTypes().get(member.object);
    if (!objectType) {
      return;
    }
    const range = nodeRange(member.object);
    const size = range ? rangeSize(range) : 0;
    if (!recovered || size >= recovered.size) {
      recovered = { node: member.object as Expr, type: objectType, size };
    }
  });

  if (recovered === undefined) {
    return null;
  }
  return normalizeRecoveredReceiverType(recovered.type, recovered.node, analysis.getExpressionTypes());
}

export function arrayTypeNameToArrayAlias(typeName: string): string | null {
  const shape = parseTypeNameShape(typeName);
  if (shape.arrayDepth <= 0) {
    return null;
  }
  let elementType =
    shape.typeArguments.length > 0
      ? `${shape.baseName}<${shape.typeArguments.join(", ")}>`
      : shape.baseName;
  for (let depth = 0; depth < shape.arrayDepth - 1; depth += 1) {
    elementType += "[]";
  }
  return `Array<${elementType}>`;
}

export function boxedCompletionTypeName(typeName: string): string {
  return boxedPrimitiveTypeName(nonNullishTypeName(typeName) ?? typeName);
}
