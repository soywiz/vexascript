import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { emitProgram, emitProgramStatements } from "./emitter";
import { lowerProgram } from "./lowering";
import { Analysis } from "compiler/analysis/Analysis";

describe("emitProgram", () => {
  it("lowers runtime namespaces to JavaScript objects and IIFEs", () => {
    const program = parseFile(tokenizeReader("namespace Tools { export const version = 1; export function read() { return version } }"));
    expect(emitProgram(program)).toBe([
      "var Tools;",
      "(function (Tools) {",
      "  const version = 1;",
      "  Tools.version = version;",
      "  function read() {\n  return version;\n  }",
      "  Tools.read = read;",
      "})(Tools || (Tools = {}));"
    ].join("\n"));
  });

  it("erases ambient namespaces after their bodies have been parsed", () => {
    const program = parseFile(tokenizeReader("declare namespace Tools {\nexport const version: string;\n}"), { language: "typescript" });
    expect(emitProgram(program)).toBe("");
  });

  it("erases additional ambient declarations, including exported declarations", () => {
    const program = parseFile(tokenizeReader(
      "declare type Id = string;\nexport declare const id: Id;\nexport declare function read(id: Id): string;\nexport declare abstract class Reader {}"
    ), { language: "typescript" });
    expect(emitProgram(program)).toBe("");
  });

  it("emits calls to classes as constructor invocations", () => {
    const program = parseFile(tokenizeReader("class Point(val x: int)\nlet point = Point(1)"));
    const ambientProgram = parseFile(tokenizeReader("declare class Error\nlet error = Error()"));

    expect(emitProgram(program)).toContain("let point = new Point(1);");
    expect(emitProgram(ambientProgram)).toBe("let error = new Error();");
  });

  it("emits constructor-only globals as constructor invocations across merged ambient interfaces", () => {
    const program = parseFile(tokenizeReader(dedent`
      declare interface MapConstructor {
        new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>
      }
      declare interface MapConstructor {
        groupBy<K, T>(items: Iterable<T>, keySelector: (item: T, index: number) => K): Map<K, T[]>
      }
      declare var Map: MapConstructor
      const counts = Map<string, number>([["one", 1]])
    `));

    expect(emitProgram(program)).toContain('const counts = new Map([["one", 1]]);');
  });

  it("emits namespace-imported class member calls as constructor invocations", () => {
    const program = parseFile(tokenizeReader(dedent`
      import * as THREE from "three"
      let renderer = THREE.WebGLRenderer()
    `));
    const contextProgram = parseFile(tokenizeReader(dedent`
      import * as THREE from "three"
      declare class WebGLRenderer {}
      let renderer = THREE.WebGLRenderer()
    `), { language: "typescript" });

    expect(emitProgramStatements(program, undefined, contextProgram).join("\n")).toContain(
      "let renderer = new THREE.WebGLRenderer();"
    );
  });

  it("emits extension property accessor blocks as getter and setter functions", () => {
    const program = parseFile(tokenizeReader(dedent`
      class Vec2(val x: number, val y: number)
      class View(val x: number, val y: number)
      var View.point: Vec2 {
        get => Vec2(x, y)
        set { x = newValue.x; y = newValue.y }
      }
      val view = View(1, 2)
      view.point = Vec2(3, 4)
      val point = view.point
    `));

    const output = emitProgram(program);
    expect(output).toContain("const View$$point = ($this) =>");
    expect(output).toContain("const View$$point$set = ($this, newValue) =>");
    expect(output).toContain("View$$point$set(view, new Vec2(3, 4));");
    expect(output).toContain("const point = View$$point(view);");
  });

  it("emits vexa for-in as for-of const", () => {
    const program = parseFile(tokenizeReader("for (n in [1,2,3]) console.log(n)"));
    expect(emitProgram(program)).toContain("for (const n of [1, 2, 3]) console.log(n);");
  });

  it("emits for await when asyncForStatements contains the loop", () => {
    const program = parseFile(tokenizeReader("for (n in iter) console.log(n)"));
    const forStmt = program.body[0]!;
    const asyncForStatements: ReadonlySet<object> = new Set([forStmt]);
    const output = emitProgramStatements(program, undefined, undefined, undefined, undefined, undefined, undefined, asyncForStatements as ReadonlySet<never>);
    expect(output.join("\n")).toContain("for await (const n of iter) console.log(n);");
  });

  it("keeps emitter focused on syntax emission without range-loop optimization", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    expect(emitProgram(program)).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n <= e; n++) yield n })(0, 10)) console.log(a);"
    );
  });

  it("keeps emitter focused on syntax emission for exclusive range-loop", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ..< 10) console.log(a)"));
    expect(emitProgram(program)).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 10)) console.log(a);"
    );
  });

  it("emits classic for loop after lowering an inclusive range-based for-of", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ... 10) console.log(a)"));
    expect(emitProgram(lowerProgram(program))).toContain("for (let a = 0; a <= 10; a++) console.log(a);");
  });

  it("emits classic for loop after lowering an exclusive range-based for-of", () => {
    const program = parseFile(tokenizeReader("for (a of 0 ..< 10) console.log(a)"));
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

  it("emits inclusive range expression outside for as generator", () => {
    const program = parseFile(tokenizeReader("let values = 0 ... 3"));
    expect(emitProgram(program)).toContain(
      "let values = (function*(s, e) { for (let n = s; n <= e; n++) yield n })(0, 3);"
    );
  });

  it("emits exclusive range expression outside for as generator", () => {
    const program = parseFile(tokenizeReader("let values = 0 ..< 3"));
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
let worker = async function* work(this: Loader) { yield await next() }
`));
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

  it("emits implicit returns for multi-statement brace lambdas", () => {
    const program = parseFile(tokenizeReader(`let values = [1,2,3].map {
  const doubled = it * 2
  doubled + 1
}`));
    const emitted = emitProgram(program);

    expect(emitted).toContain("let values = [1, 2, 3].map((it) => {");
    expect(emitted).toContain("const doubled = it * 2;");
    expect(emitted).toContain("return doubled + 1;");
  });

  it("emits sync functions and methods as async and strips the go operator", () => {
    const program = parseFile(tokenizeReader(`sync function load(id: string): int { return 1 }
sync fun fetchValue(): int { return 2 }
class Store { sync save(): int { return 3 } }
let arrow = sync () => { return 4 }
let expr = sync function(): int { return 5 }
let promise = go fetchValue()
`));
    const emitted = emitProgram(program);

    expect(emitted).toContain("async function load(id) {");
    expect(emitted).toContain("async function fetchValue() {");
    expect(emitted).toContain("async save() {");
    expect(emitted).toContain("let arrow = async () => {");
    expect(emitted).toContain("let expr = async function() {");
    // `go` is erased at emission: the underlying call is emitted untouched.
    expect(emitted).toContain("let promise = fetchValue();");
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

  it("emits async object method syntax", () => {
    const program = parseFile(tokenizeReader("let obj = {async load(url: string) { return await fetch(url) }}"));
    const emitted = emitProgram(program);

    expect(emitted).toContain("let obj = {async load(url) {");
    expect(emitted).toContain("return await fetch(url);");
  });

  it("erases type alias declarations", () => {
    const program = parseFile(tokenizeReader("type Name = string\nlet value: Name = \"Ada\""));
    expect(emitProgram(program)).toBe("let value = \"Ada\";");
  });

  it("erases TypeScript type assertions during emission", () => {
    expect(emitProgram(parseFile(tokenizeReader("let name = value as string")))).toBe("let name = value;");
    expect(emitProgram(parseFile(tokenizeReader("let name = <string>value", { jsx: false }), { language: "typescript" }))).toBe("let name = value;");
    expect(emitProgram(parseFile(tokenizeReader("let values = [1, 2] as const")))).toBe("let values = [1, 2];");
    expect(emitProgram(parseFile(tokenizeReader("let name = value!")))).toBe("let name = value;");
    expect(emitProgram(parseFile(tokenizeReader("let length = maybe!.name!.length")))).toBe("let length = maybe.name.length;");
  });

  it("erases declarations that use keyof, typeof, and indexed access types", () => {
    const source = dedent`
      type PersonName = Person["name"]
      let key: keyof Person = "name"
      let name: typeof key = key
      
`;

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

  it("emits computed class methods like [Symbol.asyncIterator]()", () => {
    const program = parseFile(tokenizeReader("class Stream {\nasync *[Symbol.asyncIterator](): AsyncGenerator<int> { yield 1 }\n}", { jsx: false }), { language: "typescript" });
    const emitted = emitProgram(program);
    expect(emitted).toContain("async *[Symbol.asyncIterator]() {");
    expect(emitted).toContain("yield 1;");
  });

  it("emits getter shorthand class members as JavaScript getters", () => {
    const program = parseFile(tokenizeReader("class Rect {\narea: number => this.width * this.height\n}"));
    const emitted = emitProgram(program);
    expect(emitted).toContain("get area() {");
    expect(emitted).toContain("return this.width * this.height;");
  });


  it("emits class delegate members without extending delegated interfaces", () => {
    const program = parseFile(tokenizeReader(dedent`
      interface Shape {
        area: number
        fill(color: string): string
      }
      class MyDemo(val shape: Shape) : Shape by { shape } {
      }
    `));

    const emitted = emitProgram(program);

    expect(emitted).toContain("class MyDemo {");
    expect(emitted).not.toContain("extends Shape");
    expect(emitted).toContain("get area() { return this.shape.area; }");
    expect(emitted).toContain("fill(color) { return this.shape.fill(color); }");
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
    expect(emitProgram(parseFile(tokenizeReader("export async fun load(): Promise<int> { return Promise.resolve(1) }"))))
      .toBe("export async function load() {\nreturn Promise.resolve(1);\n}");
    expect(emitProgram(parseFile(tokenizeReader("export sync fun loadSync(): int { return 1 }"))))
      .toBe("export async function loadSync() {\nreturn 1;\n}");
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

  it("can lower imports and exports to CommonJS while still erasing types", () => {
    const program = parseFile(tokenizeReader(dedent`
      import React, { useState as useLocalState } from "react"
      export const value: number = 1
      export { useLocalState as localState }
      export default React
    `));

    expect(emitProgram(program, undefined, undefined, undefined, { moduleFormat: "commonjs" })).toBe([
      'const __vexa_import_0 = require("react");',
      "const React = __vexa_import_0 && __vexa_import_0.__esModule ? __vexa_import_0.default : __vexa_import_0;",
      "const { useState: useLocalState } = __vexa_import_0;",
      "const value = 1;",
      "exports.value = value;",
      "exports.localState = useLocalState;",
      "exports.default = React;",
      "exports.__esModule = true;"
    ].join("\n"));
  });

  it("drops operator-overload import bindings while keeping the module load", () => {
    // Operator-only import becomes a side-effecting import so the prototype patch runs.
    expect(emitProgram(parseFile(tokenizeReader("import { operator+ } from \"./other\""))))
      .toBe("import \"./other\";");
    // Mixed imports keep their value bindings and drop the operator binding.
    expect(emitProgram(parseFile(tokenizeReader("import { Point, operator+ } from \"./other\""))))
      .toBe("import { Point } from \"./other\";");
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
      tokenizeReader("declare class Console { log(...a: number[]) }\ndeclare var console: Console\nconsole.log(42, 1)")
    );
    expect(emitProgram(program)).toBe("console.log(42, 1);");
  });


  it("emits constructor parameter properties as runtime assignments", () => {
    const program = parseFile(tokenizeReader("class User { constructor(public readonly id: string, private age = 0) { console.log(id) } }"));
    expect(emitProgram(program)).toBe("class User {\nconstructor(id, age = 0) {\nthis.id = id;\nthis.age = age;\nconsole.log(id);\n}\n}");
  });

  it("initializes derived-class parameter properties after super", () => {
    const program = parseFile(tokenizeReader("class Base {}\nclass Child extends Base { constructor(public id: string) {\n super()\n} }"));

    expect(emitProgram(program)).toContain("constructor(id) {\nsuper();\nthis.id = id;\n}");
  });

  it("emits static class members while omitting type-only class modifiers", () => {
    const emitted = emitProgram(parseFile(tokenizeReader(`class Demo {
  private static count: int = 0
  public readonly name: string
}
`)));

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

  it("preserves extends when a runtime base class name is also declared as an interface", () => {
    const program = parseFile(
      tokenizeReader(dedent`
        interface Component {
          render(): string
        }

        class Component {}

        class Clock extends Component {
          constructor() {
            super()
          }
        }
      `)
    );

    const emitted = emitProgram(program);

    expect(emitted).toContain("class Clock extends Component {");
    expect(emitted).toContain("super();");
  });

  it("emits TypeScript-style lambda and function expressions", () => {
    const program = parseFile(
      tokenizeReader(dedent`
        let a = [1,2,3,4].map(x => 10)
        let b = [1,2,3,4].map((it) => 10)
        let c = [1,2,3,4].map(function(it: number) { return 10 })
        let d = [1,2,3,4].map { it }
        let e = [1,2,3,4].map() { it }
        let f = [1,2,3,4].map { a: number, b: number, c: number -> a + b + c }
      `.trimEnd()
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

  it("emits function and method shorthand bodies as regular JavaScript returns", () => {
    const program = parseFile(tokenizeReader(dedent`
      fun double(value: int): int => value * 2
      class Point {
        operator*(other: Point): Point => Point(x * other.x, y * other.y)
      }
    `.trimEnd()));
    const emitted = emitProgram(program);

    expect(emitted).toContain("function double(value) {");
    expect(emitted).toContain("return value * 2;");
    expect(emitted).toContain("operator$star$$Point(other) {");
    expect(emitted).toContain("return new Point(x * other.x, y * other.y);");
  });

  it("emits overloaded index getter and setter calls", () => {
    const program = parseFile(tokenizeReader(dedent`
      class Bag {
        operator[](index: int): string => "item"
        operator[]=(value: string, index: int): void { }
      }
      class Grid {
        operator[](x: int, y: int): string => "cell"
        operator[]=(value: string, x: int, y: int): void { }
      }
      class MultiArray {
        operator[](...dimensions: int[]): string => "cell"
        operator[]=(value: string, ...dimensions: int[]): void { }
      }
      val bag = Bag()
      val item = bag[0]
      bag[1] = "next"
      val grid = Grid()
      val cell = grid[1, 2]
      grid[1, 2] = "wide"
      val multi = MultiArray()
      val wide = multi[1, 2, 3]
      multi[1, 2, 3] = "deep"
    `.trimEnd()));
    const analysis = new Analysis(program);
    const emitted = emitProgram(program, analysis.getExpressionTypes());

    expect(emitted).toContain("operator$get$$int(index) {");
    expect(emitted).toContain("operator$set$$string$$int(value, index) {");
    expect(emitted).toContain("operator$get$$int$$int(x, y) {");
    expect(emitted).toContain("operator$set$$string$$int$$int(value, x, y) {");
    expect(emitted).toContain("operator$get$$rest$int(...dimensions) {");
    expect(emitted).toContain("operator$set$$string$$rest$int(value, ...dimensions) {");
    expect(emitted).toContain("const item = bag.operator$get$$int(0);");
    expect(emitted).toContain('bag.operator$set$$string$$int("next", 1);');
    expect(emitted).toContain("const cell = grid.operator$get$$int$$int(1, 2);");
    expect(emitted).toContain('grid.operator$set$$string$$int$$int("wide", 1, 2);');
    expect(emitted).toContain("const wide = multi.operator$get$$rest$int(1, 2, 3);");
    expect(emitted).toContain('multi.operator$set$$string$$rest$int("deep", 1, 2, 3);');
  });

  it("emits optional call, optional element access, spread expressions, and rest parameters", () => {
    const program = parseFile(tokenizeReader(dedent`
      fun collect(...values: int[]) { return values }
      let result = fn?.(...values)
      let item = result?.[0]
    `.trimEnd()));
    const emitted = emitProgram(program);

    expect(emitted).toContain("function collect(...values) {");
    expect(emitted).toContain("let result = fn?.(...values);");
    expect(emitted).toContain("let item = result?.[0];");
  });

  it("rewrites optional-chain assignments into a guarded expression", () => {
    const program = parseFile(tokenizeReader("result?.style?.background = 'grey'"));
    const emitted = emitProgram(program);

    expect(emitted).toContain("let $$temp_0;");
    expect(emitted).toContain("($$temp_0 = result?.style, $$temp_0 != null ? $$temp_0.background = \"grey\" : undefined);");
  });

  it("emits object and array destructuring declarations", () => {
    const program = parseFile(tokenizeReader("let { id, name :: displayName, nested :: { value = 1 }, ...rest } = source\nconst [first, , third = 3, ...tail] = values"));

    expect(emitProgram(program)).toBe(dedent`
      let { id, name: displayName, nested: { value = 1 }, ...rest } = source;
      const [first, , third = 3, ...tail] = values;
    `.trimEnd());
    expect(emitProgram(parseFile(tokenizeReader("let [first, ,] = values")))).toBe("let [first, ,] = values;");
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

describe("emit destructured parameters", () => {
  it("preserves object, array, nested, default, and rest parameter patterns", () => {
    const program = parseFile(tokenizeReader("function unpack({ id, nested :: { value = 1 }, ...meta }, [first, , ...tail] = values) { return value }"));
    expect(emitProgram(program)).toBe("function unpack({ id, nested: { value = 1 }, ...meta }, [first, , ...tail] = values) {\nreturn value;\n}");
  });
});

describe("emit embedded XML / JSX", () => {
  function emit(src: string): string {
    return emitProgram(parseFile(tokenizeReader(src, { jsx: true }), { language: "vexa" }));
  }

  it("emits intrinsic elements with attributes and children via React.createElement", () => {
    expect(emit('val a = <div class="x" id={y}>hi {name}</div>')).toBe(
      'const a = React.createElement("div", { class: "x", id: y }, "hi ", name);'
    );
  });

  it("emits component and dotted tags as references and spreads/boolean attributes", () => {
    expect(emit("val b = <Foo.Bar a={1} disabled {...rest}><Baz/></Foo.Bar>")).toBe(
      "const b = React.createElement(Foo.Bar, { a: 1, disabled: true, ...rest }, React.createElement(Baz, null));"
    );
  });

  it("emits fragments and quotes non-identifier attribute names", () => {
    expect(emit('val c = <><input data-id="5" /></>')).toBe(
      'const c = React.createElement(React.Fragment, null, React.createElement("input", { "data-id": "5" }));'
    );
  });

  it("honors a configurable jsxFactory and jsxFragmentFactory", () => {
    const ast = parseFile(tokenizeReader("val d = <><span/></>", { jsx: true }), { language: "vexa" });
    expect(emitProgram(ast, undefined, undefined, undefined, { jsxFactory: "h", jsxFragmentFactory: "Fragment" })).toBe(
      'const d = h(Fragment, null, h("span", null));'
    );
  });

  it("restores the previous emit context after an emission completes", () => {
    const jsxAst = () => parseFile(tokenizeReader("val d = <><span/></>", { jsx: true }), { language: "vexa" });

    expect(emitProgram(jsxAst(), undefined, undefined, undefined, { jsxFactory: "h", jsxFragmentFactory: "Fragment" })).toBe(
      'const d = h(Fragment, null, h("span", null));'
    );

    // A later emission without options must not observe the factories (or any
    // other per-emission state) configured by the previous call.
    expect(emitProgram(jsxAst())).toBe(
      'const d = React.createElement(React.Fragment, null, React.createElement("span", null));'
    );
  });
});
