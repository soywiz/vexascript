import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { emitProgram } from "./emitter";
import { lowerProgram } from "./lowering";

describe("emitProgram", () => {
  it("emits calls to classes as constructor invocations", () => {
    const program = parseFile(tokenizeReader("class Point(val x: int)\nlet point = Point(1)"));
    const ambientProgram = parseFile(tokenizeReader("declare class Error\nlet error = Error()"));

    expect(emitProgram(program)).toContain("let point = new Point(1);");
    expect(emitProgram(ambientProgram)).toBe("let error = new Error();");
  });

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

  it("emits with statements and statement labels", () => {
    const program = parseFile(tokenizeReader("outer: while (ok) { with (scope) { break outer }; continue outer }"));
    expect(emitProgram(program)).toBe("outer: while (ok) {\nwith (scope) {\nbreak outer;\n}\ncontinue outer;\n}");
  });

  it("emits comma expressions, debugger statements, and empty statements", () => {
    const program = parseFile(tokenizeReader("let value = (setA(), setB())\ndebugger\nwhile (value);"));
    expect(emitProgram(program)).toBe("let value = (setA(), setB());\ndebugger;\nwhile (value) ;");
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

  it("emits async functions, generators, yield, and erases this parameters", () => {
    const program = parseFile(tokenizeReader(`async function load(this: Loader, id: string) { return await fetch(id) }
function* ids() { yield 1; yield* more }
class Store { async save(this: Store) { return await persist(this) }; *values() { yield 1 } }
let worker = async function* work(this: Loader) { yield await next() }`));
    const emitted = emitProgram(program);

    expect(emitted).toContain("async function load(id) {");
    expect(emitted).toContain("return await fetch(id);");
    expect(emitted).toContain("function* ids() {");
    expect(emitted).toContain("yield 1;");
    expect(emitted).toContain("yield* more;");
    expect(emitted).toContain("async save() {");
    expect(emitted).toContain("*values() {");
    expect(emitted).toContain("let worker = async function* work() {");
  });

  it("emits regular expression literals and sparse arrays", () => {
    const program = parseFile(tokenizeReader("let re = /a\\/b+/gi\nlet values = [1, , 3]"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("let re = /a\\/b+/gi;");
    expect(emitted).toContain("let values = [1, , 3];");
  });

  it("emits boolean, null, and undefined literal nodes", () => {
    const program = parseFile(tokenizeReader("let t = true\nlet f = false\nlet n = null\nlet u = undefined"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("let t = true;");
    expect(emitted).toContain("let f = false;");
    expect(emitted).toContain("let n = null;");
    expect(emitted).toContain("let u = undefined;");
  });

  it("emits object shorthand, spread, computed, and literal keys", () => {
    const program = parseFile(tokenizeReader("let obj = {a, ...base, [key]: value, \"display name\": name, 1: one}"));
    expect(emitProgram(program)).toContain('let obj = {a, ...base, [key]: value, "display name": name, 1: one};');
  });

  it("emits object method syntax and normalized numeric literals", () => {
    const program = parseFile(tokenizeReader("let obj = {add(a: number, b: number): number { return a + b }, [name]() { return 0xff }}\nlet count = 1_000"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("let obj = {add(a, b) {");
    expect(emitted).toContain("return a + b;");
    expect(emitted).toContain("[name]() {");
    expect(emitted).toContain("return 255;");
    expect(emitted).toContain("let count = 1000;");
  });

  it("erases type alias declarations", () => {
    const program = parseFile(tokenizeReader("type Name = string\nlet value: Name = \"Ada\""));
    expect(emitProgram(program)).toBe("let value = \"Ada\";");
  });

  it("erases TypeScript type assertions during emission", () => {
    expect(emitProgram(parseFile(tokenizeReader("let name = value as string")))).toBe("let name = value;");
    expect(emitProgram(parseFile(tokenizeReader("let name = <string>value")))).toBe("let name = value;");
    expect(emitProgram(parseFile(tokenizeReader("let values = [1, 2] as const")))).toBe("let values = [1, 2];");
  });

  it("erases declarations that use keyof, typeof, and indexed access types", () => {
    const source =
      "type PersonName = Person[\"name\"]\n" +
      "let key: keyof Person = \"name\"\n" +
      "let name: typeof key = key\n";

    expect(emitProgram(parseFile(tokenizeReader(source)))).toBe(
      "let key = \"name\";\nlet name = key;"
    );
  });

  it("emits class get and set accessors", () => {
    const program = parseFile(tokenizeReader("class Box {\nget value(): string { return this.raw }\nset value(next: string) { this.raw = next }\n}"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("get value() {");
    expect(emitted).toContain("set value(next) {");
  });


  it("emits value exports and erases type-only exports", () => {
    expect(emitProgram(parseFile(tokenizeReader("export const value: number = 1"))))
      .toBe("export const value = 1;");
    expect(emitProgram(parseFile(tokenizeReader("export default value"))))
      .toBe("export default value;");
    expect(emitProgram(parseFile(tokenizeReader("export { value as renamed } from \"./mod\""))))
      .toBe("export { value as renamed } from \"./mod\";");
    expect(emitProgram(parseFile(tokenizeReader("export * from \"./all\""))))
      .toBe("export * from \"./all\";");
    expect(emitProgram(parseFile(tokenizeReader("export type { Name } from \"./types\""))))
      .toBe("");
    expect(emitProgram(parseFile(tokenizeReader("export type Name = string"))))
      .toBe("");
    expect(emitProgram(parseFile(tokenizeReader("export as namespace MyLib"))))
      .toBe("");
  });

  it("emits named import statements", () => {
    const program = parseFile(tokenizeReader("import { Point } from \"./a\""));
    expect(emitProgram(program)).toBe("import { Point } from \"./a\";");
  });

  it("emits expanded import forms and erases type-only imports", () => {
    expect(emitProgram(parseFile(tokenizeReader("import React from \"react\""))))
      .toBe("import React from \"react\";");
    expect(emitProgram(parseFile(tokenizeReader("import React, { useState as useLocalState } from \"react\""))))
      .toBe("import React, { useState as useLocalState } from \"react\";");
    expect(emitProgram(parseFile(tokenizeReader("import * as fs from \"fs\""))))
      .toBe("import * as fs from \"fs\";");
    expect(emitProgram(parseFile(tokenizeReader("import \"./setup\""))))
      .toBe("import \"./setup\";");
    expect(emitProgram(parseFile(tokenizeReader("import type { Point } from \"./a\""))))
      .toBe("");
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


describe("emit enum declarations", () => {
  it("emits runtime objects for numeric and string enum members", () => {
    const program = parseFile(tokenizeReader('enum Direction { Up, Down = 4, Left, Right = "right" }'));
    expect(emitProgram(program)).toBe(
      'var Direction;\n' +
        '(function (Direction) {\n' +
        '  Direction[Direction["Up"] = 0] = "Up";\n' +
        '  Direction[Direction["Down"] = 4] = "Down";\n' +
        '  Direction[Direction["Left"] = 5] = "Left";\n' +
        '  Direction["Right"] = "right";\n' +
        '})(Direction || (Direction = {}));'
    );
  });

  it("omits ambient enum declarations", () => {
    const program = parseFile(tokenizeReader('declare enum External { Value }'));
    expect(emitProgram(program)).toBe("");
  });
});
