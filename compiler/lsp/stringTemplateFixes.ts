import { NodeKind } from "compiler/ast/ast";
import type {
  BinaryExpression,
  Expr,
  Program,
  StringLiteral
} from "compiler/ast/ast";
import { type CodeAction, type Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { nodeRange, type Position } from "./ranges";
import { findNodeAtPosition } from "./nodeSearch";

function editRange(node: Parameters<typeof nodeRange>[0]): Range | null {
  return nodeRange(node);
}

function escapeTemplateText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function sourceText(text: string, node: Expr): string | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return text.slice(node.firstToken.range.start.offset, node.lastToken.range.end.offset);
}

function flattenConcatenation(expression: Expr): Expr[] | null {
  if (expression.kind !== NodeKind.BinaryExpression) {
    return null;
  }
  const binary = expression as BinaryExpression;
  if (binary.operator !== "+") {
    return null;
  }

  const left = flattenConcatenation(binary.left);
  const right = flattenConcatenation(binary.right);
  return [...(left ?? [binary.left]), ...(right ?? [binary.right])];
}

function buildTemplateLiteral(text: string, expression: BinaryExpression): string | null {
  const segments = flattenConcatenation(expression);
  if (!segments || segments.length < 2) {
    return null;
  }

  let hasStringLiteral = false;
  let hasInterpolation = false;
  let result = "`";

  for (const segment of segments) {
    if (segment.kind === NodeKind.StringLiteral) {
      hasStringLiteral = true;
      result += escapeTemplateText((segment as StringLiteral).value);
      continue;
    }

    const segmentText = sourceText(text, segment);
    if (!segmentText) {
      return null;
    }
    hasInterpolation = true;
    result += `\${${segmentText}}`;
  }

  if (!hasStringLiteral || !hasInterpolation) {
    return null;
  }

  result += "`";
  return result;
}

function isTemplateConvertibleConcatenation(node: import("compiler/ast/ast").Node): node is BinaryExpression {
  if (node.kind !== NodeKind.BinaryExpression) {
    return false;
  }
  const expression = node as BinaryExpression;
  if (expression.operator !== "+") {
    return false;
  }
  const segments = flattenConcatenation(expression);
  if (!segments || segments.length < 2) {
    return false;
  }
  const hasStringLiteral = segments.some((segment) => segment.kind === NodeKind.StringLiteral);
  const hasInterpolation = segments.some((segment) => segment.kind !== NodeKind.StringLiteral);
  return hasStringLiteral && hasInterpolation;
}

function findConcatenationAtPosition(ast: Program, position: Position): BinaryExpression | null {
  return findNodeAtPosition(ast, position, isTemplateConvertibleConcatenation, "largest");
}

export function createStringTemplateCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
}): CodeAction[] {
  const { uri, ast, text, position } = params;
  if (!ast) {
    return [];
  }

  const expression = findConcatenationAtPosition(ast, position);
  if (!expression) {
    return [];
  }

  const newText = buildTemplateLiteral(text, expression);
  const range = editRange(expression);
  if (!newText || !range) {
    return [];
  }

  return [
    {
      title: "Convert string concatenation to template literal",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            {
              range,
              newText
            }
          ]
        }
      }
    }
  ];
}
