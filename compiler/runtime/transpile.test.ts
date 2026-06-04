import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { transpile } from "./transpile";

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
      sourceFilePath: "/tmp/demo.my",
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
    expect(sourceMap.sources).toEqual(["demo.my"]);
    expect(sourceMap.sourcesContent).toEqual([source]);
    expect(sourceMap.mappings.length).toBeGreaterThan(0);
  });

  it("rewrites mylang for-in loops to JavaScript for-of with const iterator", () => {
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

  it("optimizes range iteration inside for loops to a classic for loop", () => {
    const source = "for (a of 0 ... 10) console.log(a)";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (let a = 0; a < 10; a++) console.log(a)");
  });

  it("supports conservative target mode without lowering optimizations", () => {
    const source = "for (a of 0 ... 3) console.log(a)";

    const conservative = transpile(source, { target: "conservative" });
    const optimized = transpile(source, { target: "optimized" });

    expect(conservative.errors).toEqual([]);
    expect(optimized.errors).toEqual([]);
    expect(conservative.code).toContain(
      "for (const a of (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 3)) console.log(a);"
    );
    expect(optimized.code).toContain("for (let a = 0; a < 3; a++) console.log(a);");
  });

  it("emits generator-based range expression outside for loops", () => {
    const source = "let values = 0 ... 10";

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
      sourceFilePath: "/tmp/sample.my",
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
    expect(result.code).toContain("Point.prototype.operator$plus$$Point = function(other) {");
    expect(result.code).toContain("let c = a.operator$plus$$Point(b);");
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
    expect(result.code).toContain("return this.value + this.value;");
    expect(result.code).toContain("const Counter$$next = ($this) => $this.increment(1);");
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

  it("inlines @JsImpl functions and substitutes arguments and defaults", () => {
    const source = `@JsImpl("((function test() { call() })())")
fun test(call: any)
@JsImpl("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")
test(() => { assert(1 == 1) })`;

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toBe('((function test() { (() => {\nif (!(1 == 1)) throw new Error(("assert failed"));\n})() })());');
  });

});
