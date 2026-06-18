import { describe, expect, it } from "../test/expect";
import type { AnalysisType } from "./types";
import {
  isDynamicPropertyName,
  normalizeIndexSignaturePropertyName,
  normalizePropertyName,
  propertyEntries,
  propertyNamesMatch,
  propertyTypeAllowsUndefined,
  propertyTypeFrom,
  propertyTypeWithoutUndefined,
} from "./propertyNames";

function builtin(name: string): AnalysisType {
  return { kind: "builtin", name } as AnalysisType;
}
function union(...types: AnalysisType[]): AnalysisType {
  return { kind: "union", types } as unknown as AnalysisType;
}

describe("normalizeIndexSignaturePropertyName", () => {
  it("normalizes a basic index signature", () => {
    expect(normalizeIndexSignaturePropertyName("[K: string]")).toBe("[string]");
  });

  it("strips the bound variable name", () => {
    expect(normalizeIndexSignaturePropertyName("[key: number]")).toBe("[number]");
  });

  it("collapses internal whitespace in the index type", () => {
    expect(normalizeIndexSignaturePropertyName("[k:  string  ]")).toBe("[string]");
  });

  it("handles a readonly index signature", () => {
    expect(normalizeIndexSignaturePropertyName("readonly [k: string]")).toBe("[string]");
  });

  it("returns null for a plain property name", () => {
    expect(normalizeIndexSignaturePropertyName("name")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeIndexSignaturePropertyName("")).toBeNull();
  });
});

describe("normalizePropertyName", () => {
  it("trims whitespace from plain names", () => {
    expect(normalizePropertyName("  foo  ")).toBe("foo");
  });

  it("unquotes double-quoted property names", () => {
    expect(normalizePropertyName("\"foo\"")).toBe("foo");
  });

  it("unquotes single-quoted property names", () => {
    expect(normalizePropertyName("'bar'")).toBe("bar");
  });

  it("normalizes index signatures", () => {
    expect(normalizePropertyName("[K: string]")).toBe("[string]");
  });

  it("returns a plain identifier unchanged", () => {
    expect(normalizePropertyName("count")).toBe("count");
  });
});

describe("isDynamicPropertyName", () => {
  it("returns true for an index signature", () => {
    expect(isDynamicPropertyName("[K: string]")).toBe(true);
  });

  it("returns true for a readonly index signature", () => {
    expect(isDynamicPropertyName("readonly [K: string]")).toBe(true);
  });

  it("returns false for a plain property name", () => {
    expect(isDynamicPropertyName("count")).toBe(false);
  });

  it("returns false for a quoted property name", () => {
    expect(isDynamicPropertyName("\"foo\"")).toBe(false);
  });
});

describe("propertyNamesMatch", () => {
  it("matches identical names", () => {
    expect(propertyNamesMatch("foo", "foo")).toBe(true);
  });

  it("matches a quoted name against its unquoted form", () => {
    expect(propertyNamesMatch("\"foo\"", "foo")).toBe(true);
    expect(propertyNamesMatch("foo", "\"foo\"")).toBe(true);
  });

  it("matches equivalent index signatures regardless of variable name", () => {
    expect(propertyNamesMatch("[K: string]", "[key: string]")).toBe(true);
  });

  it("does not match different plain names", () => {
    expect(propertyNamesMatch("foo", "bar")).toBe(false);
  });

  it("does not match index signatures with different index types", () => {
    expect(propertyNamesMatch("[K: string]", "[K: number]")).toBe(false);
  });
});

describe("propertyEntries", () => {
  it("converts a plain record to entries array", () => {
    const result = propertyEntries({ a: builtin("string"), b: builtin("number") });
    expect(result.length).toBe(2);
    expect(result.find(([k]) => k === "a")?.[1]).toEqual(builtin("string"));
  });

  it("converts a Map to entries array", () => {
    const map = new Map<string, AnalysisType>([["x", builtin("boolean")]]);
    const result = propertyEntries(map);
    expect(result).toEqual([["x", builtin("boolean")]]);
  });
});

describe("propertyTypeFrom", () => {
  it("finds a property by exact name in a record", () => {
    const props = { foo: builtin("string") };
    expect(propertyTypeFrom(props, "foo")).toEqual(builtin("string"));
  });

  it("finds a quoted property name via normalization", () => {
    const props = { foo: builtin("number") };
    expect(propertyTypeFrom(props, "\"foo\"")).toEqual(builtin("number"));
  });

  it("returns undefined for a missing property", () => {
    expect(propertyTypeFrom({}, "bar")).toBeUndefined();
  });

  it("finds a property by exact name in a Map", () => {
    const map = new Map<string, AnalysisType>([["key", builtin("boolean")]]);
    expect(propertyTypeFrom(map, "key")).toEqual(builtin("boolean"));
  });
});

describe("propertyTypeAllowsUndefined", () => {
  it("returns true for undefined builtin", () => {
    expect(propertyTypeAllowsUndefined(builtin("undefined"))).toBe(true);
  });

  it("returns true for any", () => {
    expect(propertyTypeAllowsUndefined(builtin("any"))).toBe(true);
  });

  it("returns true for unknown", () => {
    expect(propertyTypeAllowsUndefined(builtin("unknown"))).toBe(true);
  });

  it("returns true for union containing undefined", () => {
    expect(propertyTypeAllowsUndefined(union(builtin("string"), builtin("undefined")))).toBe(true);
  });

  it("returns false for string", () => {
    expect(propertyTypeAllowsUndefined(builtin("string"))).toBe(false);
  });

  it("returns false for union without undefined", () => {
    expect(propertyTypeAllowsUndefined(union(builtin("string"), builtin("number")))).toBe(false);
  });
});

describe("propertyTypeWithoutUndefined", () => {
  it("returns null for non-union types", () => {
    expect(propertyTypeWithoutUndefined(builtin("string"))).toBeNull();
  });

  it("returns the single non-undefined member from a string | undefined union", () => {
    const result = propertyTypeWithoutUndefined(union(builtin("string"), builtin("undefined")));
    expect(result).toEqual(builtin("string"));
  });

  it("returns null when the union has no undefined member", () => {
    const result = propertyTypeWithoutUndefined(union(builtin("string"), builtin("number")));
    expect(result).toBeNull();
  });

  it("returns null when all members are undefined", () => {
    const result = propertyTypeWithoutUndefined(union(builtin("undefined")));
    expect(result).toBeNull();
  });
});
