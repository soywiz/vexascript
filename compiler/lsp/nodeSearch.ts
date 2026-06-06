import type { Node } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { containsPosition, nodeRange, rangeContains, rangeSize, type NodeRange, type Position } from "./ranges";

export type NodeSearchPreference = "smallest" | "largest";

interface BestNode<T extends Node> {
  node: T;
  size: number;
}

function isBetterMatch<T extends Node>(
  candidate: BestNode<T>,
  current: BestNode<T> | null,
  preference: NodeSearchPreference
): boolean {
  if (!current) {
    return true;
  }
  return preference === "smallest"
    ? candidate.size <= current.size
    : candidate.size >= current.size;
}

export function findNodeAtPosition<T extends Node>(
  root: Node,
  position: Position,
  predicate: (node: Node) => node is T,
  preference: NodeSearchPreference = "smallest"
): T | null {
  let best: BestNode<T> | null = null;

  walkAst(root, (node) => {
    if (!predicate(node)) {
      return;
    }
    const range = nodeRange(node);
    if (!range || !containsPosition(range, position)) {
      return;
    }
    const candidate = { node, size: rangeSize(range) };
    if (isBetterMatch(candidate, best, preference)) {
      best = candidate;
    }
  });

  const selected = best as BestNode<T> | null;
  return selected?.node ?? null;
}

export function findNodeContainingRange<T extends Node>(
  root: Node,
  rangeToContain: NodeRange,
  predicate: (node: Node) => node is T,
  preference: NodeSearchPreference = "smallest"
): T | null {
  let best: BestNode<T> | null = null;

  walkAst(root, (node) => {
    if (!predicate(node)) {
      return;
    }
    const range = nodeRange(node);
    if (!range || !rangeContains(range, rangeToContain)) {
      return;
    }
    const candidate = { node, size: rangeSize(range) };
    if (isBetterMatch(candidate, best, preference)) {
      best = candidate;
    }
  });

  const selected = best as BestNode<T> | null;
  return selected?.node ?? null;
}
