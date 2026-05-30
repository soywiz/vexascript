import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { emitProgram } from "./emitter";

describe("emitProgram", () => {
  it("emits mylang for-in as for-of const", () => {
    const program = parseFile(tokenizeReader("for (n in [1,2,3]) console.log(n)"));
    expect(emitProgram(program)).toContain("for (const n of [1, 2, 3]) console.log(n);");
  });

  it("optimizes range-based for-of to classic for loop", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    expect(emitProgram(program)).toContain("for (let a = 0; a < 10; a++) console.log(a);");
  });

  it("emits range expression outside for as generator", () => {
    const program = parseFile(tokenizeReader("let values = 0 ... 3"));
    expect(emitProgram(program)).toContain(
      "let values = (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 3);"
    );
  });

  it("preserves binary precedence with parentheses when required", () => {
    const program = parseFile(tokenizeReader("let value = (1 + 2) * 3"));
    expect(emitProgram(program)).toContain("let value = (1 + 2) * 3;");
  });

  it("preserves right-side grouping for left-associative operators", () => {
    const program = parseFile(tokenizeReader("let value = 1 - (2 - 3)"));
    expect(emitProgram(program)).toContain("let value = 1 - (2 - 3);");
  });
});
