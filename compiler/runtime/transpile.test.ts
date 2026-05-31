import { describe, expect, it } from "vitest";
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
});
