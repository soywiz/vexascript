import { describe, expect, it } from "vitest";
import { transpile } from "./transpile";

describe("transpile", () => {
  it("rewrites mylang for-in loops to JavaScript for-of with const iterator", () => {
    const source = [
      "declare class Console {",
      "  log(a: number)",
      "}",
      "declare var console: Console",
      "for (n in [1,23]) {",
      "  console.log(n)",
      "}"
    ].join("\n");

    const result = transpile(source);

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (const n of [1,23]) {");
    expect(result.code).toContain("console.log(n)");
  });
});
