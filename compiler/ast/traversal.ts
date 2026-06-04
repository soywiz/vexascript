import type { Node } from "./ast";

const metadataKeys = new Set(["firstToken", "lastToken"]);

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** Returns the direct structural AST children of a node, excluding source-token metadata. */
export function childNodes(node: Node): Node[] {
  const children: Node[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (metadataKeys.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      children.push(...value.filter(isNode));
    } else if (isNode(value)) {
      children.push(value);
    }
  }

  return children;
}

/** Walks an AST in pre-order. Shared or cyclic nodes are visited only once. */
export function walkAst(root: Node, visit: (node: Node) => void): void {
  const visited = new WeakSet<object>();

  const walk = (node: Node): void => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    visit(node);
    for (const child of childNodes(node)) {
      walk(child);
    }
  };

  walk(root);
}
