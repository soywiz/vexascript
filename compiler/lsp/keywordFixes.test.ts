import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";

describe("findDeclarationKeywordReplacementAtPosition", () => {
  it("suggests let <-> const", () => {
    const letAst = parseFile(tokenizeReader("let a = 1"));
    expect(findDeclarationKeywordReplacementAtPosition(letAst, 0, 1)).toEqual({
      from: "let",
      to: "const",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 }
      }
    });

    const constAst = parseFile(tokenizeReader("const a = 1"));
    expect(findDeclarationKeywordReplacementAtPosition(constAst, 0, 2)).toEqual({
      from: "const",
      to: "let",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
      }
    });
  });

  it("suggests var <-> val", () => {
    const varAst = parseFile(tokenizeReader("var a = 1"));
    expect(findDeclarationKeywordReplacementAtPosition(varAst, 0, 0)).toEqual({
      from: "var",
      to: "val",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 }
      }
    });

    const valAst = parseFile(tokenizeReader("val a = 1"));
    expect(findDeclarationKeywordReplacementAtPosition(valAst, 0, 2)).toEqual({
      from: "val",
      to: "var",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 }
      }
    });
  });

  it("returns null when cursor is not over a declaration keyword", () => {
    const ast = parseFile(tokenizeReader("a = 1"));
    expect(findDeclarationKeywordReplacementAtPosition(ast, 0, 0)).toBeNull();
  });

  it("finds declaration inside nested blocks using AST traversal", () => {
    const ast = parseFile(tokenizeReader("fun demo() {\nlet nested = 1\n}"));
    expect(findDeclarationKeywordReplacementAtPosition(ast, 1, 1)).toEqual({
      from: "let",
      to: "const",
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 3 }
      }
    });
  });

  it("finds declaration inside for initializer", () => {
    const ast = parseFile(tokenizeReader("for (let i = 0; i < 1; i += 1) { }"));
    expect(findDeclarationKeywordReplacementAtPosition(ast, 0, 6)).toEqual({
      from: "let",
      to: "const",
      range: {
        start: { line: 0, character: 5 },
        end: { line: 0, character: 8 }
      }
    });
  });

  it("finds declaration inside if branches", () => {
    const ast = parseFile(tokenizeReader("if (ok) { let a = 1 } else { let b = 2 }"));
    expect(findDeclarationKeywordReplacementAtPosition(ast, 0, 12)).toEqual({
      from: "let",
      to: "const",
      range: {
        start: { line: 0, character: 10 },
        end: { line: 0, character: 13 }
      }
    });
  });

  it("finds declaration inside switch cases", () => {
    const ast = parseFile(tokenizeReader("switch (x) { case 1: let y = 2; default: let z = 3 }"));
    expect(findDeclarationKeywordReplacementAtPosition(ast, 0, 23)).toEqual({
      from: "let",
      to: "const",
      range: {
        start: { line: 0, character: 21 },
        end: { line: 0, character: 24 }
      }
    });
  });
});
