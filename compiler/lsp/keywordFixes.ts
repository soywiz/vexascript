import type { Program, VarStatement } from "compiler/ast/ast";
import { findNodeAtPosition } from "./nodeSearch";

export interface KeywordReplacement {
  from: "let" | "const" | "var" | "val";
  to: "let" | "const" | "var" | "val";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

const ALTERNATES: Record<KeywordReplacement["from"], KeywordReplacement["to"]> = {
  let: "const",
  const: "let",
  var: "val",
  val: "var"
};

function isPositionInsideTokenRange(
  token:
    | {
        range: {
          start: { line: number; column: number };
          end: { line: number; column: number };
        };
      }
    | undefined,
  line: number,
  character: number
): boolean {
  if (!token) {
    return false;
  }

  const start = token.range.start;
  const end = token.range.end;

  if (line < start.line || line > end.line) {
    return false;
  }
  if (line === start.line && character < start.column) {
    return false;
  }
  if (line === end.line && character > end.column) {
    return false;
  }

  return true;
}

export function findDeclarationKeywordReplacementAtPosition(
  ast: Program,
  line: number,
  character: number
): KeywordReplacement | null {
  const variableStatement = findNodeAtPosition(
    ast,
    { line, character },
    (node): node is VarStatement => node.kind === "VarStatement"
  );
  if (!variableStatement) {
    return null;
  }

  const declarationToken = variableStatement.firstToken;
  if (!declarationToken || declarationToken.type !== "identifier") {
    return null;
  }

  if (!isPositionInsideTokenRange(declarationToken, line, character)) {
    return null;
  }

  const from = declarationToken.value as KeywordReplacement["from"];
  const to = ALTERNATES[from];
  if (!to) {
    return null;
  }

  return {
    from,
    to,
    range: {
      start: { line: declarationToken.range.start.line, character: declarationToken.range.start.column },
      end: { line: declarationToken.range.end.line, character: declarationToken.range.end.column }
    }
  };
}
