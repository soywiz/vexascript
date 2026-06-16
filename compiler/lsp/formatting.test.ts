import { describe, expect, it } from "../test/expect";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "./formatting";

describe("createFullDocumentFormatEdit", () => {
  it("formats full document and replaces full range", () => {
    expect(createFullDocumentFormatEdit("let a=1\na+=2")).toEqual({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 4 }
      },
      newText: "let a = 1\na += 2\n"
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

  it("does not duplicate the final newline when the formatter output already ends with one", () => {
    expect(createFullDocumentFormatEdit("let a = 1\n")).toEqual({
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 }
      },
      newText: "let a = 1\n"
    });
  });
});

describe("createRangeFormatEdit", () => {
  it("formats a selected range and keeps the requested replacement range", () => {
    expect(createRangeFormatEdit("let a=1\nlet b=2\nlet c=3", {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 7 }
    })).toEqual({
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 7 }
      },
      newText: "let b = 2"
    });
  });

  it("preserves the base indentation for full-line selections inside blocks", () => {
    expect(createRangeFormatEdit("fun main(){\n  let a=1\n  a+=2\n}", {
      start: { line: 1, character: 0 },
      end: { line: 3, character: 0 }
    })).toEqual({
      range: {
        start: { line: 1, character: 0 },
        end: { line: 3, character: 0 }
      },
      newText: "  let a = 1\n  a += 2\n"
    });
  });

  it("formats nested selected blocks relative to the selected indentation", () => {
    expect(createRangeFormatEdit("fun main(){\n  if(x){\n  y=1\n  }\n}", {
      start: { line: 1, character: 0 },
      end: { line: 4, character: 0 }
    })).toEqual({
      range: {
        start: { line: 1, character: 0 },
        end: { line: 4, character: 0 }
      },
      newText: "  if (x) {\n    y = 1\n  }\n"
    });
  });
});
