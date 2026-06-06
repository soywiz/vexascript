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

interface RangedToken {
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
