import type { Analysis } from "compiler/analysis/Analysis";
import type { Node } from "compiler/ast/ast";
import type { Range } from "vscode-languageserver/node.js";

/**
 * A gutter/margin marker for a line where the compiler inserts an implicit `await` because a
 * Promise-typed expression is auto-awaited inside a `sync` function body (similar to the
 * suspend-call gutter icons in Kotlin IDEs).
 *
 * One decoration is produced per affected line: `range` spans the whole auto-awaited expression
 * (useful for hover), while editors typically render the gutter icon on `range.start.line`.
 */
export interface AutoAwaitDecoration {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** Human-readable explanation, suitable for a hover tooltip on the gutter icon. */
  message: string;
}

const AUTO_AWAIT_MESSAGE = "Implicit await: this Promise is automatically awaited inside a sync function";

function nodeRange(node: Node): AutoAwaitDecoration["range"] | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
}

/**
 * Computes the auto-await gutter decorations for the expressions the analyzer flagged as implicitly
 * awaited, restricted to (and overlapping with) the requested `range`. At most one decoration is
 * returned per source line so editors render a single gutter icon per line.
 */
export function createAutoAwaitDecorations(
  _ast: unknown,
  analysis: Analysis,
  range?: Range
): AutoAwaitDecoration[] {
  const byLine = new Map<number, AutoAwaitDecoration>();

  for (const node of analysis.getAutoAwaitExpressions()) {
    const decorationRange = nodeRange(node);
    if (!decorationRange) {
      continue;
    }
    if (
      range &&
      (decorationRange.end.line < range.start.line || decorationRange.start.line > range.end.line)
    ) {
      continue;
    }
    const line = decorationRange.start.line;
    const existing = byLine.get(line);
    // Keep the earliest-starting expression on each line for a stable, single gutter marker.
    if (!existing || decorationRange.start.character < existing.range.start.character) {
      byLine.set(line, { range: decorationRange, message: AUTO_AWAIT_MESSAGE });
    }
  }

  return [...byLine.values()].sort((a, b) => a.range.start.line - b.range.start.line);
}
