import type { ExportStatement, Node, Statement } from "./ast";

/**
 * Returns the underlying declaration carried by an `export` statement, or the
 * statement itself when it is not an export. Useful when collecting top-level
 * declarations regardless of whether they are exported. Returns `undefined`
 * for re-export forms (`export { x }`, `export * from ...`) that carry no
 * inline declaration.
 */
export function unwrapExportedDeclaration(statement: Statement): Statement | undefined {
  return statement.kind === "ExportStatement"
    ? (statement as ExportStatement).declaration
    : statement;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

function isMetadataKey(key: string): boolean {
  return key === "firstToken" || key === "lastToken";
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

/** Walks an AST in pre-order. Shared or cyclic nodes are visited only once. */
export function walkAst(root: Node, visit: (node: Node) => void): void {
  const visited = new WeakSet<object>();

  const walk = (node: Node): void => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    visit(node);

    for (const key in node) {
      if (isMetadataKey(key)) {
        continue;
      }
      const value = node[key as keyof Node];
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (isNode(entry)) {
            walk(entry);
          }
        }
      } else if (isNode(value)) {
        walk(value);
      }
    }
  };

  walk(root);
}
