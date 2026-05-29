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

    it("tokenizes compound assignment operators", () => {
        expect(tokenize("a += b -= c %= d *= e /= f &= g |= h &&= i ||= j")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "+=" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "-=" },
            { type: "identifier", value: "c" },
            { type: "symbol", value: "%=" },
            { type: "identifier", value: "d" },
            { type: "symbol", value: "*=" },
            { type: "identifier", value: "e" },
            { type: "symbol", value: "/=" },
            { type: "identifier", value: "f" },
            { type: "symbol", value: "&=" },
            { type: "identifier", value: "g" },
            { type: "symbol", value: "|=" },
            { type: "identifier", value: "h" },
            { type: "symbol", value: "&&=" },
            { type: "identifier", value: "i" },
            { type: "symbol", value: "||=" },
            { type: "identifier", value: "j" }
        ])
    })
})
