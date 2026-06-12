import type { Node } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { containsPosition, nodeRange, rangeContains, rangeSize, type NodeRange, type Position } from "./ranges";

export type NodeSearchPreference = "smallest" | "largest";

interface BestValue<R> {
  value: R;
  size: number;
}

function isBetterSize(
  size: number,
  current: BestValue<unknown> | null,
  preference: NodeSearchPreference
): boolean {
  if (!current) {
    return true;
  }
  return preference === "smallest" ? size <= current.size : size >= current.size;
}

/**
 * Walks the AST and returns the best-ranked result produced by the matcher.
 * The matcher performs all filtering and returns `{ size, value }` for nodes
 * that qualify; on equal sizes the later match wins, mirroring the historical
 * quick-fix lookup behavior.
 */
export function findBestMatch<R>(
  root: Node,
  matchNode: (node: Node) => BestValue<R> | null | undefined,
  preference: NodeSearchPreference = "smallest"
): R | null {
  let best: BestValue<R> | null = null;

  walkAst(root, (node) => {
    const candidate = matchNode(node);
    if (candidate && isBetterSize(candidate.size, best, preference)) {
      best = candidate;
    }
  });

  const selected = best as BestValue<R> | null;
  return selected ? selected.value : null;
}

export interface PositionMatchCandidate<R> {
  /** Range the position must fall inside for the candidate to apply. */
  range: NodeRange;
  /** Ranking size; defaults to the size of `range`. */
  size?: number;
  /**
   * Builds the result for a candidate whose range contains the position.
   * Returning null discards the candidate, so expensive lookups can stay
   * behind the cheap position filter.
   */
  build: () => R | null;
}

/**
 * Walks the AST and returns the result built for the best-ranked candidate
 * whose range contains the position. A matcher may return several candidates
 * per node (e.g. one per call argument).
 */
export function findBestMatchAtPosition<R>(
  root: Node,
  position: Position,
  matchNode: (
    node: Node
  ) => PositionMatchCandidate<R> | readonly PositionMatchCandidate<R>[] | null | undefined,
  preference: NodeSearchPreference = "smallest"
): R | null {
  let best: BestValue<R> | null = null;

  walkAst(root, (node) => {
    const matched = matchNode(node);
    if (!matched) {
      return;
    }
    const candidates = Array.isArray(matched) ? matched : [matched];
    for (const candidate of candidates) {
      if (!containsPosition(candidate.range, position)) {
        continue;
      }
      const size = candidate.size ?? rangeSize(candidate.range);
      if (!isBetterSize(size, best, preference)) {
        continue;
      }
      const value = candidate.build();
      if (value !== null) {
        best = { value, size };
      }
    }
  });

  const selected = best as BestValue<R> | null;
  return selected ? selected.value : null;
}

export function findNodeAtPosition<T extends Node>(
  root: Node,
  position: Position,
  predicate: (node: Node) => node is T,
  preference: NodeSearchPreference = "smallest"
): T | null {
  return findBestMatchAtPosition(
    root,
    position,
    (node) => {
      if (!predicate(node)) {
        return null;
      }
      const range = nodeRange(node);
      return range ? { range, build: () => node } : null;
    },
    preference
  );
}

export function findNodeContainingRange<T extends Node>(
  root: Node,
  rangeToContain: NodeRange,
  predicate: (node: Node) => node is T,
  preference: NodeSearchPreference = "smallest"
): T | null {
  return findBestMatch(
    root,
    (node) => {
      if (!predicate(node)) {
        return null;
      }
      const range = nodeRange(node);
      if (!range || !rangeContains(range, rangeToContain)) {
        return null;
      }
      return { size: rangeSize(range), value: node };
    },
    preference
  );
}
