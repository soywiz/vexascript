import { describe, expect, it } from "../test/expect";
import { boxedInterfaceNameForBuiltin, expressionSnippet, isNumberLikeType, typeToDiagnosticLabel } from "./typeDisplay";
import { builtinType, functionType, literalType, namedType } from "./types";
import type { Expr } from "compiler/ast/ast";

function expr(kind: string, extra?: object): Expr {
  return { kind, ...extra } as unknown as Expr;
}

describe("boxedInterfaceNameForBuiltin", () => {
  it("maps int to Number", () => {
    expect(boxedInterfaceNameForBuiltin("int")).toBe("Number");
  });

  it("maps number to Number", () => {
    expect(boxedInterfaceNameForBuiltin("number")).toBe("Number");
  });

  it("maps string to String", () => {
    expect(boxedInterfaceNameForBuiltin("string")).toBe("String");
  });

  it("maps boolean to Boolean", () => {
    expect(boxedInterfaceNameForBuiltin("boolean")).toBe("Boolean");
  });

  it("maps bigint to BigInt", () => {
    expect(boxedInterfaceNameForBuiltin("bigint")).toBe("BigInt");
  });

  it("maps long to BigInt", () => {
    expect(boxedInterfaceNameForBuiltin("long")).toBe("BigInt");
  });

  it("returns null for unknown names", () => {
    expect(boxedInterfaceNameForBuiltin("void")).toBeNull();
    expect(boxedInterfaceNameForBuiltin("MyClass")).toBeNull();
  });
});

describe("expressionSnippet", () => {
  it("returns null for identifiers", () => {
    expect(expressionSnippet(expr("Identifier"))).toBeNull();
  });

  it("returns kind when no token values are present", () => {
    expect(expressionSnippet(expr("BinaryExpression"))).toBe("BinaryExpression");
  });

  it("returns first token when only first is present", () => {
    expect(expressionSnippet(expr("CallExpression", { firstToken: { value: "foo" } }))).toBe("foo");
  });

  it("returns a range when first and last differ", () => {
    expect(expressionSnippet(expr("CallExpression", { firstToken: { value: "foo" }, lastToken: { value: ")" } }))).toBe("foo ... )");
  });

  it("returns first when first equals last", () => {
    expect(expressionSnippet(expr("Literal", { firstToken: { value: "42" }, lastToken: { value: "42" } }))).toBe("42");
  });
});

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
