import {
  AnnotationApplication,
  BinaryExpression,
  ExportStatement,
  ExprStatement,
  Identifier,
  IntLiteral,
  NodeKind,
  Program,
} from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import type { Node } from "./ast";
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
    const identifier = new Identifier("value");
    identifier.firstToken = token;
    identifier.lastToken = token;
    const literal = new IntLiteral(1);
    const recoveryMarker = { kind: "RecoveryMarker" };
    const root = new Program(
      [new ExprStatement(identifier), new ExprStatement(literal)],
      [recoveryMarker]
    );
    root.firstToken = token;
    root.lastToken = token;

    expect(childNodes(root).map((node) => node.kind)).toEqual([
      NodeKind.ExprStatement,
      NodeKind.ExprStatement,
    ]);

    const visited: NodeKind[] = [];
    walkAst(root, (node) => visited.push(node.kind));

    expect(visited).toEqual([
      NodeKind.Program,
      NodeKind.ExprStatement,
      NodeKind.Identifier,
      NodeKind.ExprStatement,
      NodeKind.IntLiteral,
    ]);
  });

  it("visits shared or cyclic nodes only once", () => {
    const shared = new ExprStatement(new Identifier("shared"));
    const root = new Program([shared]) as Program & { contextual?: Node; parent?: Node };
    root.contextual = shared;
    root.parent = root;

    const visited: NodeKind[] = [];
    walkAst(root, (node) => visited.push(node.kind));

    expect(visited).toEqual([NodeKind.Program, NodeKind.ExprStatement, NodeKind.Identifier]);
  });

  it("stops the whole walk when the visitor returns false", () => {
    const first = new ExprStatement(new Identifier("first"));
    const nested = new IntLiteral(1);
    const second = new ExprStatement(
      new BinaryExpression("+", nested, new IntLiteral(2))
    );
    const root = new Program([first, second]);

    const visited: NodeKind[] = [];
    walkAst(root, (node) => {
      visited.push(node.kind);
      return node !== first;
    });

    expect(visited).toEqual([NodeKind.Program, NodeKind.ExprStatement]);
  });

  it("walks statement annotations after a persisted program is deserialized", () => {
    const annotation = new AnnotationApplication(new Identifier("Memo"), []);
    const program = new Program([
      new ExprStatement(new Identifier("value"), [annotation]),
    ]);
    const restored = JSON.parse(JSON.stringify(program)) as Program;

    const visited: NodeKind[] = [];
    walkAst(restored, (node) => visited.push(node.kind));

    expect(visited).toEqual([
      NodeKind.Program,
      NodeKind.ExprStatement,
      NodeKind.AnnotationApplication,
      NodeKind.Identifier,
      NodeKind.Identifier,
    ]);
  });
});

describe("findNode", () => {
  it("returns the first pre-order node accepted by the predicate", () => {
    const target = new Identifier("target");
    const later = new Identifier("later");
    const root = new Program([new ExprStatement(target), new ExprStatement(later)]);

    expect(findNode(root, (node): node is Node => node.kind === NodeKind.Identifier)).toBe(target);
    expect(findNode(root, (node): node is Node => node.kind === NodeKind.ClassStatement)).toBe(null);
  });
});

describe("unwrapExportedDeclaration", () => {
  it("returns the inner declaration of an export statement", () => {
    const declaration = new ExprStatement(new Identifier("value"));
    const exportStatement = new ExportStatement(declaration);

    expect(unwrapExportedDeclaration(exportStatement)).toBe(declaration);
  });

  it("returns the statement itself when it is not an export", () => {
    const statement = new ExprStatement(new Identifier("value"));

    expect(unwrapExportedDeclaration(statement)).toBe(statement);
  });

  it("returns undefined for re-export statements without an inline declaration", () => {
    const reExport = new ExportStatement();

    expect(unwrapExportedDeclaration(reExport)).toBeUndefined();
  });
});
