import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalysisType, builtinType, isSameType, namedType, typeToString, UNKNOWN_TYPE, unionType } from "./types";

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

  it("keeps missing runtime values out of union members", () => {
    const union = unionType([undefined as unknown as AnalysisType]);

    assert.equal(union.types[0], UNKNOWN_TYPE);
  });

  it("rejects missing runtime values before using the recursive-pair WeakMap", () => {
    assert.equal(isSameType(undefined, builtinType("string")), false);
    assert.equal(isSameType(builtinType("string"), null), false);
  });
});
