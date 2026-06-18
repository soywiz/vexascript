import { describe, expect, it } from "../test/expect";
import { isNumberLikeType, typeToDiagnosticLabel } from "./typeDisplay";
import { builtinType, functionType, literalType, namedType } from "./types";

describe("isNumberLikeType", () => {
  it("returns true for the number builtin", () => {
    expect(isNumberLikeType(builtinType("number"))).toBe(true);
  });

  it("returns true for a numeric literal type", () => {
    expect(isNumberLikeType(literalType("number", 42))).toBe(true);
  });

  it("returns false for string builtin", () => {
    expect(isNumberLikeType(builtinType("string"))).toBe(false);
  });

  it("returns false for a named type", () => {
    expect(isNumberLikeType(namedType("Counter"))).toBe(false);
  });

  it("returns false for a string literal type", () => {
    expect(isNumberLikeType(literalType("string", "hello"))).toBe(false);
  });
});

describe("typeToDiagnosticLabel", () => {
  it("formats a builtin type as its name", () => {
    expect(typeToDiagnosticLabel(builtinType("string"))).toBe("string");
  });

  it("formats a named type as its name", () => {
    expect(typeToDiagnosticLabel(namedType("MyClass"))).toBe("MyClass");
  });

  it("formats a function type with parameter names", () => {
    const type = functionType(
      [{ name: "x", type: builtinType("number"), optional: false }],
      builtinType("string")
    );
    expect(typeToDiagnosticLabel(type)).toBe("(x: number) => string");
  });

  it("marks optional parameters with ?", () => {
    const type = functionType(
      [{ name: "n", type: builtinType("int"), optional: true }],
      builtinType("void")
    );
    expect(typeToDiagnosticLabel(type)).toBe("(n?: int) => void");
  });

  it("formats a zero-parameter function type", () => {
    const type = functionType([], builtinType("boolean"));
    expect(typeToDiagnosticLabel(type)).toBe("() => boolean");
  });

  it("formats nested function types recursively", () => {
    const inner = functionType(
      [{ name: "a", type: builtinType("int"), optional: false }],
      builtinType("int")
    );
    const outer = functionType(
      [{ name: "fn", type: inner, optional: false }],
      builtinType("string")
    );
    expect(typeToDiagnosticLabel(outer)).toBe("(fn: (a: int) => int) => string");
  });
});
