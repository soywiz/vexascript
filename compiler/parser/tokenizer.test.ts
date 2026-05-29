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
}) 