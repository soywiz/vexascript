import { Token } from "compiler/parser/tokenizer";

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

function isPositionInsideToken(token: Token, line: number, character: number): boolean {
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
  tokens: Token[],
  line: number,
  character: number
): KeywordReplacement | null {
  const token = tokens.find((item) => isPositionInsideToken(item, line, character));
  if (!token || token.type !== "identifier") {
    return null;
  }

  const from = token.value as KeywordReplacement["from"];
  const to = ALTERNATES[from];
  if (!to) {
    return null;
  }

  return {
    from,
    to,
    range: {
      start: { line: token.range.start.line, character: token.range.start.column },
      end: { line: token.range.end.line, character: token.range.end.column }
    }
  };
}
