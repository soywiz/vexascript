import type { Range } from "vscode-languageserver/node.js";

export interface Position {
  line: number;
  character: number;
}

export interface NodeRange {
  start: Position;
  end: Position;
}

interface TokenPosition {
  line: number;
  column: number;
}

export interface RangedToken {
  range: {
    start: TokenPosition;
    end: TokenPosition;
  };
}

export interface TokenBackedNode {
  firstToken?: RangedToken;
  lastToken?: RangedToken;
}

function tokenPositionToLspPosition(position: TokenPosition): Position {
  return {
    line: position.line,
    character: position.column
  };
}

export function tokenStartPosition(token: RangedToken): Position {
  return tokenPositionToLspPosition(token.range.start);
}

export function tokenEndPosition(token: RangedToken): Position {
  return tokenPositionToLspPosition(token.range.end);
}

export function tokenRange(token: RangedToken | undefined): NodeRange | null {
  if (!token) {
    return null;
  }

  return {
    start: tokenPositionToLspPosition(token.range.start),
    end: tokenPositionToLspPosition(token.range.end)
  };
}

export function nodeRange(node: TokenBackedNode): Range | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }

  return {
    start: tokenPositionToLspPosition(node.firstToken.range.start),
    end: tokenPositionToLspPosition(node.lastToken.range.end)
  };
}

export function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

export function containsPosition(range: NodeRange, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

export function rangeContains(outer: NodeRange, inner: NodeRange): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(outer.end, inner.end) >= 0;
}

export function rangeSize(range: NodeRange): number {
  const lineSpan = range.end.line - range.start.line;
  if (lineSpan > 0) {
    return lineSpan * 100_000 + (range.end.character - range.start.character);
  }
  return range.end.character - range.start.character;
}

export interface TypedRangedToken extends RangedToken {
  type: string;
  value: string;
}

/**
 * Insertion point for appending members to a braced declaration body: just
 * before a trailing `}` token, or right after the last token when the
 * declaration has no braced body.
 */
export function bodyEndInsertRange(node: { lastToken?: TypedRangedToken }): Range | null {
  const last = node.lastToken;
  if (!last) {
    return null;
  }
  const position =
    last.type === "symbol" && last.value === "}"
      ? tokenStartPosition(last)
      : tokenEndPosition(last);
  return { start: position, end: { ...position } };
}

export function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  const limit = Math.max(0, Math.min(offset, text.length));
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: limit - lineStart };
}

export function positionToOffset(text: string, position: Position): number {
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
