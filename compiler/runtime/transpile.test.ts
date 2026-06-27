import { describe, expect, it } from "../test/expect";
import { transpile } from "./transpile";
import { compileSource } from "compiler/pipeline/compile";

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let index = 0;

  while (index < segment.length) {
    let result = 0;
    let shift = 0;
    let continuation = true;

    while (continuation && index < segment.length) {
      const char = segment[index] ?? "";
      index += 1;
      const digit = BASE64_DIGITS.indexOf(char);
      if (digit < 0) {
        throw new Error(`Invalid VLQ digit '${char}'`);
      }
      continuation = (digit & 32) !== 0;
      const payload = digit & 31;
      result += payload << shift;
      shift += 5;
    }

    const isNegative = (result & 1) === 1;
    const value = result >> 1;
    values.push(isNegative ? -value : value);
  }

  return values;
}

function decodeSourceLinesFromMappings(mappings: string): number[] {
  const lines = mappings.split(";");
  const sourceLines: number[] = [];
  let previousSourceLine = 0;

  for (const line of lines) {
    if (line.length === 0) {
      sourceLines.push(previousSourceLine);
      continue;
    }
    const firstSegment = line.split(",")[0] ?? "";
    const decoded = decodeVlqSegment(firstSegment);
    const sourceLineDelta = decoded[2] ?? 0;
    previousSourceLine += sourceLineDelta;
    sourceLines.push(previousSourceLine);
  }

  return sourceLines;
}

describe("transpile", () => {
  it("returns a source map for successful transpilation", () => {
    const source = "let value = 1\nlet doubled = value * 2";
    const result = transpile(source, {
      sourceFilePath: "/tmp/demo.vx",
      outputFilePath: "/tmp/demo.js"
    });

    expect(result.errors).toEqual([]);
    expect(result.sourceMap).toBeDefined();
    const sourceMap = JSON.parse(result.sourceMap ?? "{}") as {
      version: number;
      file: string;
      sources: string[];
      sourcesContent: string[];
      mappings: string;
    };
    expect(sourceMap.version).toBe(3);
    expect(sourceMap.file).toBe("demo.js");
    expect(sourceMap.sources).toEqual(["demo.vx"]);
    expect(sourceMap.sourcesContent).toEqual([source]);
    expect(sourceMap.mappings.length).toBeGreaterThan(0);
  });

  it("can skip source map generation for internal hot paths", () => {
    const result = transpile("let value = 1\nvalue += 2\n", {
      emitSourceMap: false
    });

    expect(result.errors).toEqual([]);
    expect(result.sourceMap).toBe(undefined);
    expect(result.code).toContain("let value = 1;");
  });

  it("rewrites vexa for-in loops to JavaScript for-of with const iterator", () => {
    const source = [
      "declare class Console {",
      "  log(a: number)",
      "}",
      "declare var console: Console",
      "for (n in [1,2, 3]) {",
      "  console.log(n)",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (const n of [1, 2, 3]) {");
    expect(result.code).toContain("console.log(n)");
  });

  it("optimizes inclusive range iteration inside for loops to a classic for loop", () => {
    const source = "for (a of 0 ... 10) console.log(a)";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (let a = 0; a <= 10; a++) console.log(a)");
  });

  it("optimizes exclusive range iteration inside for loops to a classic for loop", () => {
    const source = "for (a of 0 ..< 10) console.log(a)";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (let a = 0; a < 10; a++) console.log(a)");
  });

  it("supports conservative target mode without lowering optimizations", () => {
    const source = "for (a of 0 ..< 3) console.log(a)";

    const conservative = transpile(source, { target: "conservative" });
    const optimized = transpile(source, { target: "optimized" });

    expect(conservative.errors).toEqual([]);
    expect(optimized.errors).toEqual([]);
    expect(conservative.code).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 3)) console.log(a);"
    );
    expect(optimized.code).toContain("for (let a = 0; a < 3; a++) console.log(a);");
  });

  it("emits generator-based inclusive range expression outside for loops", () => {
    const source = "let values = 0 ... 10";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "let values = (function*(s, e) { for (let n = s; n <= e; n++) yield n })(0, 10);"
    );
  });

  it("emits generator-based exclusive range expression outside for loops", () => {
    const source = "let values = 0 ..< 10";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "let values = (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 10);"
    );
  });

  it("wraps long arithmetic with BigInt.asIntN(64, ...)", () => {
    const source = "let a: long = 10L\nlet b: long = 20L\nlet c = a + b";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let a = 10n;");
    expect(result.code).toContain("let b = 20n;");
    expect(result.code).toContain("let c = BigInt.asIntN(64, a + b);");
  });

  it("supports template literals with interpolation", () => {
    const source = "let name = \"world\"\nlet msg = `hello ${name}`";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let msg = \"hello \" + name + \"\";");
  });

  it("preserves class-call instantiation when preserving source line offsets", () => {
    const source = "class Point(val x: int)\n\nlet point = Point(1)";

    const result = transpile(source, { preserveSourceLineOffsets: true });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let point = new Point(1);");
  });

  it("emits constructor-only runtime globals with new when they are called", () => {
    const source = "const bytes = Uint8Array(7)\nconsole.log(bytes.length)";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const bytes = new Uint8Array(7);");
  });

  it("preserves callable runtime constructors without forced new", () => {
    const source = "const flag = Boolean(0)";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const flag = Boolean(0);");
  });

  it("emits TypeScript private fields and accesses", () => {
    const source = [
      "class Counter {",
      "  #value = 1",
      "  read(): int { return this.#value }",
      "}",
      "const counter = Counter()",
      "counter.read()"
    ].join("\n");

    const result = transpile(source, { target: "conservative", parserOptions: { language: "typescript" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("#value = 1;");
    expect(result.code).toContain("return this.#value;");
  });

  it("accepts globalThis assertions with intersection object types", () => {
    const source = "const host = globalThis as typeof globalThis & { document?: { createElement(tagName: string): string } }";

    const result = transpile(source, {
      target: "conservative",
      parserOptions: { language: "typescript" }
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const host = globalThis;");
  });

  it("maps emitted lines to original source lines when declarations are omitted", () => {
    const source = [
      "declare class Console {",
      "  log(a: number)",
      "}",
      "",
      "declare var console: Console",
      "",
      "console.log(42)",
      "",
      "declare class Error",
      "",
      "try {",
      "  throw new Error();",
      "} catch (e) {",
      "  console.log(e);",
      "}"
    ].join("\n");

    const result = transpile(source, {
      sourceFilePath: "/tmp/sample.vx",
      outputFilePath: "/tmp/sample.js",
      target: "conservative"
    });
    expect(result.errors).toEqual([]);
    expect(result.sourceMap).toBeDefined();

    const sourceMap = JSON.parse(result.sourceMap ?? "{}") as { mappings: string };
    const mappedSourceLines = decodeSourceLinesFromMappings(sourceMap.mappings);
    const emittedLines = result.code.split("\n");
    const throwLine = emittedLines.findIndex((line) => line.includes("throw new Error()"));

    expect(mappedSourceLines[0]).toBe(6); // console.log(42) source line (0-based)
    expect(throwLine).toBeGreaterThanOrEqual(0);
    expect(mappedSourceLines[throwLine]).toBe(11); // throw new Error() source line (0-based)
  });

  it("can preserve source line offsets in emitted runtime code", () => {
    const source = [
      "declare class Console {",
      "  log(a: number)",
      "}",
      "",
      "declare var console: Console",
      "",
      "declare class Error",
      "",
      "console.log(42)",
      "",
      "try {",
      "  throw new Error();",
      "} catch (e) {",
      "  console.log(e)",
      "}"
    ].join("\n");

    const result = transpile(source, {
      target: "conservative",
      preserveSourceLineOffsets: true
    });
    expect(result.errors).toEqual([]);

    const emittedLines = result.code.split("\n");
    const throwLine = emittedLines.findIndex((line) => line.includes("throw new Error()"));
    expect(throwLine).toBe(11); // 0-based line alignment with source
  });

  it("lowers defer to try/finally over the rest of the block", () => {
    const source = [
      "declare function open(): File",
      "declare class File {",
      "  close()",
      "  read(): string",
      "}",
      "fun readFile(): string {",
      "  val file = open()",
      "  defer file.close()",
      "  return file.read()",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const file = open();");
    expect(result.code).toContain("try {");
    expect(result.code).toContain("return file.read();");
    expect(result.code).toContain("finally {");
    expect(result.code).toContain("file.close();");
  });

  it("runs multiple defers in reverse order", () => {
    const source = [
      "declare class Console {",
      "  log(value: string)",
      "}",
      "declare var console: Console",
      "fun demo(): void {",
      "  defer console.log(\"first\")",
      "  defer console.log(\"second\")",
      "  return",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    const secondIndex = result.code.indexOf("console.log(\"second\")");
    const firstIndex = result.code.indexOf("console.log(\"first\")");
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeLessThan(firstIndex);
  });


  it("auto-awaits Promise-typed statements inside sync functions", () => {
    const source = [
      "sync fun fetchValue(): int { return 1 }",
      "sync fun main(): int {",
      "  let x = fetchValue()",
      "  x = fetchValue()",
      "  fetchValue()",
      "  return x + 10",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // sync functions are emitted as async functions.
    expect(result.code).toContain("async function fetchValue() {");
    expect(result.code).toContain("async function main() {");
    // Promise-typed initializers, assignments and expression statements are awaited automatically.
    expect(result.code).toContain("let x = await fetchValue();");
    expect(result.code).toContain("x = await fetchValue();");
    expect(result.code).toContain("await fetchValue();");
    // The auto-awaited value is observed as the unwrapped type, so arithmetic type-checks.
    expect(result.code).toContain("return x + 10;");
  });

  it("auto-awaits Promise-typed subexpressions anywhere inside sync functions", () => {
    const source = [
      "declare function use(a: int, b: int): void",
      "declare function add(a: int, b: int): int",
      "sync fun fetchValue(): int { return 1 }",
      "sync fun main(): void {",
      "  use(fetchValue(), fetchValue())",
      "  let total = fetchValue() + add(fetchValue(), 2)",
      "  let arr = [fetchValue(), 3]",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // Call arguments, operands, nested calls and array elements are all awaited.
    expect(result.code).toContain("use(await fetchValue(), await fetchValue());");
    expect(result.code).toContain("let total = await fetchValue() + add(await fetchValue(), 2);");
    expect(result.code).toContain("let arr = [await fetchValue(), 3];");
  });

  it("auto-awaits a Promise receiver before a member call but not for then/catch/finally", () => {
    const source = [
      "class Box { value(): int { return 1 } }",
      "sync fun fetchBox(): Box { return Box() }",
      "sync fun fetchValue(): int { return 1 }",
      "declare function use(v: int): void",
      "sync fun main(): void {",
      "  let v = fetchBox().value()",
      "  fetchValue().then(use)",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // Calling a method of the resolved value awaits the receiver first.
    expect(result.code).toContain("let v = (await fetchBox()).value();");
    // Accessing `.then` keeps the Promise: the receiver is not awaited.
    expect(result.code).toContain("fetchValue().then(use);");
  });

  it("suppresses auto-await with the go operator and only auto-awaits inside sync functions", () => {
    const source = [
      "declare function use(p: Promise<int>): void",
      "sync fun fetchValue(): int { return 1 }",
      "sync fun main(): void {",
      "  let p: Promise<int> = go fetchValue()",
      "  go fetchValue()",
      "  use(go fetchValue())",
      "  let nested = () => { let r = fetchValue() }",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // `go` keeps the Promise, so no await is emitted, including inside call arguments.
    expect(result.code).toContain("let p = fetchValue();");
    expect(result.code).toContain("use(fetchValue());");
    expect(result.code).not.toContain("await fetchValue()");
    // Nested plain (non-async-like) functions do not auto-await.
    expect(result.code).toContain("let r = fetchValue();");
  });

  it("does not auto-await inside async functions (async behaves like TypeScript)", () => {
    const source = [
      "async fun fetchValue(): Promise<int> { return 1 }",
      "async fun main(): Promise<void> {",
      "  let x = fetchValue()",
      "  fetchValue()",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // Auto-await is a `sync`-only feature; `async` requires explicit `await`, so no implicit
    // `await` is inserted here.
    expect(result.code).toContain("let x = fetchValue();");
    expect(result.code).not.toContain("await fetchValue()");
  });

  it("does not auto-await bare local variable or parameter references", () => {
    const source = [
      "async fun demo2(): Promise<int> { return 10 }",
      "sync fun demo(): void {",
      "  let stored = go demo2()",
      "  let alias = stored",
      "  let inline = demo2()",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // A Promise produced inline by a call is awaited.
    expect(result.code).toContain("let inline = await demo2();");
    // A Promise stored in a local variable keeps its Promise type: references are not awaited.
    expect(result.code).toContain("let stored = demo2();");
    expect(result.code).toContain("let alias = stored;");
  });

  it("mangles overloaded function implementations and rewrites typed calls", () => {
    const source = [
      "function describe(value: int): string { return \"int\" }",
      "function describe(value: string): string { return value }",
      "let a = describe(1)",
      "let b = describe(\"x\")"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("function describe$$int(value) {");
    expect(result.code).toContain("function describe$$string(value) {");
    expect(result.code).toContain("let a = describe$$int(1);");
    expect(result.code).toContain('let b = describe$$string("x");');
  });

  it("emits operator overload methods and lowers matching binary expressions", () => {
    const source = [
      "class Point(val x: number, val y: number) {",
      "  operator+(other: Point): Point { return new Point(this.x + other.x, this.y + other.y) }",
      "}",
      "let a = new Point(1, 2)",
      "let b = new Point(3, 4)",
      "let c = a + b"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("operator$plus$$Point(other) {");
    expect(result.code).toContain("let c = a.operator$plus$$Point(b);");
  });

  it("lowers compound assignments through matching operator overloads", () => {
    const source = [
      "class Point(val x: number, val y: number) {",
      "  operator+(other: Point): Point { return new Point(this.x + other.x, this.y + other.y) }",
      "}",
      "class View(var position: Point)",
      "let view = new View(new Point(1, 2))",
      "view.position += new Point(3, 4)"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("view.position = view.position.operator$plus$$Point(new Point(3, 4));");
  });

  it("does not route concrete member properties through mismatched extension properties", () => {
    const source = [
      "class Duration(val ms: number) {",
      "  val seconds => ms / 1000",
      "}",
      "val number.seconds => Duration(this * 1000)",
      "fun scale(delta: Duration): number => delta.seconds"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("return delta.seconds;");
    expect(result.code).toContain("const number$$seconds = ($this) => new Duration($this * 1000);");
  });

  it("lowers unary operator overloads before surrounding binary expressions", () => {
    const source = [
      "class Point(val x: number, val y: number) {",
      "  operator+(): Point { return this }",
      "  operator-(): Point { return new Point(-this.x, -this.y) }",
      "  operator+(other: Point): Point { return new Point(this.x + other.x, this.y + other.y) }",
      "  operator*(scale: number): Point { return new Point(this.x * scale, this.y * scale) }",
      "}",
      "console.log(-Point(1, 2) + (Point(3, 4) * 2))"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "console.log(new Point(1, 2).operator$minus$$void().operator$plus$$Point(new Point(3, 4).operator$star$$number(2)));"
    );
  });

  it("emits extension operator methods and lowers matching binary expressions", () => {
    const source = [
      "class Point(val x: number, val y: number) {}",
      "fun Point.operator+(other: Point): Point { return new Point(this.x + other.x, this.y + other.y) }",
      "let a = new Point(1, 2)",
      "let b = new Point(3, 4)",
      "let c: Point = a + b"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    // Extension operators are emitted as standalone receiver-mangled functions
    // whose first parameter is the receiver, and binary expressions lower to a
    // plain call rather than a prototype method call.
    expect(result.code).toContain("function Point$$operator$plus$$Point($this, other) {");
    expect(result.code).toContain("return new Point($this.x + other.x, $this.y + other.y);");
    expect(result.code).toContain("let c = Point$$operator$plus$$Point(a, b);");
  });

  it("resolves cross-file classes and operators from externalDeclarations", () => {
    const declarationSource = [
      "class Point(val x: number, val y: number) {}",
      "fun Point.operator+(other: Point): Point => Point(x + other.x, y + other.y)"
    ].join("\n");
    const externalDeclarations = compileSource(declarationSource).ast!.body;

    const source = [
      'import { Point, operator+ } from "./other"',
      "const sum = Point(1, 2) + Point(3, 4)"
    ].join("\n");

    const result = transpile(source, { target: "conservative", externalDeclarations });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "const sum = Point$$operator$plus$$Point(new Point(1, 2), new Point(3, 4));"
    );
  });

  it("rewrites cross-file extension operator imports to emitted runtime names", () => {
    const declarationSource = [
      "export class Point(val x: number, val y: number)",
      "export fun Point.operator+(other: Point): Point => Point(x + other.x, y + other.y)"
    ].join("\n");
    const externalDeclarations = compileSource(declarationSource).ast!.body;

    const source = [
      'import { Point, operator+ } from "./other"',
      "const sum = Point(1, 2) + Point(3, 4)"
    ].join("\n");

    const result = transpile(source, { target: "conservative", externalDeclarations });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { Point, Point$$operator$plus$$Point } from "./other";');
    expect(result.code).toContain(
      "const sum = Point$$operator$plus$$Point(new Point(1, 2), new Point(3, 4));"
    );
  });

  it("rewrites cross-file extension method imports to emitted runtime names", () => {
    const declarationSource = [
      "export class Point(val x: number, val y: number)",
      "export fun Point.distanceTo(other: Point): number => x - other.x + (y - other.y)"
    ].join("\n");
    const externalDeclarations = compileSource(declarationSource).ast!.body;

    const source = [
      'import { Point, distanceTo } from "./other"',
      "const distance = Point(1, 2).distanceTo(Point(3, 4))"
    ].join("\n");

    const result = transpile(source, { target: "conservative", externalDeclarations });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { Point, Point$$distanceTo$$Point } from "./other";');
    expect(result.code).toContain(
      "const distance = Point$$distanceTo$$Point(new Point(1, 2), new Point(3, 4));"
    );
  });

  it("rewrites imported overloaded function calls to their runtime-mangled bindings", () => {
    const declarationSource = [
      "export function describe(value: int): string { return `int:${value}` }",
      "export function describe(value: string): string { return `string:${value}` }"
    ].join("\n");
    const externalDeclarations = compileSource(declarationSource).ast!.body;

    const source = [
      'import { describe } from "./other"',
      'const values = `${describe(4)}:${describe("x")}`'
    ].join("\n");

    const result = transpile(source, { target: "conservative", externalDeclarations });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { describe$$int, describe$$string } from "./other";');
    expect(result.code).toContain('const values = "" + describe$$int(4) + ":" + describe$$string("x") + "";');
  });

  it("calls other extension methods on the same receiver type without this.", () => {
    const source = `class Counter(val value: int) {}
fun Counter.doubled(): int { return value + value }
fun Counter.tripled(): int { return doubled() + value }`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("function Counter$$doubled$$void($this) {");
    expect(result.code).toContain("return $this.value + $this.value;");
    expect(result.code).toContain("function Counter$$tripled$$void($this) {");
    expect(result.code).toContain("Counter$$doubled$$void($this)");
  });

  it("qualifies inherited interface methods without this. in extension functions", () => {
    const source = `interface Base {
  baseMethod(): void
  baseProp: number
}
interface Child extends Base {
  childMethod(): void
}
fun Child.myExtension(): void {
  baseMethod()
  childMethod()
  val x = baseProp
}`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("this.baseMethod()");
    expect(result.code).toContain("this.childMethod()");
    expect(result.code).toContain("this.baseProp");
  });

  it("qualifies unqualified class and extension members with their receiver", () => {
    const source = `class Counter(val value: int) {
  increment(amount: int): int { return value + amount }
  identity(value: int): int { return value }
}
fun Counter.doubled(): int { return value + value }
val Counter.next => increment(1)`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("return this.value + amount;");
    expect(result.code).toContain("identity(value) {\nreturn value;");
    // Named extension methods are emitted as standalone receiver-mangled
    // functions with a `$this` receiver parameter.
    expect(result.code).toContain("function Counter$$doubled$$void($this) {");
    expect(result.code).toContain("return $this.value + $this.value;");
    expect(result.code).toContain("const Counter$$next = ($this) => $this.increment(1);");
  });

  it("lowers named extension method calls to standalone receiver-mangled functions", () => {
    const source = `class Counter(val value: int) {}
fun Counter.plus(amount: int): int { return value + amount }
let counter = new Counter(5)
let total = counter.plus(2)`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("function Counter$$plus$$int($this, amount) {");
    expect(result.code).toContain("return $this.value + amount;");
    expect(result.code).toContain("let total = Counter$$plus$$int(counter, 2);");
  });

  it("lowers chain expressions to statements that return the receiver", () => {
    const source = `class Badge {
  var point: int = 0
  beginFill(color: int): Badge { return this }
  endFill(): Badge { return this }
}
val badge = Badge()
  ..point = 7
  ..beginFill(1)
  ..endFill()
console.log(badge.point)`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const badge = (($$chain_0) => { $$chain_0.point = 7; $$chain_0.beginFill(1); $$chain_0.endFill(); return $$chain_0; })(new Badge());");
  });

  it("lowers imported extension method calls using the imported receiver runtime name", () => {
    const declarationSource = [
      "export class View {}",
      "export class Container {}",
      "export fun View.addTo(container: Container): void {}"
    ].join("\n");
    const externalDeclarations = compileSource(declarationSource).ast!.body;
    const source = `import { View, Container, addTo } from "./view-utils"
class Graphics extends View {}
val badge = Graphics()
val stage = Container()
badge.addTo(stage)`;
    const result = transpile(source, { target: "conservative", externalDeclarations });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { View, Container, View$$addTo$$Container } from "./view-utils";');
    expect(result.code).toContain("View$$addTo$$Container(badge, stage);");
    expect(result.code).not.toContain("Graphics$$addTo");
  });

  it("lowers chain expressions with imported extension method calls", () => {
    const declarationSource = [
      "export class View {}",
      "export class Container<T> {}",
      "export fun View.addTo(container: Container<any>): void {}"
    ].join("\n");
    const externalDeclarations = compileSource(declarationSource).ast!.body;
    const source = `import { View, Container, addTo } from "./view-utils"
class Graphics extends View {}
val stage = Container()
val badge = Graphics()
  ..addTo(stage)`;
    const result = transpile(source, { target: "conservative", externalDeclarations });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { View, Container, View$$addTo$$Container$any } from "./view-utils";');
    expect(result.code).toContain("const badge = (($$chain_0) => { View$$addTo$$Container$any($$chain_0, stage); return $$chain_0; })(new Graphics());");
    expect(result.code).not.toContain("Graphics$$addTo");
  });

  it("lowers int multiplication and division to 32-bit JavaScript operations", () => {
    const source = `let a: int = 9
let b: int = 4
let product: int = a * b
let quotient: int = a / b`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let product = Math.imul(a, b);");
    expect(result.code).toContain("let quotient = (a / b) | 0;");
  });

  it("mangles and lowers extension properties", () => {
    const source = `class Duration(val value: number)
export val number.milliseconds => Duration(this)
val duration = 10.milliseconds`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("export const number$$milliseconds = ($this) => new Duration($this);");
    expect(result.code).toContain("const duration = number$$milliseconds(10);");
  });

  it("mangles imported extension properties", () => {
    const source = `import { milliseconds } from "./duration"
val duration = 10.milliseconds`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { number$$milliseconds } from "./duration";');
    expect(result.code).toContain("const duration = number$$milliseconds(10);");
  });

  it("discovers imported extension properties in nested statements", () => {
    const source = `import { milliseconds } from "./duration"
if (true) {
  val duration = 10.milliseconds
}`;
    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('import { number$$milliseconds } from "./duration";');
    expect(result.code).toContain("const duration = number$$milliseconds(10);");
  });

  it("emits contextually resolved brace arguments and is checks", () => {
    const source = `interface Options { it: int }
fun transform(fn: (value: int) => int): int { return fn(1) }
fun consume(options: Options): int { return options.it }
class Cat {}
let it = 4
let a = transform({ it })
let b = transform({ value -> value + 1 })
let c = consume({ it })
let cat: Cat | string = new Cat()
if (cat is Cat) { transform({ it }) }
`;
    const result = transpile(source);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("transform((it) => it)");
    expect(result.code).toContain("transform((value) => value + 1)");
    expect(result.code).toContain("consume({it})");
    expect(result.code).toContain("cat instanceof Cat");
  });

  it("inlines @JsInline functions and substitutes arguments and defaults", () => {
    const source = `@JsInline("((function test() { call() })())")
fun test(call: any)
@JsInline("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")
test(() => { assert(1 == 1) })`;

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toBe('((function test() { (() => {\nif (!(1 == 1)) throw new Error(("assert failed"));\n})() })());');
  });

  it("renames declarations and references with @JsName", () => {
    const source = `@JsName("clamp01")
function clampUnit(value: number): number { return value }
clampUnit(2)`;

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("function clamp01(value)");
    expect(result.code).toContain("clamp01(2);");
    expect(result.code).not.toContain("clampUnit");
  });

  it("renames classes with @JsName without touching member access", () => {
    const source = `@JsName("rgba")
class Color(val value: int)
val c = new Color(1)
c.value`;

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class rgba");
    expect(result.code).toContain("new rgba(1)");
    expect(result.code).toContain("c.value");
    expect(result.code).not.toContain("Color");
  });

  it("emits named call arguments in the callee's positional order", () => {
    const source = [
      "fun connect(host: string, port: number) {}",
      'connect(port: 8080, host: "localhost")'
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('connect("localhost", 8080)');
  });

  it("supports mixing positional and named call arguments", () => {
    const source = [
      "fun connect(host: string, port: number) {}",
      'connect("localhost", port: 8080)'
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('connect("localhost", 8080)');
  });

  it("reorders named constructor arguments for new expressions", () => {
    const source = [
      "class Point(val x: number, val y: number)",
      "val p = new Point(y: 2, x: 1)"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("new Point(1, 2)");
  });

  it("transpiles embedded XML/JSX to the default React runtime", () => {
    const result = transpile("const view = <div>hi</div>\n");
    expect(result.errors).toEqual([]);
    expect(result.code).toContain('React.createElement("div", null, "hi")');
  });

  it("honors configurable jsxFactory and jsxFragmentFactory options", () => {
    const result = transpile("const view = <><span/></>\n", {
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment"
    });
    expect(result.errors).toEqual([]);
    expect(result.code).toContain('h(Fragment, null, h("span", null))');
  });


  it("lowers delegated variables through type-directed getter and setter shapes", () => {
    const source = [
      "fun useState(value: number) {",
      "  return [value, (newValue: number) => { value = newValue }]",
      "}",
      "var nvalue by useState(0)",
      "nvalue = nvalue + 1",
      "nvalue += 1",
      "nvalue++",
      "var value by useState(10)",
      "value++",
      "let result = nvalue"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const __$delegate_nvalue = useState(0);");
    expect(result.code).toContain("__$delegate_nvalue[1](__$delegate_nvalue[0] + 1);");
    expect(result.code).toContain("__$delegate_nvalue[1](__$delegate_nvalue[0] + 1);");
    expect(result.code).toContain("const __$delegate_value = useState(10);");
    expect(result.code).toContain("__$delegate_value[1](__$delegate_value[0] + 1);");
    expect(result.code).toContain("let result = __$delegate_nvalue[0];");
    expect(result.code).toContain("return [value, (newValue) => {");
    expect(result.code).toContain("value = newValue;");
  });

  it("reports an error when ++ is applied to a non-numeric type", () => {
    const source = `class Foo(val x: int) {}
let f = Foo(1)
f++`;
    const result = transpile(source);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Operator '++' cannot be applied to type 'Foo'");
  });

  it("does not report duplicate declaration for a class with both get and set accessors", () => {
    const source = `class Box<T>(var current: T) {
  get value(): T => current
  set value(newValue: T) { current = newValue }
}`;
    const result = transpile(source);
    expect(result.errors).toEqual([]);
  });

  it("delegates a variable to a class instance via its value getter/setter", () => {
    const source = `class Counter(var current: int) {
  get value(): int => current
  set value(n: int) { current = n }
}
let c by Counter(0)
c++
c += 5`;
    const result = transpile(source);
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const __$delegate_c = new Counter(0);");
    expect(result.code).toContain("__$delegate_c.value = __$delegate_c.value + 1;");
    expect(result.code).toContain("__$delegate_c.value = __$delegate_c.value + 5;");
  });

  it("supports delegated variables backed by getter functions and value objects", () => {
    const source = [
      "var stored = 1",
      "var fromFunction by () => stored",
      "var fromObject by { value: 2 }",
      "fromObject += fromFunction",
      "fromObject++",
      "let result = fromObject"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const __$delegate_fromFunction = () => stored;");
    expect(result.code).toContain("const __$delegate_fromObject = {value: 2};");
    expect(result.code).toContain("__$delegate_fromObject.value = __$delegate_fromObject.value + __$delegate_fromFunction();");
    expect(result.code).toContain("__$delegate_fromObject.value = __$delegate_fromObject.value + 1;");
    expect(result.code).toContain("let result = __$delegate_fromObject.value;");
  });

  it("lowers property references to delegate-compatible value objects", () => {
    const source = [
      "class View(var x: number)",
      "val view = View(1)",
      "val property = view::x",
      "var x by property",
      "x += 2",
      "let result = x",
      "let direct = property.value"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("const property = (($$propertyReceiver_");
    expect(result.code).toContain("name: \"x\"");
    expect(result.code).toContain("get value() { return $$propertyReceiver_");
    expect(result.code).toContain("set value(__$propertyValue) { $$propertyReceiver_");
    expect(result.code).toContain("__$delegate_x.value = __$delegate_x.value + 2;");
    expect(result.code).toContain("let result = __$delegate_x.value;");
    expect(result.code).toContain("let direct = property.value;");
  });

  it("lowers property reference index operator extensions", () => {
    const source = [
      "class View(var x: number)",
      "fun Property<number>.operator[](src: number, dst: number): string => \"tween\"",
      "val view = View(1)",
      "val result = view::x[0, 100]"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Property$$operator$get$$number$$number(");
  });

  it("emits for await when iterating a sync generator result through the full pipeline", () => {
    const source = [
      "sync fun * produce() {",
      "  yield 1",
      "}",
      "sync fun consume() {",
      "  val gen = produce()",
      "  for (v in gen) {",
      "    console.log(v)",
      "  }",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for await (const v of gen)");
  });

  it("emits the three-way comparison (spaceship) operator for primitive operands", () => {
    const result = transpile("let order = 1 <=> 2\n");

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let order = (($l, $r) => $l < $r ? -1 : $l > $r ? 1 : 0)(1, 2);");
  });

  it("dispatches an overloaded spaceship operator to its method", () => {
    const source = [
      "class Vec(val n: number) {",
      "  operator<=>(other: Vec): int => n <=> other.n",
      "}",
      "let order = Vec(1) <=> Vec(2)"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("operator$spaceship$$Vec(other)");
    expect(result.code).toContain("let order = new Vec(1).operator$spaceship$$Vec(new Vec(2));");
  });

  it("derives comparison operators from a spaceship overload", () => {
    const source = [
      "class Money(val cents: int) {",
      "  operator<=>(other: Money): int => cents <=> other.cents",
      "}",
      "let lt = Money(1) < Money(2)",
      "let eq = Money(1) == Money(2)"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let lt = (new Money(1).operator$spaceship$$Money(new Money(2)) < 0);");
    expect(result.code).toContain("let eq = (new Money(1).operator$spaceship$$Money(new Money(2)) == 0);");
  });

  it("derives != from an equality overload", () => {
    const source = [
      "class Tag(val name: string) {",
      "  operator==(other: Tag): boolean => name == other.name",
      "}",
      "let ne = Tag(\"a\") != Tag(\"b\")"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("let ne = !(new Tag(\"a\").operator$equals$$Tag(new Tag(\"b\")));");
  });

});
