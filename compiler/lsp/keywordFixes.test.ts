import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { findDeclarationKeywordReplacementsAtPosition } from "./keywordFixes";
import dedent from "compiler/utils/dedent";

function toNames(ast: ReturnType<typeof parseFile>, line: number, char: number) {
  return findDeclarationKeywordReplacementsAtPosition(ast, line, char).map((r) => r.to);
}

describe("findDeclarationKeywordReplacementsAtPosition", () => {
  it("suggests const -> val", () => {
    const ast = parseFile(tokenizeReader("const a = 1"));
    const replacements = findDeclarationKeywordReplacementsAtPosition(ast, 0, 2);
    expect(replacements).toEqual([
      {
        from: "const",
        to: "val",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
      }
    ]);
  });

  it("suggests let -> var (always) and let -> val (when not reassigned)", () => {
    const ast = parseFile(tokenizeReader("let a = 1"));
    const replacements = findDeclarationKeywordReplacementsAtPosition(ast, 0, 1);
    expect(toNames(ast, 0, 1)).toEqual(["var", "val"]);
    expect(replacements[0]).toMatchObject({ from: "let", to: "var" });
    expect(replacements[1]).toMatchObject({ from: "let", to: "val" });
  });

  it("suggests let -> var only when variable is reassigned", () => {
    const ast = parseFile(tokenizeReader("let a = 1\na = 2"));
    expect(toNames(ast, 0, 1)).toEqual(["var"]);
  });

  it("suggests let -> var only when variable is incremented/decremented", () => {
    const ast = parseFile(tokenizeReader("let a = 1\na++"));
    expect(toNames(ast, 0, 1)).toEqual(["var"]);

    const ast2 = parseFile(tokenizeReader("let a = 1\n--a"));
    expect(toNames(ast2, 0, 1)).toEqual(["var"]);
  });

  it("suggests var -> val only when not reassigned", () => {
    const ast = parseFile(tokenizeReader("var a = 1"));
    expect(toNames(ast, 0, 1)).toEqual(["val"]);

    const astReassigned = parseFile(tokenizeReader("var a = 1\na = 2"));
    expect(toNames(astReassigned, 0, 1)).toEqual([]);
  });

  it("suggests val -> var", () => {
    const ast = parseFile(tokenizeReader("val a = 1"));
    const replacements = findDeclarationKeywordReplacementsAtPosition(ast, 0, 2);
    expect(replacements).toEqual([
      {
        from: "val",
        to: "var",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
      }
    ]);
  });

  it("returns empty when cursor is not over a declaration keyword", () => {
    const ast = parseFile(tokenizeReader("a = 1"));
    expect(findDeclarationKeywordReplacementsAtPosition(ast, 0, 0)).toEqual([]);
  });

  it("finds declaration inside nested blocks using AST traversal", () => {
    const ast = parseFile(tokenizeReader("fun demo() {\nlet nested = 1\n}"));
    expect(toNames(ast, 1, 1)).toEqual(["var", "val"]);
  });

  it("finds declaration inside for initializer", () => {
    const ast = parseFile(tokenizeReader("for (let i = 0; i < 1; i += 1) { }"));
    // i is reassigned via +=, so only var is suggested
    expect(toNames(ast, 0, 6)).toEqual(["var"]);
  });

  it("finds declaration inside if branches", () => {
    const ast = parseFile(tokenizeReader("if (ok) { let a = 1 } else { let b = 2 }"));
    expect(toNames(ast, 0, 12)).toEqual(["var", "val"]);
  });

  it("finds declaration inside switch cases", () => {
    const ast = parseFile(tokenizeReader("switch (x) { case 1: let y = 2; default: let z = 3 }"));
    expect(toNames(ast, 0, 23)).toEqual(["var", "val"]);
  });

  it("finds declarations nested inside lambda initializers of outer declarations", () => {
    const source = "val run = () => {\n  let inner = 1\n}";
    const ast = parseFile(tokenizeReader(source));
    expect(toNames(ast, 1, 3)).toEqual(["var", "val"]);
    expect(toNames(ast, 0, 1)).toEqual(["var"]);
  });

  it("suppresses val suggestion for let when one of multiple declared names is reassigned", () => {
    const source = dedent`
      let a = 1, b = 2
      b = 3
    `;
    const ast = parseFile(tokenizeReader(source));
    expect(toNames(ast, 0, 1)).toEqual(["var"]);
  });
});
