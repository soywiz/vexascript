import { describe, it } from "node:test";
import { expect } from "../../expect";
import type { Node } from "./ast";
import { childNodes, walkAst } from "./traversal";

describe("AST traversal", () => {
  it("walks structural child nodes in source property order without visiting token metadata", () => {
    const token = {
      type: "identifier" as const,
      value: "value",
      index: 0,
      range: {
        start: { offset: 0, line: 0, column: 0 },
        end: { offset: 5, line: 0, column: 5 }
      },
      leadingComments: [
        {
          kind: "line" as const,
          value: "comment",
          range: {
            start: { offset: 0, line: 0, column: 0 },
            end: { offset: 0, line: 0, column: 0 }
          }
        }
      ]
    };
    const identifier: Node = { kind: "Identifier", firstToken: token, lastToken: token };
    const literal: Node = { kind: "IntLiteral" };
    const root: Node & { body: Node[] } = {
      kind: "Program",
      firstToken: token,
      lastToken: token,
      body: [identifier, literal]
    };

    expect(childNodes(root).map((node) => node.kind)).toEqual(["Identifier", "IntLiteral"]);

    const visited: string[] = [];
    walkAst(root, (node) => visited.push(node.kind));

    expect(visited).toEqual(["Program", "Identifier", "IntLiteral"]);
  });

  it("visits shared or cyclic nodes only once", () => {
    const shared: Node = { kind: "Identifier" };
    const root = { kind: "Program", body: [shared], contextual: shared } as Node & { parent?: Node };
    root.parent = root;

    const visited: string[] = [];
    walkAst(root, (node) => visited.push(node.kind));

    expect(visited).toEqual(["Program", "Identifier"]);
  });
});
