import { describe, expect, it } from "vitest";
import { parseExpression } from "./parser";
import { tokenize, tokenizeReader } from "./tokenizer";
import { ListReader } from "compiler/utils/ListReader";

describe("parseExpression", () => {
    it("builds an AST for a single literal", () => {
        expect(parseExpression(tokenizeReader("10"))).toEqual(
            { kind: "IntLiteral", value: 10 }
        );
    });
})
