import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  comparePosition,
  containsPosition,
  nodeRange,
  rangeContains,
  rangeSize,
  tokenRange
} from "./ranges";

describe("LSP range helpers", () => {
  it("converts token-backed parser nodes to LSP ranges", () => {
    const range = nodeRange({
      firstToken: {
        range: {
          start: { line: 2, column: 4 },
          end: { line: 2, column: 7 }
        }
      },
      lastToken: {
        range: {
          start: { line: 3, column: 1 },
          end: { line: 3, column: 9 }
        }
      }
    });

    assert.deepEqual(range, {
      start: { line: 2, character: 4 },
      end: { line: 3, character: 9 }
    });
  });

  it("returns null for nodes and tokens without complete source ranges", () => {
    assert.equal(nodeRange({}), null);
    assert.equal(tokenRange(undefined), null);
  });

  it("compares positions and range containment consistently across lines", () => {
    const outer = {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 }
    };
    const inner = {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 8 }
    };

    assert.equal(comparePosition(outer.start, inner.start) < 0, true);
    assert.equal(comparePosition(outer.end, inner.end) > 0, true);
    assert.equal(rangeContains(outer, inner), true);
    assert.equal(containsPosition(inner, { line: 2, character: 4 }), true);
    assert.equal(containsPosition(inner, { line: 3, character: 0 }), false);
  });

  it("uses a stable weighted size for multi-line ranges", () => {
    assert.equal(rangeSize({ start: { line: 0, character: 3 }, end: { line: 0, character: 8 } }), 5);
    assert.equal(rangeSize({ start: { line: 0, character: 3 }, end: { line: 2, character: 8 } }), 200_005);
  });
});
