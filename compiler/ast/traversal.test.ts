import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
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
    const identifier: Node = { kind: NodeKind.Identifier, firstToken: token, lastToken: token };
    const literal: Node = { kind: NodeKind.IntLiteral };
    const recoveryMarker = { kind: "RecoveryMarker" };
    const root: Node & { body: Node[]; __vexaRecoveryMarkers: unknown[] } = {
      kind: NodeKind.Program,
      firstToken: token,
      lastToken: token,
      body: [identifier, literal],
      __vexaRecoveryMarkers: [recoveryMarker]
    };

    expect(childNodes(root).map((node) => node.kind)).toEqual([NodeKind.Identifier, NodeKind.IntLiteral]);

    const visited: NodeKind[] = [];
    walkAst(root, (node) => visited.push(node.kind));

    expect(visited).toEqual([NodeKind.Program, NodeKind.Identifier, NodeKind.IntLiteral]);
  });

  it("visits shared or cyclic nodes only once", () => {
    const shared: Node = { kind: NodeKind.Identifier };
    const root = { kind: NodeKind.Program, body: [shared], contextual: shared } as Node & { parent?: Node };
    root.parent = root;

    const visited: NodeKind[] = [];
    walkAst(root, (node) => visited.push(node.kind));

    expect(visited).toEqual([NodeKind.Program, NodeKind.Identifier]);
  });

  it("stops the whole walk when the visitor returns false", () => {
    const first: Node = { kind: NodeKind.Identifier };
    const nested: Node = { kind: NodeKind.IntLiteral };
    const second = { kind: NodeKind.BinaryExpression, left: nested } as unknown as Node;
    const root = { kind: NodeKind.Program, body: [first, second] } as unknown as Node;

    const visited: NodeKind[] = [];
    walkAst(root, (node) => {
      visited.push(node.kind);
      return node.kind !== NodeKind.Identifier;
    });

    expect(visited).toEqual([NodeKind.Program, NodeKind.Identifier]);
  });
});

describe("findNode", () => {
  it("returns the first pre-order node accepted by the predicate", () => {
    const target: Node = { kind: NodeKind.Identifier };
    const later: Node = { kind: NodeKind.Identifier };
    const root = { kind: NodeKind.Program, body: [{ kind: NodeKind.ExprStatement, expression: target } as unknown as Node, later] } as unknown as Node;

    expect(findNode(root, (node): node is Node => node.kind === NodeKind.Identifier)).toBe(target);
    expect(findNode(root, (node): node is Node => node.kind === NodeKind.ClassStatement)).toBe(null);
  });
});

describe("unwrapExportedDeclaration", () => {
  it("returns the inner declaration of an export statement", () => {
    const declaration = { kind: NodeKind.FunctionStatement } as unknown as Statement;
    const exportStatement = { kind: NodeKind.ExportStatement, declaration } as unknown as ExportStatement;

    expect(unwrapExportedDeclaration(exportStatement)).toBe(declaration);
  });

  it("returns the statement itself when it is not an export", () => {
    const statement = { kind: NodeKind.ClassStatement } as unknown as Statement;

    expect(unwrapExportedDeclaration(statement)).toBe(statement);
  });

  it("returns undefined for re-export statements without an inline declaration", () => {
    const reExport = { kind: NodeKind.ExportStatement } as unknown as ExportStatement;

    expect(unwrapExportedDeclaration(reExport)).toBeUndefined();
  });
});
