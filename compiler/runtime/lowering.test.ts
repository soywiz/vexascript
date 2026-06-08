import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { lowerProgram } from "./lowering";

describe("lowerProgram", () => {
  it("lowers for-of range loops into classic for loops", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    const lowered = lowerProgram(program);
    const statement = lowered.body[0];

    expect(statement?.kind).toBe("ForStatement");
    expect((statement as any).iterationKind).toBeUndefined();
    expect((statement as any).initializer).toMatchObject({
      kind: "VarStatement",
      declarationKind: "let",
      name: { kind: "Identifier", name: "a" }
    });
    expect((statement as any).condition).toMatchObject({
      kind: "BinaryExpression",
      operator: "<="
    });
    expect((statement as any).update).toMatchObject({
      kind: "UpdateExpression",
      operator: "++",
      prefix: false
    });
  });
});
