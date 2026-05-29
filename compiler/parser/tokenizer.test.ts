import { describe } from "node:test";
import { tokenize } from "./tokenizer";
import { expect, it } from "vitest";

describe("tokenizer", () => {
    it("tokenize expression", () => {
        expect(tokenize("1 + 2")).toStrictEqual([
            { type: "number", value: "1" },
            { type: "symbol", value: "+" },
            { type: "number", value: "2" }
        ])
    })

    it("tokenizes expression without spaces", () => {
        expect(tokenize("1+2")).toStrictEqual([
            { type: "number", value: "1" },
            { type: "symbol", value: "+" },
            { type: "number", value: "2" }
        ])
    })

    it("tokenizes multi-character operators", () => {
        expect(tokenize("2**3 || 4 && 5")).toStrictEqual([
            { type: "number", value: "2" },
            { type: "symbol", value: "**" },
            { type: "number", value: "3" },
            { type: "symbol", value: "||" },
            { type: "number", value: "4" },
            { type: "symbol", value: "&&" },
            { type: "number", value: "5" }
        ])
    })
})
