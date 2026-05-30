import { describe, expect, it } from "vitest";
import { transpile } from "./transpile";

describe("transpile", () => {
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

  it("emits generator-based range expression outside for loops", () => {
    const source = "let values = 0 ... 10";

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "let values = (function*(s, e) { for (let n = s; n < e; n++) yield n })(0, 10);"
    );
  });
});
