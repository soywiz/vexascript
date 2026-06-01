import type { SourcePosition, SourceRange } from "compiler/parser/tokenizer";

/**
 * Formats zero-based internal source coordinates for user-facing diagnostics.
 *
 * Parser, tokenizer, and LSP internals keep positions zero-based so they can be
 * passed directly to editor protocols. CLI/compiler diagnostics are intended for
 * humans and therefore display line and column numbers as one-based values.
 */
export function formatSourcePosition(position: Pick<SourcePosition, "line" | "column">): string {
  return `${position.line + 1}:${position.column + 1}`;
}

export function formatSourceRangeStart(range: Pick<SourceRange, "start">): string {
  return formatSourcePosition(range.start);
}

export function formatMessageAtSourceRange(message: string, range: Pick<SourceRange, "start">): string {
  return `${message} at ${formatSourceRangeStart(range)}`;
}
