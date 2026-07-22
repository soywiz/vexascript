import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenType, type Token } from "./tokenizer";
import {
  hasLineBreakBetween,
  isClassMemberModifier,
  isEofToken,
  isLikelyStatementStart,
  typeTokenText,
} from "./tokenHelpers";

function token(type: TokenType, value: string, startLine = 1, endLine = 1): Token {
  return {
    type,
    value,
    range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: value.length } }
  } as unknown as Token;
}

describe("isEofToken", () => {
  it("returns true for eof token", () => {
    assert.equal(isEofToken(token(TokenType.END_OF_FILE, "")), true);
  });

  it("returns false for non-eof tokens", () => {
    assert.equal(isEofToken(token(TokenType.IDENTIFIER, "foo")), false);
    assert.equal(isEofToken(token(TokenType.SYMBOL, ";")), false);
  });

  it("returns false for undefined", () => {
    assert.equal(isEofToken(undefined), false);
  });
});

describe("hasLineBreakBetween", () => {
  it("returns true when b starts on a later line than a ends", () => {
    const a = token(TokenType.IDENTIFIER, "x", 1, 1);
    const b = token(TokenType.IDENTIFIER, "y", 2, 2);
    assert.equal(hasLineBreakBetween(a, b), true);
  });

  it("returns false when tokens are on the same line", () => {
    const a = token(TokenType.IDENTIFIER, "x", 1, 1);
    const b = token(TokenType.IDENTIFIER, "y", 1, 1);
    assert.equal(hasLineBreakBetween(a, b), false);
  });

  it("returns false when either token is undefined", () => {
    const a = token(TokenType.IDENTIFIER, "x", 1, 1);
    assert.equal(hasLineBreakBetween(undefined, a), false);
    assert.equal(hasLineBreakBetween(a, undefined), false);
    assert.equal(hasLineBreakBetween(undefined, undefined), false);
  });
});

describe("typeTokenText", () => {
  it("returns raw value for non-string tokens", () => {
    assert.equal(typeTokenText(token(TokenType.IDENTIFIER, "number")), "number");
    assert.equal(typeTokenText(token(TokenType.SYMBOL, ">")), ">");
  });

  it("JSON-escapes string token values", () => {
    assert.equal(typeTokenText(token(TokenType.STRING, "hello")), '"hello"');
    assert.equal(typeTokenText(token(TokenType.STRING, 'say "hi"')), '"say \\"hi\\""');
  });
});

describe("isLikelyStatementStart", () => {
  it("returns false for undefined", () => {
    assert.equal(isLikelyStatementStart(undefined), false);
  });

  it("returns true for { and }", () => {
    assert.equal(isLikelyStatementStart(token(TokenType.SYMBOL, "{")), true);
    assert.equal(isLikelyStatementStart(token(TokenType.SYMBOL, "}")), true);
  });

  it("returns false for other symbols", () => {
    assert.equal(isLikelyStatementStart(token(TokenType.SYMBOL, "+")), false);
    assert.equal(isLikelyStatementStart(token(TokenType.SYMBOL, ";")), false);
  });

  it("returns true for declaration keywords", () => {
    for (const kw of ["let", "var", "val", "const", "fun", "function", "class", "enum", "declare", "export"]) {
      assert.equal(isLikelyStatementStart(token(TokenType.IDENTIFIER, kw)), true, `Expected true for '${kw}'`);
    }
  });

  it("returns true for control-flow keywords", () => {
    for (const kw of ["if", "for", "while", "do", "switch", "try", "return", "throw", "break", "continue", "defer"]) {
      assert.equal(isLikelyStatementStart(token(TokenType.IDENTIFIER, kw)), true, `Expected true for '${kw}'`);
    }
  });

  it("returns false for non-keyword identifiers", () => {
    assert.equal(isLikelyStatementStart(token(TokenType.IDENTIFIER, "foo")), false);
    assert.equal(isLikelyStatementStart(token(TokenType.IDENTIFIER, "myVar")), false);
  });

  it("returns false for non-identifier token types", () => {
    assert.equal(isLikelyStatementStart(token(TokenType.NUMBER, "42")), false);
    assert.equal(isLikelyStatementStart(token(TokenType.STRING, "hello")), false);
  });
});

describe("isClassMemberModifier", () => {
  it("returns true for access modifiers", () => {
    assert.equal(isClassMemberModifier("public"), true);
    assert.equal(isClassMemberModifier("private"), true);
    assert.equal(isClassMemberModifier("protected"), true);
  });

  it("returns true for other modifiers", () => {
    assert.equal(isClassMemberModifier("static"), true);
    assert.equal(isClassMemberModifier("readonly"), true);
    assert.equal(isClassMemberModifier("abstract"), true);
    assert.equal(isClassMemberModifier("override"), true);
    assert.equal(isClassMemberModifier("async"), true);
    assert.equal(isClassMemberModifier("sync"), true);
  });

  it("returns false for non-modifier identifiers", () => {
    assert.equal(isClassMemberModifier("foo"), false);
    assert.equal(isClassMemberModifier("class"), false);
    assert.equal(isClassMemberModifier("constructor"), false);
  });
});
