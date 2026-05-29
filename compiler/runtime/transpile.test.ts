import { describe, expect, it } from "vitest";
import { transpile } from "./transpile";

describe("transpile", () => {
  it("recorta espacios al inicio y final", () => {
    const result = transpile("  const x = 1;  ");
    expect(result.code).toBe("const x = 1;");
  });

  it("devuelve warning cuando aparece any", () => {
    const result = transpile("let value: any = 1;");
    expect(result.warnings).toContain("Evita 'any' en MyLang cuando sea posible.");
  });

  it("no devuelve warnings cuando no hay any", () => {
    const result = transpile("const value: number = 1;");
    expect(result.warnings).toHaveLength(0);
  });
});
