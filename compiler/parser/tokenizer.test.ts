import { describe, expect, it } from "../test/expect";
import { tokenize } from "./tokenizer";

function simplifyTokens(input: string, includeEof: boolean = false) {
    const tokens = tokenize(input);
    const filteredTokens = includeEof ? tokens : tokens.filter((token) => token.type !== "eof");
    return filteredTokens.map(({ type, value }) => ({ type, value }));
}

describe("tokenizer", () => {
    it("skips an initial shebang line as trivia", () => {
        const tokens = tokenize("#!/usr/bin/env vexa\nval answer = 42");

        expect(tokens.filter((token) => token.type !== "eof").map(({ type, value }) => ({ type, value }))).toStrictEqual([
            { type: "identifier", value: "val" },
            { type: "identifier", value: "answer" },
            { type: "symbol", value: "=" },
            { type: "number", value: "42" }
        ]);
        expect(tokens[0]?.leadingComments?.[0]).toMatchObject({
            kind: "line",
            value: "#!/usr/bin/env vexa",
            range: {
                start: { offset: 0, line: 0, column: 0 },
                end: { offset: 19, line: 0, column: 19 }
            }
        });
        expect(tokens[0]?.range.start).toEqual({ offset: 20, line: 1, column: 0 });
    });

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

    it("tokenizes leading-dot decimal and scientific numbers", () => {
        expect(simplifyTokens(".5 + .01 + .5e-2")).toStrictEqual([
            { type: "number", value: ".5" },
            { type: "symbol", value: "+" },
            { type: "number", value: ".01" },
            { type: "symbol", value: "+" },
            { type: "number", value: ".5e-2" }
        ])
    })

    it("tokenizes trailing-dot decimal numbers", () => {
        expect(simplifyTokens("0. 1.;")).toStrictEqual([
            { type: "number", value: "0." },
            { type: "number", value: "1." },
            { type: "symbol", value: ";" }
        ])
    })

    it("tokenizes bigint and long suffix literals", () => {
        expect(simplifyTokens("10n + 20L")).toStrictEqual([
            { type: "number", value: "10n" },
            { type: "symbol", value: "+" },
            { type: "number", value: "20L" }
        ])
    })

    it("tokenizes TypeScript numeric separators and non-decimal literals", () => {
        expect(simplifyTokens("1_000 + 0xff + 0b1010 + 0o755 + 0xfn")).toStrictEqual([
            { type: "number", value: "1_000" },
            { type: "symbol", value: "+" },
            { type: "number", value: "0xff" },
            { type: "symbol", value: "+" },
            { type: "number", value: "0b1010" },
            { type: "symbol", value: "+" },
            { type: "number", value: "0o755" },
            { type: "symbol", value: "+" },
            { type: "number", value: "0xfn" }
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

    it("tokenizes inclusive range operator", () => {
        expect(simplifyTokens("0 ... 10")).toStrictEqual([
            { type: "number", value: "0" },
            { type: "symbol", value: "..." },
            { type: "number", value: "10" }
        ])
    })

    it("tokenizes exclusive range operator", () => {
        expect(simplifyTokens("0 ..< 10")).toStrictEqual([
            { type: "number", value: "0" },
            { type: "symbol", value: "..<" },
            { type: "number", value: "10" }
        ])
    })

    it("keeps dot-based operators and member access distinct from leading-dot numbers", () => {
        expect(simplifyTokens("value.method() 0...10 0..<10 value..chain()")).toStrictEqual([
            { type: "identifier", value: "value" },
            { type: "symbol", value: "." },
            { type: "identifier", value: "method" },
            { type: "symbol", value: "(" },
            { type: "symbol", value: ")" },
            { type: "number", value: "0" },
            { type: "symbol", value: "..." },
            { type: "number", value: "10" },
            { type: "number", value: "0" },
            { type: "symbol", value: "..<" },
            { type: "number", value: "10" },
            { type: "identifier", value: "value" },
            { type: "symbol", value: ".." },
            { type: "identifier", value: "chain" },
            { type: "symbol", value: "(" },
            { type: "symbol", value: ")" }
        ])
    })

    it("tokenizes chain operator", () => {
        expect(simplifyTokens("value ..method()")).toStrictEqual([
            { type: "identifier", value: "value" },
            { type: "symbol", value: ".." },
            { type: "identifier", value: "method" },
            { type: "symbol", value: "(" },
            { type: "symbol", value: ")" }
        ])
    })

    it("tokenizes double-colon rename operator", () => {
        expect(simplifyTokens("name :: displayName")).toStrictEqual([
            { type: "identifier", value: "name" },
            { type: "symbol", value: "::" },
            { type: "identifier", value: "displayName" }
        ])
    })

    it("tokenizes arrow function operator", () => {
        expect(simplifyTokens("a => 10")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "=>" },
            { type: "number", value: "10" }
        ])
    })

    it("tokenizes tail-lambda parameter arrow operator", () => {
        expect(simplifyTokens("{ a, b, c -> a + b + c }")).toStrictEqual([
            { type: "symbol", value: "{" },
            { type: "identifier", value: "a" },
            { type: "symbol", value: "," },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "," },
            { type: "identifier", value: "c" },
            { type: "symbol", value: "->" },
            { type: "identifier", value: "a" },
            { type: "symbol", value: "+" },
            { type: "identifier", value: "b" },
            { type: "symbol", value: "+" },
            { type: "identifier", value: "c" },
            { type: "symbol", value: "}" }
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
        expect(simplifyTokens("a += b -= c %= d *= e /= f &= g |= h ^= i &&= j ||= k <<= l >>= m >>>= n")).toStrictEqual([
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
            { type: "symbol", value: "^=" },
            { type: "identifier", value: "i" },
            { type: "symbol", value: "&&=" },
            { type: "identifier", value: "j" },
            { type: "symbol", value: "||=" },
            { type: "identifier", value: "k" },
            { type: "symbol", value: "<<=" },
            { type: "identifier", value: "l" },
            { type: "symbol", value: ">>=" },
            { type: "identifier", value: "m" },
            { type: "symbol", value: ">>>=" },
            { type: "identifier", value: "n" }
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

    it("tokenizes annotation syntax with '@'", () => {
        expect(simplifyTokens('@JsName("rgba")')).toStrictEqual([
            { type: "symbol", value: "@" },
            { type: "identifier", value: "JsName" },
            { type: "symbol", value: "(" },
            { type: "string", value: "rgba" },
            { type: "symbol", value: ")" }
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

    it("tokenizes declaration-sized template literals as one exact segment", () => {
        const payload = "interface Example { value: string }\n".repeat(10_000)
        expect(simplifyTokens("`" + payload + "`")).toStrictEqual([
            { type: "string", value: payload }
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

    it("tokenizes nested template literals inside interpolations", () => {
        expect(simplifyTokens("`outer ${`inner ${value}`}`")).toStrictEqual([
            { type: "string", value: "outer " },
            { type: "symbol", value: "+" },
            { type: "symbol", value: "(" },
            { type: "string", value: "inner " },
            { type: "symbol", value: "+" },
            { type: "symbol", value: "(" },
            { type: "identifier", value: "value" },
            { type: "symbol", value: ")" },
            { type: "symbol", value: "+" },
            { type: "string", value: "" },
            { type: "symbol", value: ")" },
            { type: "symbol", value: "+" },
            { type: "string", value: "" }
        ])
    })

    it("tokenizes regular expression literals inside template interpolations", () => {
        expect(simplifyTokens("`${text.replace(/\\s+/g, \"\")}`")).toStrictEqual([
            { type: "string", value: "" },
            { type: "symbol", value: "+" },
            { type: "symbol", value: "(" },
            { type: "identifier", value: "text" },
            { type: "symbol", value: "." },
            { type: "identifier", value: "replace" },
            { type: "symbol", value: "(" },
            { type: "regexp", value: "/\\s+/g" },
            { type: "symbol", value: "," },
            { type: "string", value: "" },
            { type: "symbol", value: ")" },
            { type: "symbol", value: ")" },
            { type: "symbol", value: "+" },
            { type: "string", value: "" }
        ])
    })

    it("supports common JavaScript escape sequences in strings and templates", () => {
        expect(simplifyTokens("\"\\x41\\b\\f\\v\\0\\/\\$\\*\\w\"")).toStrictEqual([
            { type: "string", value: "A\b\f\v\0/$*w" }
        ])

        expect(simplifyTokens("`\\x41\\b\\f\\v\\0\\/\\$\\*\\w`")).toStrictEqual([
            { type: "string", value: "A\b\f\v\0/$*w" }
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

    it("attaches triple-slash documentation comments as leading line comments", () => {
        const tokens = tokenize("/// summary\n/// details\nfun find() { }");
        expect(tokens[0]?.leadingComments?.map((comment) => ({ kind: comment.kind, value: comment.value }))).toEqual([
            { kind: "line", value: "/// summary" },
            { kind: "line", value: "/// details" }
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
    it("tokenizes regular expression literals contextually", () => {
        expect(simplifyTokens("let re = /a\\/b+/gi; let quotient = total / count")).toStrictEqual([
            { type: "identifier", value: "let" },
            { type: "identifier", value: "re" },
            { type: "symbol", value: "=" },
            { type: "regexp", value: "/a\\/b+/gi" },
            { type: "symbol", value: ";" },
            { type: "identifier", value: "let" },
            { type: "identifier", value: "quotient" },
            { type: "symbol", value: "=" },
            { type: "identifier", value: "total" },
            { type: "symbol", value: "/" },
            { type: "identifier", value: "count" }
        ]);
    })

    it("tokenizes regular expression literals after export default", () => {
        expect(simplifyTokens("export default /[\\0-\\x1F]/g")).toStrictEqual([
            { type: "identifier", value: "export" },
            { type: "identifier", value: "default" },
            { type: "regexp", value: "/[\\0-\\x1F]/g" }
        ]);
    })

    describe("embedded XML / JSX", () => {
        function jsxTokens(input: string) {
            return tokenize(input, { jsx: true })
                .filter((token) => token.type !== "eof")
                .map(({ type, value }) => ({ type, value }));
        }

        it("tokenizes a self-closing element with attributes", () => {
            expect(jsxTokens('val x = <div class="a" id={y} />')).toStrictEqual([
                { type: "identifier", value: "val" },
                { type: "identifier", value: "x" },
                { type: "symbol", value: "=" },
                { type: "symbol", value: "<" },
                { type: "identifier", value: "div" },
                { type: "identifier", value: "class" },
                { type: "symbol", value: "=" },
                { type: "string", value: "a" },
                { type: "identifier", value: "id" },
                { type: "symbol", value: "=" },
                { type: "symbol", value: "{" },
                { type: "identifier", value: "y" },
                { type: "symbol", value: "}" },
                { type: "symbol", value: "/" },
                { type: "symbol", value: ">" }
            ]);
        });

        it("tokenizes element text content as jsxText, including hazardous characters", () => {
            expect(jsxTokens("return <p>it's 100% done</p>")).toStrictEqual([
                { type: "identifier", value: "return" },
                { type: "symbol", value: "<" },
                { type: "identifier", value: "p" },
                { type: "symbol", value: ">" },
                { type: "jsxText", value: "it's 100% done" },
                { type: "symbol", value: "<" },
                { type: "symbol", value: "/" },
                { type: "identifier", value: "p" },
                { type: "symbol", value: ">" }
            ]);
        });

        it("tokenizes nested elements and expression containers", () => {
            expect(jsxTokens("return <ul>{items}<li>x</li></ul>")).toStrictEqual([
                { type: "identifier", value: "return" },
                { type: "symbol", value: "<" },
                { type: "identifier", value: "ul" },
                { type: "symbol", value: ">" },
                { type: "symbol", value: "{" },
                { type: "identifier", value: "items" },
                { type: "symbol", value: "}" },
                { type: "symbol", value: "<" },
                { type: "identifier", value: "li" },
                { type: "symbol", value: ">" },
                { type: "jsxText", value: "x" },
                { type: "symbol", value: "<" },
                { type: "symbol", value: "/" },
                { type: "identifier", value: "li" },
                { type: "symbol", value: ">" },
                { type: "symbol", value: "<" },
                { type: "symbol", value: "/" },
                { type: "identifier", value: "ul" },
                { type: "symbol", value: ">" }
            ]);
        });

        it("does not treat less-than between operands as JSX", () => {
            expect(jsxTokens("a < b")).toStrictEqual([
                { type: "identifier", value: "a" },
                { type: "symbol", value: "<" },
                { type: "identifier", value: "b" }
            ]);
        });

        it("throws on unexpected character in JSX opening tag (no infinite loop)", () => {
            expect(() => jsxTokens("fun demo() {\n  return <d\n}")).toThrow("Unexpected character in JSX opening tag");
        });

        it("keeps less-than as a plain symbol when JSX is disabled", () => {
            expect(
                tokenize("return <div>", { jsx: false })
                    .filter((token) => token.type !== "eof")
                    .map(({ type, value }) => ({ type, value }))
            ).toStrictEqual([
                { type: "identifier", value: "return" },
                { type: "symbol", value: "<" },
                { type: "identifier", value: "div" },
                { type: "symbol", value: ">" }
            ]);
        });
    });

    it("tokenizes the three-way comparison operator as a single token", () => {
        expect(simplifyTokens("a <=> b")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "<=>" },
            { type: "identifier", value: "b" }
        ]);
    });

    it("still tokenizes <= when not followed by >", () => {
        expect(simplifyTokens("a <= b")).toStrictEqual([
            { type: "identifier", value: "a" },
            { type: "symbol", value: "<=" },
            { type: "identifier", value: "b" }
        ]);
    });

})
