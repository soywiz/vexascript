import type {
  ArrowFunctionExpression,
  CallExpression,
  Node,
  NewExpression,
  Program
} from "compiler/ast/ast";
import { type CodeAction, type TextEdit } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findNodeAtPosition } from "./nodeSearch";
import { offsetToPosition, type Position } from "./ranges";

interface RangedToken {
  value?: string;
  range: {
    start: { line: number; column: number; offset: number };
    end: { line: number; column: number; offset: number };
  };
}

type TrailingLambdaCall = (CallExpression | NewExpression) & {
  arguments: Node[];
  lastToken: RangedToken;
};

function tokenStartPosition(token: RangedToken): Position {
  return { line: token.range.start.line, character: token.range.start.column };
}

function tokenEndPosition(token: RangedToken): Position {
  return { line: token.range.end.line, character: token.range.end.column };
}

function isBraceLambda(node: Node | undefined): node is ArrowFunctionExpression {
  if (!node || node.kind !== "ArrowFunctionExpression") {
    return false;
  }
  const firstToken = (node as { firstToken?: RangedToken }).firstToken;
  return firstToken?.value === "{";
}

/**
 * A call (or `new` expression) qualifies for the "trailing lambda" fix when its
 * last argument is a brace lambda that is still written *inside* the call
 * parentheses. The parser represents `foo(a, { x -> ... })` and the equivalent
 * trailing form `foo(a) { x -> ... }` with the same AST, so we distinguish them
 * by checking that the node still ends on a `)` (the closing parenthesis sits
 * after the lambda) rather than on the lambda's closing `}`.
 */
function isTrailingLambdaCandidate(node: Node): node is TrailingLambdaCall {
  if (node.kind !== "CallExpression" && node.kind !== "NewExpression") {
    return false;
  }
  const args = (node as CallExpression | NewExpression).arguments;
  if (!args || args.length === 0) {
    return false;
  }
  const lastArg = args[args.length - 1];
  if (!isBraceLambda(lastArg)) {
    return false;
  }
  const lastToken = (node as { lastToken?: RangedToken }).lastToken;
  return lastToken?.value === ")";
}

function calleeSearchStartOffset(node: TrailingLambdaCall): number | null {
  const callee = (node as CallExpression | NewExpression).callee as { lastToken?: RangedToken };
  let offset = callee.lastToken?.range.end.offset ?? null;
  const typeArguments = (node as CallExpression | NewExpression).typeArguments;
  if (typeArguments && typeArguments.length > 0) {
    const lastTypeArg = typeArguments[typeArguments.length - 1] as { lastToken?: RangedToken };
    const typeArgEnd = lastTypeArg.lastToken?.range.end.offset;
    if (typeArgEnd !== undefined && (offset === null || typeArgEnd > offset)) {
      offset = typeArgEnd;
    }
  }
  return offset;
}

export function createTrailingLambdaCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
}): CodeAction[] {
  const { uri, ast, text, position } = params;
  if (!ast) {
    return [];
  }

  const node = findNodeAtPosition(ast, position, isTrailingLambdaCandidate);
  if (!node) {
    return [];
  }

  const args = node.arguments;
  const lambda = args[args.length - 1] as ArrowFunctionExpression & { firstToken?: RangedToken; lastToken?: RangedToken };
  const lambdaFirstToken = lambda.firstToken;
  const lambdaLastToken = lambda.lastToken;
  const closeParen = node.lastToken;
  if (!lambdaFirstToken || !lambdaLastToken) {
    return [];
  }

  const edits: TextEdit[] = [];

  if (args.length > 1) {
    // Replace the `, ` (comma + whitespace) before the lambda with `) ` so the
    // remaining arguments keep their closing parenthesis.
    const prevArg = args[args.length - 2] as { lastToken?: RangedToken };
    const prevArgLastToken = prevArg.lastToken;
    if (!prevArgLastToken) {
      return [];
    }
    edits.push({
      range: {
        start: tokenEndPosition(prevArgLastToken),
        end: tokenStartPosition(lambdaFirstToken)
      },
      newText: ") "
    });
  } else {
    // The lambda is the only argument: drop the opening parenthesis entirely so
    // `foo({ x -> ... })` becomes `foo { x -> ... }`.
    const searchStart = calleeSearchStartOffset(node);
    if (searchStart === null) {
      return [];
    }
    const openParenOffset = text.indexOf("(", searchStart);
    if (openParenOffset < 0) {
      return [];
    }
    edits.push({
      range: {
        start: offsetToPosition(text, openParenOffset),
        end: tokenStartPosition(lambdaFirstToken)
      },
      newText: " "
    });
  }

  // Remove the now-orphaned closing parenthesis (and any whitespace/comma
  // between the lambda and it).
  edits.push({
    range: {
      start: tokenEndPosition(lambdaLastToken),
      end: tokenEndPosition(closeParen)
    },
    newText: ""
  });

  return [
    {
      title: "Move lambda out of the call parentheses",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: edits
        }
      }
    }
  ];
}
