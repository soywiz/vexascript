import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { emitProgram } from "./emitter";
import { lowerProgram } from "./lowering";

describe("emitProgram", () => {
  it("emits mylang for-in as for-of const", () => {
    const program = parseFile(tokenizeReader("for (n in [1,2,3]) console.log(n)"));
    expect(emitProgram(program)).toContain("for (const n of [1, 2, 3]) console.log(n);");
  });

  it("keeps emitter focused on syntax emission without range-loop optimization", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    expect(emitProgram(program)).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 10)) console.log(a);"
    );
  });

  it("emits classic for loop after lowering a range-based for-of", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    expect(emitProgram(lowerProgram(program))).toContain("for (let a = 0; a < 10; a++) console.log(a);");
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

  it("emits ternary, nullish coalescing, relational keywords, and unary word operators", () => {
    const program = parseFile(
      tokenizeReader("let a = cond ? left : right\nlet b = x ?? y\nlet c = item in obj\nlet d = v instanceof Point\nlet e = typeof a\nlet f = void a\nlet g = delete obj.key\nlet h = await promise")
    );
    const emitted = emitProgram(program);
    expect(emitted).toContain("let a = cond ? left : right;");
    expect(emitted).toContain("let b = x ?? y;");
    expect(emitted).toContain("let c = item in obj;");
    expect(emitted).toContain("let d = v instanceof Point;");
    expect(emitted).toContain("let e = typeof a;");
    expect(emitted).toContain("let f = void a;");
    expect(emitted).toContain("let g = delete obj.key;");
    expect(emitted).toContain("let h = await promise;");
  });

  it("emits boolean, null, and undefined literal nodes", () => {
    const program = parseFile(tokenizeReader("let t = true\nlet f = false\nlet n = null\nlet u = undefined"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("let t = true;");
    expect(emitted).toContain("let f = false;");
    expect(emitted).toContain("let n = null;");
    expect(emitted).toContain("let u = undefined;");
  });

  it("erases type alias declarations", () => {
    const program = parseFile(tokenizeReader("type Name = string\nlet value: Name = \"Ada\""));
    expect(emitProgram(program)).toBe("let value = \"Ada\";");
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


  it("emits static class members while omitting type-only class modifiers", () => {
    const emitted = emitProgram(parseFile(tokenizeReader(`class Demo {
  private static count: int = 0
  public readonly name: string
}`)));

    expect(emitted).toContain("static count = 0;");
    expect(emitted).toContain("name;");
    expect(emitted).not.toContain("private");
    expect(emitted).not.toContain("readonly");
  });

  it("emits class extends and omits interface statements", () => {
    const program = parseFile(
      tokenizeReader("interface Readable<T> { value: T }\nclass Box<T> extends Base<T> implements Readable<T> { value: T }")
    );
    const emitted = emitProgram(program);
    expect(emitted).toContain("class Box extends Base {");
    expect(emitted.includes("interface Readable")).toBe(false);
  });

  it("emits TypeScript-style lambda and function expressions", () => {
    const program = parseFile(
      tokenizeReader(
        "let a = [1,2,3,4].map(x => 10)\n" +
        "let b = [1,2,3,4].map((it) => 10)\n" +
        "let c = [1,2,3,4].map(function(it: number) { return 10 })\n" +
        "let d = [1,2,3,4].map { it }\n" +
        "let e = [1,2,3,4].map() { it }\n" +
        "let f = [1,2,3,4].map { a: number, b: number, c: number -> a + b + c }"
      )
    );
    const emitted = emitProgram(program);
    expect(emitted).toContain("let a = [1, 2, 3, 4].map((x) => 10);");
    expect(emitted).toContain("let b = [1, 2, 3, 4].map((it) => 10);");
    expect(emitted).toContain("let c = [1, 2, 3, 4].map(function(it) {");
    expect(emitted).toContain("return 10;");
    expect(emitted).toContain("let d = [1, 2, 3, 4].map((it) => it);");
    expect(emitted).toContain("let e = [1, 2, 3, 4].map((it) => it);");
    expect(emitted).toContain("let f = [1, 2, 3, 4].map((a, b, c) => a + b + c);");
  });
  it("emits optional call, optional element access, spread expressions, and rest parameters", () => {
    const program = parseFile(tokenizeReader(
      "fun collect(...values: int[]) { return values }\n" +
      "let result = fn?.(...values)\n" +
      "let item = result?.[0]"
    ));
    const emitted = emitProgram(program);

    expect(emitted).toContain("function collect(...values) {");
    expect(emitted).toContain("let result = fn?.(...values);");
    expect(emitted).toContain("let item = result?.[0];");
  });

});
