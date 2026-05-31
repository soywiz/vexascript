import { describe, expect, it } from "vitest";
import { transpile } from "./transpile";

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
});
