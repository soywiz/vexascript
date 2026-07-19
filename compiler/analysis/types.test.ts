import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisType } from "./types";
import { builtinType, isSameType, unionType } from "./types";

describe("analysis type factories", () => {
  it("keeps missing runtime values out of union members", () => {
    const union = unionType([undefined as unknown as AnalysisType]);

    assert.deepEqual(union.types, [{ kind: "unknown" }]);
  });

  it("rejects missing runtime values before using the recursive-pair WeakMap", () => {
    assert.equal(isSameType(undefined, builtinType("string")), false);
    assert.equal(isSameType(builtinType("string"), null), false);
  });
});
