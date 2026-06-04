import { describe, it } from "node:test";
import { expect } from "../vitest";
import {
  formatMessageAtSourceRange,
  formatSourcePosition,
  formatSourceRangeStart
} from "./sourceLocations";

describe("source location formatting", () => {
  it("formats zero-based positions as one-based user-facing coordinates", () => {
    expect(formatSourcePosition({ line: 0, column: 0 })).toBe("1:1");
    expect(formatSourcePosition({ line: 4, column: 12 })).toBe("5:13");
  });

  it("formats the start of a source range", () => {
    expect(
      formatSourceRangeStart({
        start: { offset: 14, line: 2, column: 3 }
      })
    ).toBe("3:4");
  });

  it("appends source range starts to diagnostic messages", () => {
    expect(
      formatMessageAtSourceRange("Unexpected token", {
        start: { offset: 8, line: 1, column: 5 }
      })
    ).toBe("Unexpected token at 2:6");
  });
});
