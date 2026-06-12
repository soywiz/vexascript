import { describe, it } from "node:test";
import { expect } from "../test/expect";
import type { ExportStatement, Node, Statement } from "./ast";
import { childNodes, findNode, unwrapExportedDeclaration, walkAst } from "./traversal";

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

  it("stops the whole walk when the visitor returns false", () => {
    const first: Node = { kind: "Identifier" };
    const nested: Node = { kind: "IntLiteral" };
    const second = { kind: "BinaryExpression", left: nested } as unknown as Node;
    const root = { kind: "Program", body: [first, second] } as unknown as Node;

    const visited: string[] = [];
    walkAst(root, (node) => {
      visited.push(node.kind);
      return node.kind !== "Identifier";
    });

    expect(visited).toEqual(["Program", "Identifier"]);
  });
});

describe("findNode", () => {
  it("returns the first pre-order node accepted by the predicate", () => {
    const target: Node = { kind: "Identifier" };
    const later: Node = { kind: "Identifier" };
    const root = { kind: "Program", body: [{ kind: "ExpressionStatement", expression: target } as unknown as Node, later] } as unknown as Node;

    expect(findNode(root, (node): node is Node => node.kind === "Identifier")).toBe(target);
    expect(findNode(root, (node): node is Node => node.kind === "ClassStatement")).toBe(null);
  });
});

describe("unwrapExportedDeclaration", () => {
  it("returns the inner declaration of an export statement", () => {
    const declaration = { kind: "FunctionStatement" } as unknown as Statement;
    const exportStatement = { kind: "ExportStatement", declaration } as unknown as ExportStatement;

    expect(unwrapExportedDeclaration(exportStatement)).toBe(declaration);
  });

  it("returns the statement itself when it is not an export", () => {
    const statement = { kind: "ClassStatement" } as unknown as Statement;

    expect(unwrapExportedDeclaration(statement)).toBe(statement);
  });

  it("returns undefined for re-export statements without an inline declaration", () => {
    const reExport = { kind: "ExportStatement" } as unknown as ExportStatement;

    expect(unwrapExportedDeclaration(reExport)).toBeUndefined();
  });
});
