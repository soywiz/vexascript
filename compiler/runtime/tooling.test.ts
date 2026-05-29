import { describe, expect, it } from "vitest";
import { tokenize, toAstPreview } from "./tooling";

describe("tokenize", () => {
  it("tokeniza identificadores, numeros y simbolos", () => {
    expect(tokenize("foo = 42;")).toEqual([
      { type: "identifier", value: "foo" },
      { type: "symbol", value: "=" },
      { type: "number", value: "42" },
      { type: "symbol", value: ";" }
    ]);
  });

  it("devuelve array vacio cuando no hay tokens", () => {
    expect(tokenize("   \n\t  ")).toEqual([]);
  });
});

describe("toAstPreview", () => {
  it("construye un Program con TokenNode en body", () => {
    expect(toAstPreview("x")).toEqual({
      kind: "Program",
      body: [
        {
          kind: "TokenNode",
          token: { type: "identifier", value: "x" }
        }
      ]
    });
  });
});
