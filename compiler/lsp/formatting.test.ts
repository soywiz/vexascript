import { describe, expect, it } from "vitest";
import { createFullDocumentFormatEdit } from "./formatting";

describe("createFullDocumentFormatEdit", () => {
  it("formats full document and replaces full range", () => {
    expect(createFullDocumentFormatEdit("let a=1\na+=2")).toEqual({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 4 }
      },
      newText: "let a = 1\na += 2"
    });
  });

  it("handles empty document range", () => {
    expect(createFullDocumentFormatEdit("")).toEqual({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      },
      newText: ""
    });
  });
});
