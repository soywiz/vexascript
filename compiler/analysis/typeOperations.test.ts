import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisType } from "./types";
import {
  combineTypes,
  elementTypeFromIterable,
  hasNullishUnionMember,
  isAsyncIteratorType,
  removeNullishFromType,
  resolveLiteralTypeName,
  spreadArgumentElementType,
  unwrapPromiseType,
} from "./typeOperations";

function builtin(name: string): AnalysisType {
  return { kind: "builtin", name } as AnalysisType;
}
function namedType(name: string, typeArguments?: AnalysisType[]): AnalysisType {
  return { kind: "named", name, ...(typeArguments ? { typeArguments } : {}) } as AnalysisType;
}
function union(...types: AnalysisType[]): AnalysisType {
  return { kind: "union", types } as AnalysisType;
}
function array(elementType: AnalysisType): AnalysisType {
  return { kind: "array", elementType } as AnalysisType;
}
function tuple(...elements: AnalysisType[]): AnalysisType {
  return { kind: "tuple", elements } as AnalysisType;
}
function range(elementType: AnalysisType): AnalysisType {
  return { kind: "range", elementType } as AnalysisType;
}

describe("combineTypes", () => {
  it("returns void for an empty array", () => {
    const result = combineTypes([]);
    assert.deepEqual(result, { kind: "builtin", name: "void" });
  });

  it("returns the single type directly when only one distinct type", () => {
    const t = builtin("int");
    assert.equal(combineTypes([t]), t);
  });

  it("deduplicates identical types", () => {
    const t = builtin("string");
    const result = combineTypes([t, t]);
    assert.equal(result, t);
  });

  it("builds a union for multiple distinct types", () => {
    const result = combineTypes([builtin("int"), builtin("string")]);
    assert.equal(result.kind, "union");
  });
});

describe("unwrapPromiseType", () => {
  it("extracts T from Promise<T>", () => {
    const inner = builtin("string");
    const result = unwrapPromiseType(namedType("Promise", [inner]));
    assert.equal(result, inner);
  });

  it("returns unknown when Promise has no type argument", () => {
    const result = unwrapPromiseType(namedType("Promise"));
    assert.equal(result?.kind, "unknown");
  });

  it("returns null for non-Promise named types", () => {
    assert.equal(unwrapPromiseType(namedType("Array")), null);
  });

  it("returns null for non-named types", () => {
    assert.equal(unwrapPromiseType(builtin("int")), null);
  });
});

describe("hasNullishUnionMember", () => {
  it("returns true when union contains null", () => {
    assert.equal(hasNullishUnionMember(union(builtin("string"), builtin("null"))), true);
  });

  it("returns true when union contains undefined", () => {
    assert.equal(hasNullishUnionMember(union(builtin("int"), builtin("undefined"))), true);
  });

  it("returns false when union has no nullish members", () => {
    assert.equal(hasNullishUnionMember(union(builtin("string"), builtin("int"))), false);
  });

  it("returns false for non-union types", () => {
    assert.equal(hasNullishUnionMember(builtin("null")), false);
  });
});

describe("removeNullishFromType", () => {
  it("strips null from a union", () => {
    const result = removeNullishFromType(union(builtin("string"), builtin("null")));
    assert.deepEqual(result, builtin("string"));
  });

  it("collapses to single type when only one non-nullish member remains", () => {
    const result = removeNullishFromType(union(builtin("int"), builtin("undefined")));
    assert.deepEqual(result, builtin("int"));
  });

  it("returns unknown when all members are nullish", () => {
    const result = removeNullishFromType(union(builtin("null"), builtin("undefined")));
    assert.equal(result.kind, "unknown");
  });

  it("returns non-union types unchanged", () => {
    const t = builtin("string");
    assert.equal(removeNullishFromType(t), t);
  });
});

describe("spreadArgumentElementType", () => {
  it("returns element type for array types", () => {
    const inner = builtin("int");
    assert.equal(spreadArgumentElementType(array(inner)), inner);
  });

  it("returns element for single-element tuples", () => {
    const inner = builtin("string");
    assert.equal(spreadArgumentElementType(tuple(inner)), inner);
  });

  it("returns a union for multi-element tuples", () => {
    const result = spreadArgumentElementType(tuple(builtin("int"), builtin("string")));
    assert.equal(result.kind, "union");
  });

  it("returns T from Array<T> named type", () => {
    const inner = builtin("number");
    const result = spreadArgumentElementType(namedType("Array", [inner]));
    assert.equal(result, inner);
  });

  it("returns unknown for unrecognized types", () => {
    const result = spreadArgumentElementType(builtin("int"));
    assert.equal(result.kind, "unknown");
  });
});

describe("elementTypeFromIterable", () => {
  it("returns element type from array types", () => {
    const inner = builtin("int");
    assert.equal(elementTypeFromIterable(array(inner)), inner);
  });

  it("returns element type from range types", () => {
    const inner = builtin("int");
    assert.equal(elementTypeFromIterable(range(inner)), inner);
  });

  it("returns first type argument from Iterator<T>", () => {
    const inner = builtin("string");
    const result = elementTypeFromIterable(namedType("Iterator", [inner]));
    assert.equal(result, inner);
  });

  it("returns first type argument from Iterable<T>", () => {
    const inner = builtin("int");
    const result = elementTypeFromIterable(namedType("Iterable", [inner]));
    assert.equal(result, inner);
  });

  it("returns unknown for non-iterable types", () => {
    const result = elementTypeFromIterable(builtin("string"));
    assert.equal(result.kind, "unknown");
  });
});

describe("isAsyncIteratorType", () => {
  it("returns true for AsyncGenerator", () => {
    assert.equal(isAsyncIteratorType(namedType("AsyncGenerator")), true);
  });

  it("returns true for AsyncIterator", () => {
    assert.equal(isAsyncIteratorType(namedType("AsyncIterator")), true);
  });

  it("returns true for AsyncIteratorObject", () => {
    assert.equal(isAsyncIteratorType(namedType("AsyncIteratorObject")), true);
  });

  it("returns false for Generator (sync)", () => {
    assert.equal(isAsyncIteratorType(namedType("Generator")), false);
  });

  it("returns false for non-named types", () => {
    assert.equal(isAsyncIteratorType(builtin("string")), false);
  });
});

describe("resolveLiteralTypeName", () => {
  it("parses double-quoted string literals", () => {
    const result = resolveLiteralTypeName('"hello"');
    assert.equal(result?.kind, "literal");
    assert.equal((result as any).base, "string");
    assert.equal((result as any).value, "hello");
  });

  it("parses single-quoted string literals", () => {
    const result = resolveLiteralTypeName("'world'");
    assert.equal(result?.kind, "literal");
    assert.equal((result as any).value, "world");
  });

  it("parses true", () => {
    const result = resolveLiteralTypeName("true");
    assert.equal(result?.kind, "literal");
    assert.equal((result as any).value, true);
  });

  it("parses false", () => {
    const result = resolveLiteralTypeName("false");
    assert.equal((result as any).value, false);
  });

  it("parses integer literals", () => {
    const result = resolveLiteralTypeName("42");
    assert.equal(result?.kind, "literal");
    assert.equal((result as any).value, 42);
  });

  it("parses negative numeric literals", () => {
    const result = resolveLiteralTypeName("-3.14");
    assert.equal((result as any).value, -3.14);
  });

  it("returns null for identifiers", () => {
    assert.equal(resolveLiteralTypeName("string"), null);
    assert.equal(resolveLiteralTypeName("MyType"), null);
  });
});
