import { describe, expect, it } from "../test/expect";
import {
  isDynamicPropertyName,
  normalizeIndexSignaturePropertyName,
  normalizePropertyName,
  propertyNamesMatch,
} from "./propertyNames";

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
