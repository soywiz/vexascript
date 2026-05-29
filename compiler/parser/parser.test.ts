import { describe, expect, it } from "vitest";
import { ParseError, Parser, parseExpression, parseFile, parseProgram, parseStatement } from "./parser";
import { tokenizeReader } from "./tokenizer";

describe("parseExpression", () => {
    it("builds an AST for a single literal", () => {
        expect(parseExpression(tokenizeReader("10"))).toEqual(
            { kind: "IntLiteral", value: 10 }
        );
    });

    it("builds an AST for escaped string literal", () => {
        expect(parseExpression(tokenizeReader("\"hello\\n\\r\\t...world\""))).toEqual(
            { kind: "StringLiteral", value: "hello\n\r\t...world" }
        );
    });

    it("builds an AST for unicode escaped string literal", () => {
        expect(parseExpression(tokenizeReader("\"hi\\u0020there\""))).toEqual(
            { kind: "StringLiteral", value: "hi there" }
        );
    });

    it("builds an AST for single-quoted string literal", () => {
        expect(parseExpression(tokenizeReader("'abc'"))).toEqual(
            { kind: "StringLiteral", value: "abc" }
        );
    });

    it("builds an AST for addition expression", () => {
        expect(parseExpression(tokenizeReader("1+2"))).toEqual({
            kind: "BinaryExpression",
            operator: "+",
            left: { kind: "IntLiteral", value: 1 },
            right: { kind: "IntLiteral", value: 2 }
        });
    });

    it("builds an AST for identifier plus integer", () => {
        expect(parseExpression(tokenizeReader("a + 1"))).toEqual({
            kind: "BinaryExpression",
            operator: "+",
            left: { kind: "Identifier", name: "a" },
            right: { kind: "IntLiteral", value: 1 }
        });
    });

    it("builds an AST for unary plus", () => {
        expect(parseExpression(tokenizeReader("+1"))).toEqual({
            kind: "UnaryExpression",
            operator: "+",
            argument: { kind: "IntLiteral", value: 1 }
        });
    });

    it("builds an AST for unary minus with parenthesized expression", () => {
        expect(parseExpression(tokenizeReader("-(1 + 2)"))).toEqual({
            kind: "UnaryExpression",
            operator: "-",
            argument: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "IntLiteral", value: 1 },
                right: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("builds an AST for nested array literals", () => {
        expect(parseExpression(tokenizeReader("[1, 2, [3, 4]]"))).toEqual({
            kind: "ArrayLiteral",
            elements: [
                { kind: "IntLiteral", value: 1 },
                { kind: "IntLiteral", value: 2 },
                {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                }
            ]
        });
    });

    it("builds an AST for object literals", () => {
        expect(parseExpression(tokenizeReader("{a: 1, b: 2}"))).toEqual({
            kind: "ObjectLiteral",
            properties: [
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "a" },
                    value: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "b" },
                    value: { kind: "IntLiteral", value: 2 }
                }
            ]
        });
    });

    it("builds an AST for chained member/index access", () => {
        expect(parseExpression(tokenizeReader("a.b[1].c"))).toEqual({
            kind: "MemberExpression",
            object: {
                kind: "MemberExpression",
                object: {
                    kind: "MemberExpression",
                    object: { kind: "Identifier", name: "a" },
                    property: { kind: "Identifier", name: "b" },
                    computed: false
                },
                property: { kind: "IntLiteral", value: 1 },
                computed: true
            },
            property: { kind: "Identifier", name: "c" },
            computed: false
        });
    });

    it("builds an AST for safe and non-null member access", () => {
        expect(parseExpression(tokenizeReader("a?.b!.c"))).toEqual({
            kind: "MemberExpression",
            object: {
                kind: "MemberExpression",
                object: { kind: "Identifier", name: "a" },
                property: { kind: "Identifier", name: "b" },
                computed: false,
                optional: true
            },
            property: { kind: "Identifier", name: "c" },
            computed: false,
            nonNullAsserted: true
        });
    });

    it("builds an AST for mixed safe access and computed member access", () => {
        expect(parseExpression(tokenizeReader("b?.c[\"d\"]"))).toEqual({
            kind: "MemberExpression",
            object: {
                kind: "MemberExpression",
                object: { kind: "Identifier", name: "b" },
                property: { kind: "Identifier", name: "c" },
                computed: false,
                optional: true
            },
            property: { kind: "StringLiteral", value: "d" },
            computed: true
        });
    });

    it("builds an AST for multiplication with parenthesized addition", () => {
        expect(parseExpression(tokenizeReader("1*(2+3)"))).toEqual({
            kind: "BinaryExpression",
            operator: "*",
            left: { kind: "IntLiteral", value: 1 },
            right: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "IntLiteral", value: 2 },
                right: { kind: "IntLiteral", value: 3 }
            }
        });
    });

    it("applies precedence for subtraction, division, and modulo", () => {
        expect(parseExpression(tokenizeReader("10-6/3%2"))).toEqual({
            kind: "BinaryExpression",
            operator: "-",
            left: { kind: "IntLiteral", value: 10 },
            right: {
                kind: "BinaryExpression",
                operator: "%",
                left: {
                    kind: "BinaryExpression",
                    operator: "/",
                    left: { kind: "IntLiteral", value: 6 },
                    right: { kind: "IntLiteral", value: 3 }
                },
                right: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("parses exponentiation as right-associative", () => {
        expect(parseExpression(tokenizeReader("2**3**2"))).toEqual({
            kind: "BinaryExpression",
            operator: "**",
            left: { kind: "IntLiteral", value: 2 },
            right: {
                kind: "BinaryExpression",
                operator: "**",
                left: { kind: "IntLiteral", value: 3 },
                right: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("applies precedence for bitwise operators", () => {
        expect(parseExpression(tokenizeReader("1|2^3&4"))).toEqual({
            kind: "BinaryExpression",
            operator: "|",
            left: { kind: "IntLiteral", value: 1 },
            right: {
                kind: "BinaryExpression",
                operator: "^",
                left: { kind: "IntLiteral", value: 2 },
                right: {
                    kind: "BinaryExpression",
                    operator: "&",
                    left: { kind: "IntLiteral", value: 3 },
                    right: { kind: "IntLiteral", value: 4 }
                }
            }
        });
    });

    it("applies precedence for logical and bitwise operators", () => {
        expect(parseExpression(tokenizeReader("1||2&&3|4"))).toEqual({
            kind: "BinaryExpression",
            operator: "||",
            left: { kind: "IntLiteral", value: 1 },
            right: {
                kind: "BinaryExpression",
                operator: "&&",
                left: { kind: "IntLiteral", value: 2 },
                right: {
                    kind: "BinaryExpression",
                    operator: "|",
                    left: { kind: "IntLiteral", value: 3 },
                    right: { kind: "IntLiteral", value: 4 }
                }
            }
        });
    });

    it("applies precedence for relational operators", () => {
        expect(parseExpression(tokenizeReader("1 < 2 <= 3"))).toEqual({
            kind: "BinaryExpression",
            operator: "<=",
            left: {
                kind: "BinaryExpression",
                operator: "<",
                left: { kind: "IntLiteral", value: 1 },
                right: { kind: "IntLiteral", value: 2 }
            },
            right: { kind: "IntLiteral", value: 3 }
        });
    });

    it("applies precedence for equality over bitwise and under relational", () => {
        expect(parseExpression(tokenizeReader("1 < 2 === 3 & 4"))).toEqual({
            kind: "BinaryExpression",
            operator: "&",
            left: {
                kind: "BinaryExpression",
                operator: "===",
                left: {
                    kind: "BinaryExpression",
                    operator: "<",
                    left: { kind: "IntLiteral", value: 1 },
                    right: { kind: "IntLiteral", value: 2 }
                },
                right: { kind: "IntLiteral", value: 3 }
            },
            right: { kind: "IntLiteral", value: 4 }
        });
    });

    it("parses all requested compound assignment operators", () => {
        const operators = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||="] as const;

        for (const operator of operators) {
            expect(parseExpression(tokenizeReader(`a ${operator} 1`))).toEqual({
                kind: "AssignmentExpression",
                operator,
                left: { kind: "Identifier", name: "a" },
                right: { kind: "IntLiteral", value: 1 }
            });
        }
    });

    it("parses '=' assignment expression", () => {
        expect(parseExpression(tokenizeReader("a = b + 1"))).toEqual({
            kind: "AssignmentExpression",
            operator: "=",
            left: { kind: "Identifier", name: "a" },
            right: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "Identifier", name: "b" },
                right: { kind: "IntLiteral", value: 1 }
            }
        });
    });

    it("parses compound assignment as right-associative", () => {
        expect(parseExpression(tokenizeReader("a += b *= c"))).toEqual({
            kind: "AssignmentExpression",
            operator: "+=",
            left: { kind: "Identifier", name: "a" },
            right: {
                kind: "AssignmentExpression",
                operator: "*=",
                left: { kind: "Identifier", name: "b" },
                right: { kind: "Identifier", name: "c" }
            }
        });
    });

    it("parses logical expressions on the right side of assignment", () => {
        expect(parseExpression(tokenizeReader("a ||= b && c"))).toEqual({
            kind: "AssignmentExpression",
            operator: "||=",
            left: { kind: "Identifier", name: "a" },
            right: {
                kind: "BinaryExpression",
                operator: "&&",
                left: { kind: "Identifier", name: "b" },
                right: { kind: "Identifier", name: "c" }
            }
        });
    });

    it("reports member-access parse errors at the trailing dot token", () => {
        try {
            parseExpression(tokenizeReader("a.b['d']."));
            throw new Error("Expected parseExpression to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(ParseError);
            const parseError = error as ParseError;
            expect(parseError.message).toBe("Expected identifier after '.'");
            expect(parseError.token?.value).toBe(".");
        }
    });

    it("reports safe member-access parse errors at the trailing ?.", () => {
        try {
            parseExpression(tokenizeReader("a?."));
            throw new Error("Expected parseExpression to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(ParseError);
            const parseError = error as ParseError;
            expect(parseError.message).toBe("Expected identifier after '?.'");
            expect(parseError.token?.value).toBe("?.");
        }
    });
})

describe("parseStatement", () => {
    it("parses a let statement", () => {
        expect(parseStatement(tokenizeReader("let myvar = 1 + 2"))).toEqual({
            kind: "LetStatement",
            name: { kind: "Identifier", name: "myvar" },
            initializer: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "IntLiteral", value: 1 },
                right: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("parses a let statement with optional type and initializer", () => {
        expect(parseStatement(tokenizeReader("let name: Type = value"))).toEqual({
            kind: "LetStatement",
            name: { kind: "Identifier", name: "name" },
            typeAnnotation: { kind: "Identifier", name: "Type" },
            initializer: { kind: "Identifier", name: "value" }
        });
    });

    it("parses a let statement with optional type and no initializer", () => {
        expect(parseStatement(tokenizeReader("let name: Type"))).toEqual({
            kind: "LetStatement",
            name: { kind: "Identifier", name: "name" },
            typeAnnotation: { kind: "Identifier", name: "Type" }
        });
    });

    it("parses a let statement with no type and no initializer", () => {
        expect(parseStatement(tokenizeReader("let name"))).toEqual({
            kind: "LetStatement",
            name: { kind: "Identifier", name: "name" }
        });
    });

    it("parses a block statement with nested statements", () => {
        expect(parseStatement(tokenizeReader("{ let a = 1; { let b = a + 2 }\nlet c = 3 }"))).toEqual({
            kind: "BlockStatement",
            body: [
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "LetStatement",
                            name: { kind: "Identifier", name: "b" },
                            initializer: {
                                kind: "BinaryExpression",
                                operator: "+",
                                left: { kind: "Identifier", name: "a" },
                                right: { kind: "IntLiteral", value: 2 }
                            }
                        }
                    ]
                },
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "c" },
                    initializer: { kind: "IntLiteral", value: 3 }
                }
            ]
        });
    });

    it("parses a while statement with single-statement body", () => {
        expect(parseStatement(tokenizeReader("while (a + 1) let b = 2"))).toEqual({
            kind: "WhileStatement",
            condition: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "IntLiteral", value: 1 }
            },
            body: {
                kind: "LetStatement",
                name: { kind: "Identifier", name: "b" },
                initializer: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("parses a do-while statement with single-statement body", () => {
        expect(parseStatement(tokenizeReader("do let x = 1 while (x + 1)"))).toEqual({
            kind: "DoWhileStatement",
            body: {
                kind: "LetStatement",
                name: { kind: "Identifier", name: "x" },
                initializer: { kind: "IntLiteral", value: 1 }
            },
            condition: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "Identifier", name: "x" },
                right: { kind: "IntLiteral", value: 1 }
            }
        });
    });

    it("parses an expression statement", () => {
        expect(parseStatement(tokenizeReader("a + 1"))).toEqual({
            kind: "ExprStatement",
            expression: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "IntLiteral", value: 1 }
            }
        });
    });
});

describe("parseProgram", () => {
    it("parses multiple let statements separated by semicolons", () => {
        expect(parseProgram(tokenizeReader("let a = 1; let b = a + 2;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "b" },
                    initializer: {
                        kind: "BinaryExpression",
                        operator: "+",
                        left: { kind: "Identifier", name: "a" },
                        right: { kind: "IntLiteral", value: 2 }
                    }
                }
            ]
        });
    });

    it("parses block statements at top level", () => {
        expect(parseProgram(tokenizeReader("let a = 1; { let b = 2; let c = b + 1 };"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "LetStatement",
                            name: { kind: "Identifier", name: "b" },
                            initializer: { kind: "IntLiteral", value: 2 }
                        },
                        {
                            kind: "LetStatement",
                            name: { kind: "Identifier", name: "c" },
                            initializer: {
                                kind: "BinaryExpression",
                                operator: "+",
                                left: { kind: "Identifier", name: "b" },
                                right: { kind: "IntLiteral", value: 1 }
                            }
                        }
                    ]
                }
            ]
        });
    });

    it("parses while statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("while (1) { let a = 2; let b = a + 3 }; let c = 4;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "WhileStatement",
                    condition: { kind: "IntLiteral", value: 1 },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "LetStatement",
                                name: { kind: "Identifier", name: "a" },
                                initializer: { kind: "IntLiteral", value: 2 }
                            },
                            {
                                kind: "LetStatement",
                                name: { kind: "Identifier", name: "b" },
                                initializer: {
                                    kind: "BinaryExpression",
                                    operator: "+",
                                    left: { kind: "Identifier", name: "a" },
                                    right: { kind: "IntLiteral", value: 3 }
                                }
                            }
                        ]
                    }
                },
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "c" },
                    initializer: { kind: "IntLiteral", value: 4 }
                }
            ]
        });
    });

    it("parses do-while statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("do { let i = 0; let j = i + 1 } while (j); let done = 1;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "DoWhileStatement",
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "LetStatement",
                                name: { kind: "Identifier", name: "i" },
                                initializer: { kind: "IntLiteral", value: 0 }
                            },
                            {
                                kind: "LetStatement",
                                name: { kind: "Identifier", name: "j" },
                                initializer: {
                                    kind: "BinaryExpression",
                                    operator: "+",
                                    left: { kind: "Identifier", name: "i" },
                                    right: { kind: "IntLiteral", value: 1 }
                                }
                            }
                        ]
                    },
                    condition: { kind: "Identifier", name: "j" }
                },
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "done" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
    });

    it("parses statements separated by newlines", () => {
        expect(parseProgram(tokenizeReader("let a = 1\na += 2\na + 3"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "ExprStatement",
                    expression: {
                        kind: "AssignmentExpression",
                        operator: "+=",
                        left: { kind: "Identifier", name: "a" },
                        right: { kind: "IntLiteral", value: 2 }
                    }
                },
                {
                    kind: "ExprStatement",
                    expression: {
                        kind: "BinaryExpression",
                        operator: "+",
                        left: { kind: "Identifier", name: "a" },
                        right: { kind: "IntLiteral", value: 3 }
                    }
                }
            ]
        });
    });
});

describe("parseFile", () => {
    it("parses an empty file", () => {
        expect(parseFile(tokenizeReader(""))).toEqual({
            kind: "Program",
            body: []
        });
    });
});

describe("Parser (with recovery)", () => {
    it("collects multiple statement-level errors and recovers at semicolons", () => {
        const parser = new Parser(tokenizeReader("=; let ok = 1; =;"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "ok" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
        expect(parser.errors.map((e) => e.message)).toEqual([
            "Expected a number literal, string literal, identifier, '(', '[' or '{'",
            "Expected a number literal, string literal, identifier, '(', '[' or '{'"
        ]);
        expect(parser.errors[0].token?.range.start).toEqual({
            offset: 0,
            line: 0,
            column: 0
        });
    });

    it("recovers from errors inside block statements by scanning braces", () => {
        const parser = new Parser(tokenizeReader("{ =; let ignored = 1; }; let ok = 2; =;"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "LetStatement",
                    name: { kind: "Identifier", name: "ok" },
                    initializer: { kind: "IntLiteral", value: 2 }
                }
            ]
        });
        expect(parser.errors.map((e) => e.message)).toEqual([
            "Expected a number literal, string literal, identifier, '(', '[' or '{'",
            "Expected a number literal, string literal, identifier, '(', '[' or '{'"
        ]);
        expect(parser.errors[0].token?.value).toBe("=");
        expect(parser.errors[1].token?.value).toBe("=");
    });
});
