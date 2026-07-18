interface SourceLineColumn {
  offset?: number;
  line: number;
  column: number;
}

interface SourceRangeStart {
  start: SourceLineColumn;
}

/**
 * Formats zero-based internal source coordinates for user-facing diagnostics.
 *
 * Parser, tokenizer, and LSP internals keep positions zero-based so they can be
 * passed directly to editor protocols. CLI/compiler diagnostics are intended for
 * humans and therefore display line and column numbers as one-based values.
 */
export function formatSourcePosition(position: SourceLineColumn): string {
  return `${position.line + 1}:${position.column + 1}`;
}

export function formatSourceRangeStart(range: SourceRangeStart): string {
  return formatSourcePosition(range.start);
}

export function formatMessageAtSourceRange(message: string, range: SourceRangeStart): string {
  return `${message} at ${formatSourceRangeStart(range)}`;
}
