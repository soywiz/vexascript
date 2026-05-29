import { describe, expect, it } from "vitest";
import { tokenize } from "compiler/parser/tokenizer";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";

describe("findDeclarationKeywordReplacementAtPosition", () => {
  it("suggests let <-> const", () => {
    const letTokens = tokenize("let a = 1");
    expect(findDeclarationKeywordReplacementAtPosition(letTokens, 0, 1)).toEqual({
      from: "let",
      to: "const",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 }
      }
    });

    const constTokens = tokenize("const a = 1");
    expect(findDeclarationKeywordReplacementAtPosition(constTokens, 0, 2)).toEqual({
      from: "const",
      to: "let",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
      }
    });
  });

  it("suggests var <-> val", () => {
    const varTokens = tokenize("var a = 1");
    expect(findDeclarationKeywordReplacementAtPosition(varTokens, 0, 0)).toEqual({
      from: "var",
      to: "val",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 }
      }
    });

    const valTokens = tokenize("val a = 1");
    expect(findDeclarationKeywordReplacementAtPosition(valTokens, 0, 2)).toEqual({
      from: "val",
      to: "var",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 }
      }
    });
  });

  it("returns null when cursor is not over a declaration keyword", () => {
    const tokens = tokenize("a = 1");
    expect(findDeclarationKeywordReplacementAtPosition(tokens, 0, 0)).toBeNull();
  });
});
