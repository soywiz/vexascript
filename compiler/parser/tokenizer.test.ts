import { describe } from "node:test";
import { tokenize } from "./tokenizer";
import { expect, it } from "vitest";

function simplifyTokens(input: string) {
    return tokenize(input).map(({ type, value }) => ({ type, value }));
}

describe("tokenizer", () => {
    it("tokenize expression", () => {
        expect(simplifyTokens("1 + 2")).toStrictEqual([
            { type: "number", value: "1" },
            { type: "symbol", value: "+" },
            { type: "number", value: "2" }
        ])
    })

    it("tokenizes expression without spaces", () => {
        expect(simplifyTokens("1+2")).toStrictEqual([
            { type: "number", value: "1" },
            { type: "symbol", value: "+" },
            { type: "number", value: "2" }
        ])
    })

    it("tokenizes multi-character operators", () => {
        expect(simplifyTokens("2**3 || 4 && 5")).toStrictEqual([
            { type: "number", value: "2" },
            { type: "symbol", value: "**" },
            { type: "number", value: "3" },
            { type: "symbol", value: "||" },
            { type: "number", value: "4" },
            { type: "symbol", value: "&&" },
            { type: "number", value: "5" }
        ])
    })

    it("tokenizes relational and equality operators", () => {
        expect(simplifyTokens("a < b <= c > d >= e === f !== g = h")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "<" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "<=" },
            { type: "identifier", value: "c" },
            { type: "symbol", value: ">" },
            { type: "identifier", value: "d" },
            { type: "symbol", value: ">=" },
            { type: "identifier", value: "e" },
            { type: "symbol", value: "===" },
            { type: "identifier", value: "f" },
            { type: "symbol", value: "!==" },
            { type: "identifier", value: "g" },
            { type: "symbol", value: "=" },
            { type: "identifier", value: "h" }
        ])
    })

    it("tokenizes safe and non-null member-access operators", () => {
        expect(simplifyTokens("a?.b!.c")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "?." },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "!." },
            { type: "identifier", value: "c" }
        ])
    })

    it("tokenizes compound assignment operators", () => {
        expect(simplifyTokens("a += b -= c %= d *= e /= f &= g |= h &&= i ||= j")).toStrictEqual([
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

    it("tokenizes string literals with escapes", () => {
        expect(simplifyTokens("\"hello\\n\\r\\t...world\" \"hi\\u0020there\"")).toStrictEqual([
            { type: "string", value: "hello\n\r\t...world" },
            { type: "string", value: "hi there" }
        ])
    })

    it("tokenizes single-quoted string literals", () => {
        expect(simplifyTokens("'abc' 'it\\'s' 'path\\\\file'")).toStrictEqual([
            { type: "string", value: "abc" },
            { type: "string", value: "it's" },
            { type: "string", value: "path\\file" }
        ])
    })

    it("tracks offset/line/column ranges for tokens", () => {
        const tokens = tokenize("a\n+ 2");
        expect(tokens.map((token) => token.range)).toEqual([
            {
                start: { offset: 0, line: 0, column: 0 },
                end: { offset: 1, line: 0, column: 1 }
            },
            {
                start: { offset: 2, line: 1, column: 0 },
                end: { offset: 3, line: 1, column: 1 }
            },
            {
                start: { offset: 4, line: 1, column: 2 },
                end: { offset: 5, line: 1, column: 3 }
            }
        ]);
    });
})
