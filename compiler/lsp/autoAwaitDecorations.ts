import { NodeKind } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import type { CallExpression, MemberExpression, Node, Program, UnaryExpression } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import type { Range } from "vscode-languageserver/node.js";

/**
 * A gutter/margin marker for a line that contains an `await` — either an explicit `await` inside an
 * `async`/`sync` function, or an implicit one inserted by the compiler when a Promise-typed
 * expression is auto-awaited inside a `sync` function body (similar to the suspend-call gutter icons
 * in Kotlin IDEs).
 *
 * One decoration is produced per affected line. The range is anchored to the token that should own
 * the gutter marker (`await` itself for explicit awaits, or the most relevant call/member token for
 * implicit awaits) so multi-line awaited expressions do not paint the gutter on every wrapped line.
 */
export interface AutoAwaitDecoration {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** Human-readable explanation, suitable for a hover tooltip on the gutter icon. */
  message: string;
}

const IMPLICIT_AWAIT_MESSAGE =
  "Implicit await: this Promise is automatically awaited inside a sync function";
const EXPLICIT_AWAIT_MESSAGE = "Awaited expression";
const ASYNC_FOR_MESSAGE = "Async iteration: this for loop iterates an AsyncIterator and suspends on each value";

function nodeRange(node: Node): AutoAwaitDecoration["range"] | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  const anchorToken = autoAwaitAnchorToken(node);
  return {
    start: {
      line: anchorToken.range.start.line,
      character: anchorToken.range.start.column
    },
    end: {
      line: anchorToken.range.end.line,
      character: anchorToken.range.end.column
    }
  };
}

function autoAwaitAnchorToken(node: Node) {
  if (
    node.kind === NodeKind.CallExpression &&
    (node as CallExpression).callee.kind === NodeKind.MemberExpression
  ) {
    const member = (node as CallExpression).callee as MemberExpression;
    return member.property.firstToken ?? node.firstToken!;
  }
  if (node.kind === NodeKind.MemberExpression) {
    const member = node as MemberExpression;
    return member.property.firstToken ?? node.firstToken!;
  }
  return node.firstToken!;
}

/**
 * Computes the await gutter decorations for a document: explicit `await` expressions plus the
 * expressions the analyzer flagged as implicitly awaited, restricted to (and overlapping with) the
 * requested `range`. At most one decoration is returned per source line so editors render a single
 * gutter icon per line.
 */
export function createAutoAwaitDecorations(
  ast: Program,
  analysis: Analysis,
  range?: Range
): AutoAwaitDecoration[] {
  const byLine = new Map<number, AutoAwaitDecoration>();

  const consider = (node: Node, message: string): void => {
    const decorationRange = nodeRange(node);
    if (!decorationRange) {
      return;
    }
    if (
      range &&
      (decorationRange.end.line < range.start.line || decorationRange.start.line > range.end.line)
    ) {
      return;
    }
    const line = decorationRange.start.line;
    const existing = byLine.get(line);
    // Keep the earliest-starting awaited expression on each line for a stable, single gutter marker.
    if (!existing || decorationRange.start.character < existing.range.start.character) {
      byLine.set(line, { range: decorationRange, message });
    }
  };

  for (const node of analysis.getAutoAwaitExpressions()) {
    consider(node, IMPLICIT_AWAIT_MESSAGE);
  }

  for (const node of analysis.getAsyncForStatements()) {
    if (!node.firstToken) continue;
    const line = node.firstToken.range.start.line;
    const character = node.firstToken.range.start.column;
    if (range && (line < range.start.line || line > range.end.line)) continue;
    const existing = byLine.get(line);
    if (!existing || character < existing.range.start.character) {
      byLine.set(line, { range: { start: { line, character }, end: { line, character: node.firstToken.range.end.column } }, message: ASYNC_FOR_MESSAGE });
    }
  }

  walkAst(ast, (node) => {
    if (node.kind === NodeKind.UnaryExpression && (node as UnaryExpression).operator === "await") {
      consider(node, EXPLICIT_AWAIT_MESSAGE);
    }
  });

  return [...byLine.values()].sort((a, b) => a.range.start.line - b.range.start.line);
}
