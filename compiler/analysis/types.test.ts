import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalysisType, arrayType, builtinType, intersectionType, isSameType, namedType, typeToString, UNKNOWN_TYPE, unionType } from "./types";

describe("analysis type factories", () => {
  it("uses AnalysisType as the runtime base class", () => {
    assert.equal(namedType("Node") instanceof AnalysisType, true);
  });

  it("renders recursive type graphs without leaking cycle state between calls", () => {
    const recursive = namedType("Node");
    recursive.typeArguments = [recursive];

    assert.equal(typeToString(recursive), "Node<Node>");
    assert.equal(typeToString(recursive), "Node<Node>");
  });

  it("bounds rendering work for deeply nested structural types", () => {
    let nested: AnalysisType = namedType("Leaf");
    for (let depth = 0; depth < 2_000; depth += 1) {
      nested = intersectionType([namedType(`Layer${depth}`), nested]);
    }

    const rendered = typeToString(nested);
    assert.equal(rendered.startsWith("Layer1999 & Layer1998"), true);
    assert.equal(rendered.length < 10_000, true);
  });

  it("bounds rendering work for repeatedly shared structural types", () => {
    let shared: AnalysisType = namedType("Leaf");
    for (let depth = 0; depth < 16; depth += 1) {
      shared = intersectionType([shared, shared]);
    }

    const rendered = typeToString(shared);
    assert.equal(rendered.startsWith("Leaf & Leaf"), true);
    assert.equal(rendered.length < 100_000, true);
  });

  it("keeps missing runtime values out of union members", () => {
    const union = unionType([undefined as unknown as AnalysisType]);

    assert.equal(union.types[0], UNKNOWN_TYPE);
  });

  it("omits never when rendering a union with a reachable member", () => {
    assert.equal(typeToString(unionType([builtinType("string"), builtinType("never")])), "string");
  });

  it("parenthesizes union array elements", () => {
    assert.equal(
      typeToString(arrayType(unionType([namedType("PromiseFulfilledResult", [builtinType("int")]), namedType("PromiseRejectedResult")]))),
      "(PromiseFulfilledResult<int> | PromiseRejectedResult)[]"
    );
  });

  it("rejects missing runtime values before using the recursive-pair WeakMap", () => {
    assert.equal(isSameType(undefined, builtinType("string")), false);
    assert.equal(isSameType(builtinType("string"), null), false);
  });
});
