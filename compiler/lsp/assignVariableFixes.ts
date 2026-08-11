import { AssignmentExpression, ExprStatement, UpdateExpression } from "compiler/ast/ast";
import type { Expr, Node, Program } from "compiler/ast/ast";

import type { CodeAction } from "vscode-languageserver/node.js";
import { DEFAULT_CANONICAL_SYNTAX, type CanonicalSyntax } from "compiler/canonicalSyntax";
import { CodeActionKind } from "./codeActionKinds";
import { findNodeAtPosition } from "./nodeSearch";
import { nodeRange, offsetToPosition, type Position } from "./ranges";

export const SELECT_CODE_ACTION_RANGE_COMMAND = "vexa.selectCodeActionRange";

function positionToOffset(text: string, position: Position): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line && lineStart <= text.length) {
    const nextBreak = text.indexOf("\n", lineStart);
    if (nextBreak < 0) {
      return text.length;
    }
    line += 1;
    lineStart = nextBreak + 1;
  }
  return Math.min(text.length, lineStart + position.character);
}

function isExprStatement(node: Node): node is ExprStatement {
  return node instanceof ExprStatement;
}

function isAssignmentLikeExpression(expression: Expr): expression is AssignmentExpression | UpdateExpression {
  return expression instanceof AssignmentExpression || expression instanceof UpdateExpression;
}

export function createAssignVariableCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
  canonicalSyntax?: CanonicalSyntax;
}): CodeAction[] {
  const { uri, ast, text, position, canonicalSyntax = DEFAULT_CANONICAL_SYNTAX } = params;
  if (!ast) {
    return [];
  }

  const statement = findNodeAtPosition(ast, position, isExprStatement, "largest");
  if (!statement || isAssignmentLikeExpression(statement.expression)) {
    return [];
  }

  const statementRange = nodeRange(statement);
  const expressionRange = nodeRange(statement.expression);
  if (!statementRange || !expressionRange) {
    return [];
  }

  const expressionStartOffset = positionToOffset(text, expressionRange.start);
  const expressionEndOffset = positionToOffset(text, expressionRange.end);
  const expressionText = text.slice(expressionStartOffset, expressionEndOffset);
  if (expressionText.trim().length === 0) {
    return [];
  }

  const declarationKeyword = canonicalSyntax.immutableDeclaration;
  const replacementText = `${declarationKeyword} variable = ${expressionText}`;
  const statementStartOffset = positionToOffset(text, statementRange.start);
  const placeholderStartOffset = statementStartOffset + declarationKeyword.length + 1;
  const placeholderEndOffset = placeholderStartOffset + "variable".length;

  return [
    {
      title: "Assign to variable",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            {
              range: statementRange,
              newText: replacementText
            }
          ]
        }
      },
      command: {
        title: "Select variable name",
        command: SELECT_CODE_ACTION_RANGE_COMMAND,
        arguments: [
          uri,
          {
            start: offsetToPosition(text, placeholderStartOffset),
            end: offsetToPosition(text, placeholderEndOffset)
          }
        ]
      }
    }
  ];
}
