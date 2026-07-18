import { Node, NodeKind, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { lowerProgram } from "./lowering";

describe("lowerProgram", () => {
  it("lowers for-of range loops into classic for loops", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    const lowered = lowerProgram(program);
    const statement = lowered.body[0];

    expect(lowered).toBeInstanceOf(Program);
    walkAst(lowered, (node) => {
      expect(node instanceof Node).toBe(true);
    });
    expect(statement?.kind).toBe(NodeKind.ForStatement);
    expect((statement as any).iterationKind).toBeUndefined();
    expect((statement as any).initializer).toMatchObject({
      kind: NodeKind.VarStatement,
      declarationKind: "let",
      name: { kind: NodeKind.Identifier, name: "a" }
    });
    expect((statement as any).condition).toMatchObject({
      kind: NodeKind.BinaryExpression,
      operator: "<="
    });
    expect((statement as any).update).toMatchObject({
      kind: NodeKind.UpdateExpression,
      operator: "++",
      prefix: false
    });
  });
});
