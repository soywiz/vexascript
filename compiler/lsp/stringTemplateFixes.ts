import { BinaryExpression, Identifier, StringLiteral } from "compiler/ast/ast";
import type { Expr, Program } from "compiler/ast/ast";

import { type CodeAction, type Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { nodeRange, offsetToPosition, positionToOffset, type Position } from "./ranges";
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
  if (!(expression instanceof BinaryExpression)) {
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
    if (segment instanceof StringLiteral) {
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
  if (!(node instanceof BinaryExpression)) {
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
  const hasStringLiteral = segments.some((segment) => segment instanceof StringLiteral);
  const hasInterpolation = segments.some((segment) => !(segment instanceof StringLiteral));
  return hasStringLiteral && hasInterpolation;
}

function findConcatenationAtPosition(ast: Program, position: Position): BinaryExpression | null {
  return findNodeAtPosition(ast, position, isTemplateConvertibleConcatenation, "largest");
}

function isSourceTemplate(text: string, expression: BinaryExpression): boolean {
  const firstOffset = expression.firstToken?.range.start.offset;
  const lastOffset = expression.lastToken?.range.end.offset;
  return firstOffset !== undefined
    && lastOffset !== undefined
    && text[firstOffset - 1] === "`"
    && text[lastOffset] === "`";
}

function supportsShorthandTemplates(uri: string): boolean {
  const path = uri.split(/[?#]/u, 1)[0]?.toLowerCase() ?? uri.toLowerCase();
  return !/\.[cm]?[jt]sx?$/u.test(path);
}

function interpolationToggle(
  text: string,
  expression: BinaryExpression,
  position: Position
): { title: string; range: Range; newText: string } | null {
  const segments = flattenConcatenation(expression);
  if (!segments) {
    return null;
  }

  const cursorOffset = positionToOffset(text, position);
  for (const segment of segments) {
    if (!(segment instanceof Identifier) || !segment.firstToken || !segment.lastToken) {
      continue;
    }

    const identifierStart = segment.firstToken.range.start.offset;
    const identifierEnd = segment.lastToken.range.end.offset;
    let interpolationStart = identifierStart - 1;
    let interpolationEnd = identifierEnd;
    let title = "Add braces to template interpolation";
    let newText = `\${${segment.name}}`;

    if (text[interpolationStart] !== "$") {
      let openBrace = interpolationStart;
      while (openBrace >= 0 && /\s/.test(text[openBrace] ?? "")) {
        openBrace -= 1;
      }
      if (text[openBrace] !== "{" || text[openBrace - 1] !== "$") {
        continue;
      }

      let closeBrace = identifierEnd;
      while (closeBrace < text.length && /\s/.test(text[closeBrace] ?? "")) {
        closeBrace += 1;
      }
      if (text[closeBrace] !== "}") {
        continue;
      }

      interpolationStart = openBrace - 1;
      interpolationEnd = closeBrace + 1;
      title = "Remove braces from template interpolation";
      newText = `$${segment.name}`;
    }

    if (cursorOffset < interpolationStart || cursorOffset > interpolationEnd) {
      continue;
    }

    return {
      title,
      range: {
        start: offsetToPosition(text, interpolationStart),
        end: offsetToPosition(text, interpolationEnd)
      },
      newText
    };
  }

  return null;
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

  if (isSourceTemplate(text, expression)) {
    if (!supportsShorthandTemplates(uri)) {
      return [];
    }
    const toggle = interpolationToggle(text, expression, position);
    if (!toggle) {
      return [];
    }
    return [
      {
        title: toggle.title,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [uri]: [{ range: toggle.range, newText: toggle.newText }]
          }
        }
      }
    ];
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
