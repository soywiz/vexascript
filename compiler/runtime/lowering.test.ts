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

  it("eliminates nested control-flow expressions while preserving native control statements", () => {
    const program = parseFile(tokenizeReader(`
fun demo(flag: boolean): int {
  flag || return 1
  val selected = if (flag) 2 else throw "missing"
  return selected
}
`));
    const lowered = lowerProgram(program);
    const logicalExpressions: Node[] = [];
    const controlStatements: Node[] = [];

    walkAst(lowered, (node) => {
      if (node.kind === NodeKind.BinaryExpression && (node as any).operator === "||") {
        logicalExpressions.push(node);
      }
      if (
        node.kind === NodeKind.ReturnStatement ||
        node.kind === NodeKind.ThrowStatement
      ) {
        controlStatements.push(node);
      }
    });

    expect(logicalExpressions).toEqual([]);
    expect(controlStatements).toHaveLength(3);
  });

  it("uses collision-free temporaries and lowers expression-bodied arrows", () => {
    const program = parseFile(tokenizeReader(`
fun demo(flag: boolean): int {
  val __vexa_control_0 = flag
  __vexa_control_0 || return 1
  return 2
}
val decide = (flag: boolean): boolean => flag || return false
`));
    const lowered = lowerProgram(program);
    const temporaryNames: string[] = [];
    let arrowBodyKind: NodeKind | undefined;

    walkAst(lowered, (node) => {
      if (node.kind === NodeKind.VarStatement) {
        const name = (node as any).name?.name;
        if (typeof name === "string" && name.startsWith("__vexa_control_")) temporaryNames.push(name);
      }
      if (node.kind === NodeKind.ArrowFunctionExpression) {
        arrowBodyKind = (node as any).body.kind;
      }
    });

    expect(temporaryNames).toContain("__vexa_control_0");
    expect(temporaryNames).toContain("__vexa_control_1");
    expect(temporaryNames).toContain("__vexa_control_2");
    expect(arrowBodyKind).toBe(NodeKind.BlockStatement);
  });
});
