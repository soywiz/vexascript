import { describe, expect, it } from "vitest";
import { tokenize, toAstPreview } from "./tooling";

describe("tokenize", () => {
  it("tokenizes identifiers, numbers, and symbols", () => {
    expect(tokenize("foo = 42;")).toEqual([
      { type: "identifier", value: "foo" },
      { type: "symbol", value: "=" },
      { type: "number", value: "42" },
      { type: "symbol", value: ";" }
    ]);
  });

  it("returns an empty array when there are no tokens", () => {
    expect(tokenize("   \n\t  ")).toEqual([]);
  });
});

describe("toAstPreview", () => {
  it("builds an AST for a single let statement with integer addition", () => {
    expect(toAstPreview("let x = 10 + 2")).toEqual({
      kind: "Program",
      body: [{
        kind: "LetStatement",
        name: "x",
        initializer: {
          kind: "BinaryExpression",
          operator: "+",
          left: { kind: "IntLiteral", value: 10 },
          right: { kind: "IntLiteral", value: 2 }
        }
      }]
    });
  });

  it("parses left-associative addition", () => {
    expect(toAstPreview("let result = 1 + 2 + 3")).toEqual({
      kind: "Program",
      body: [{
        kind: "LetStatement",
        name: "result",
        initializer: {
          kind: "BinaryExpression",
          operator: "+",
          left: {
            kind: "BinaryExpression",
            operator: "+",
            left: { kind: "IntLiteral", value: 1 },
            right: { kind: "IntLiteral", value: 2 }
          },
          right: { kind: "IntLiteral", value: 3 }
        }
      }]
    });
  });
});
