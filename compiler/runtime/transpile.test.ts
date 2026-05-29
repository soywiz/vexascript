import { describe, expect, it } from "vitest";
import { transpile } from "./transpile";

describe("transpile", () => {
  it("transpiles a let with integer addition to JavaScript", () => {
    const result = transpile("let x = 10 + 2");
    expect(result.code).toBe("let x = 10 + 2;");
  });

  it("does not emit warnings in the supported base case", () => {
    const result = transpile("let value = 1 + 2");
    expect(result.warnings).toHaveLength(0);
  });
});
