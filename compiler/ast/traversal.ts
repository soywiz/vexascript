import { isNodeKind, NodeKind } from "compiler/ast/ast";
import type { ExportStatement, Node, Statement } from "./ast";

/**
 * Returns the underlying declaration carried by an `export` statement, or the
 * statement itself when it is not an export. Useful when collecting top-level
 * declarations regardless of whether they are exported. Returns `undefined`
 * for re-export forms (`export { x }`, `export * from ...`) that carry no
 * inline declaration.
 */
export function unwrapExportedDeclaration(statement: Statement): Statement | undefined {
  return statement.kind === NodeKind.ExportStatement
    ? (statement as ExportStatement).declaration
    : statement;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    isNodeKind((value as { kind?: unknown }).kind)
  );
}

function isMetadataKey(key: string): boolean {
  return key === "firstToken" || key === "lastToken" || key === "__vexaRecoveryMarkers";
}

/** Returns the direct structural AST children of a node, excluding source-token metadata. */
export function childNodes(node: Node): Node[] {
  const children: Node[] = [];

  for (const key in node) {
    if (isMetadataKey(key)) {
      continue;
    }
    const value = node[key as keyof Node];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isNode(entry)) {
          children.push(entry);
        }
      }
    } else if (isNode(value)) {
      children.push(value);
    }
  }

  return children;
}

/**
 * Walks an AST in pre-order. Shared or cyclic nodes are visited only once.
 * The visitor may return `false` to stop the whole traversal early; any other
 * return value continues the walk.
 */
export function walkAst(root: Node, visit: (node: Node) => unknown): void {
  const visited = new WeakSet<object>();
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (visit(node) === false) {
      return;
    }

    const children: Node[] = [];
    for (const key in node) {
      if (isMetadataKey(key)) {
        continue;
      }
      const value = node[key as keyof Node];
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (isNode(entry)) {
            children.push(entry);
          }
        }
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
}

/** Returns the first node (in pre-order) accepted by the predicate, or null. */
export function findNode<T extends Node>(
  root: Node,
  predicate: (node: Node) => node is T
): T | null {
  let found: T | null = null;
  walkAst(root, (node) => {
    if (predicate(node)) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}
