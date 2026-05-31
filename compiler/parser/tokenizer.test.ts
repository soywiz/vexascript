import { describe } from "node:test";
import { tokenize } from "./tokenizer";
import { expect, it } from "vitest";

function simplifyTokens(input: string, includeEof: boolean = false) {
    const tokens = tokenize(input);
    const filteredTokens = includeEof ? tokens : tokens.filter((token) => token.type !== "eof");
    return filteredTokens.map(({ type, value }) => ({ type, value }));
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

    it("tokenizes decimal and scientific numbers", () => {
        expect(simplifyTokens("10.573 + 10e-3")).toStrictEqual([
            { type: "number", value: "10.573" },
            { type: "symbol", value: "+" },
            { type: "number", value: "10e-3" }
        ])
    })

    it("tokenizes bigint and long suffix literals", () => {
        expect(simplifyTokens("10n + 20L")).toStrictEqual([
            { type: "number", value: "10n" },
            { type: "symbol", value: "+" },
            { type: "number", value: "20L" }
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

    it("tokenizes range operator", () => {
        expect(simplifyTokens("0 ... 10")).toStrictEqual([
            { type: "number", value: "0" },
            { type: "symbol", value: "..." },
            { type: "number", value: "10" }
        ])
    })

    it("tokenizes relational and equality operators", () => {
        expect(simplifyTokens("a < b <= c > d >= e == f != g === h !== i = j")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "<" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "<=" },
            { type: "identifier", value: "c" },
            { type: "symbol", value: ">" },
            { type: "identifier", value: "d" },
            { type: "symbol", value: ">=" },
            { type: "identifier", value: "e" },
            { type: "symbol", value: "==" },
            { type: "identifier", value: "f" },
            { type: "symbol", value: "!=" },
            { type: "identifier", value: "g" },
            { type: "symbol", value: "===" },
            { type: "identifier", value: "h" },
            { type: "symbol", value: "!==" },
            { type: "identifier", value: "i" },
            { type: "symbol", value: "=" },
            { type: "identifier", value: "j" }
        ])
    })

    it("tokenizes shift operators", () => {
        expect(simplifyTokens("a << b >> c >>> d")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "<<" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: ">>" },
            { type: "identifier", value: "c" },
            { type: "symbol", value: ">>>" },
            { type: "identifier", value: "d" }
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
        expect(simplifyTokens("a += b -= c %= d *= e /= f &= g |= h &&= i ||= j <<= k >>= l >>>= m")).toStrictEqual([
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
            { type: "identifier", value: "j" },
            { type: "symbol", value: "<<=" },
            { type: "identifier", value: "k" },
            { type: "symbol", value: ">>=" },
            { type: "identifier", value: "l" },
            { type: "symbol", value: ">>>=" },
            { type: "identifier", value: "m" }
        ])
    })

    it("tokenizes increment and decrement operators", () => {
        expect(simplifyTokens("++a a++ --b b--")).toStrictEqual([
            { type: "symbol", value: "++" },
            { type: "identifier", value: "a" },
            { type: "identifier", value: "a" },
            { type: "symbol", value: "++" },
            { type: "symbol", value: "--" },
            { type: "identifier", value: "b" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "--" }
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

    it("tokenizes template literals without interpolation", () => {
        expect(simplifyTokens("`hello world`")).toStrictEqual([
            { type: "string", value: "hello world" }
        ])
    })

    it("tokenizes template literals with interpolation as concatenation", () => {
        expect(simplifyTokens("`hello ${name}`")).toStrictEqual([
            { type: "string", value: "hello " },
            { type: "symbol", value: "+" },
            { type: "symbol", value: "(" },
            { type: "identifier", value: "name" },
            { type: "symbol", value: ")" },
            { type: "symbol", value: "+" },
            { type: "string", value: "" }
        ])
    })

    it("ignores single-line comments", () => {
        expect(simplifyTokens("let a = 1 // trailing\nlet b = 2")).toStrictEqual([
            { type: "identifier", value: "let" },
            { type: "identifier", value: "a" },
            { type: "symbol", value: "=" },
            { type: "number", value: "1" },
            { type: "identifier", value: "let" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "=" },
            { type: "number", value: "2" }
        ])
    })

    it("attaches single-line comments to the next token as leading comments", () => {
        const tokens = tokenize("let a = 1 // trailing\nlet b = 2");
        expect(tokens[4]?.leadingComments?.map((comment) => ({ kind: comment.kind, value: comment.value }))).toEqual([
            { kind: "line", value: "// trailing" }
        ]);
    });

    it("ignores block comments, including multiline comments", () => {
        expect(simplifyTokens("let a = /* inline */ 1\n/* multi\nline */\nlet b = 2")).toStrictEqual([
            { type: "identifier", value: "let" },
            { type: "identifier", value: "a" },
            { type: "symbol", value: "=" },
            { type: "number", value: "1" },
            { type: "identifier", value: "let" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "=" },
            { type: "number", value: "2" }
        ])
    })

    it("attaches block comments to the next token as leading comments", () => {
        const tokens = tokenize("let a = /* inline */ 1\n/* multi\nline */\nlet b = 2");
        expect(tokens[3]?.leadingComments?.map((comment) => ({ kind: comment.kind, value: comment.value }))).toEqual([
            { kind: "block", value: "/* inline */" }
        ]);
        expect(tokens[4]?.leadingComments?.map((comment) => ({ kind: comment.kind, value: comment.value }))).toEqual([
            { kind: "block", value: "/* multi\nline */" }
        ]);
    });

    it("attaches trailing comments to the eof token", () => {
        const tokens = tokenize("let a = 1\n// trailing");
        const eof = tokens[tokens.length - 1];
        expect(eof?.type).toBe("eof");
        expect(eof?.leadingComments?.map((comment) => ({ kind: comment.kind, value: comment.value }))).toEqual([
            { kind: "line", value: "// trailing" }
        ]);
    });

    it("always emits an eof token", () => {
        expect(simplifyTokens("1 + 2", true).at(-1)).toEqual({ type: "eof", value: "<eof>" });
        expect(simplifyTokens("", true)).toEqual([{ type: "eof", value: "<eof>" }]);
    });

    it("throws when block comment is unterminated", () => {
        expect(() => tokenize("let a = 1 /* unterminated")).toThrow("Unterminated block comment")
    })

    it("throws when scientific notation exponent is invalid", () => {
        expect(() => tokenize("10e+")).toThrow("Invalid exponent in number literal")
    })

    it("tracks offset/line/column ranges for tokens", () => {
        const tokens = tokenize("a\n+ 2").filter((token) => token.type !== "eof");
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

    it("tracks eof token range at the end of input", () => {
        const tokens = tokenize("a\n+ 2");
        const eof = tokens[tokens.length - 1];
        expect(eof?.type).toBe("eof");
        expect(eof?.range).toEqual({
            start: { offset: 5, line: 1, column: 3 },
            end: { offset: 5, line: 1, column: 3 }
        });
    });
})
