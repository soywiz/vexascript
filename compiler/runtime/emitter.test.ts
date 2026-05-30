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

  it("emits named import statements", () => {
    const program = parseFile(tokenizeReader("import { Point } from \"./a\""));
    expect(emitProgram(program)).toBe("import { Point } from \"./a\";");
  });

  it("emits decimal and scientific numeric literals", () => {
    const program = parseFile(tokenizeReader("let a = 10.573\nlet b = 10e-3"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("let a = 10.573;");
    expect(emitted).toContain("let b = 0.01;");
  });

  it("emits bigint and long literals as JavaScript bigint literals", () => {
    const program = parseFile(tokenizeReader("let a = 10n\nlet b = 20L"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("let a = 10n;");
    expect(emitted).toContain("let b = 20n;");
  });

  it("emits throw and try/catch/finally statements", () => {
    const program = parseFile(
      tokenizeReader("try { throw err } catch (e) { throw e } finally { return 0 }")
    );
    const emitted = emitProgram(program);
    expect(emitted).toContain("try {");
    expect(emitted).toContain("throw err;");
    expect(emitted).toContain("catch (e) {");
    expect(emitted).toContain("throw e;");
    expect(emitted).toContain("finally {");
    expect(emitted).toContain("return 0;");
  });

  it("omits ambient declare class/var statements from emitted JavaScript", () => {
    const program = parseFile(
      tokenizeReader("declare class Console { log(a: number) }\ndeclare var console: Console\nconsole.log(42)")
    );
    expect(emitProgram(program)).toBe("console.log(42);");
  });
});
