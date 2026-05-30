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

    it("builds an AST for range expressions", () => {
        expect(parseExpression(tokenizeReader("0 ... 10"))).toEqual({
            kind: "RangeExpression",
            start: { kind: "IntLiteral", value: 0 },
            end: { kind: "IntLiteral", value: 10 }
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

    it("builds an AST for prefix increment and decrement", () => {
        expect(parseExpression(tokenizeReader("++a"))).toEqual({
            kind: "UpdateExpression",
            operator: "++",
            argument: { kind: "Identifier", name: "a" },
            prefix: true
        });
        expect(parseExpression(tokenizeReader("--b"))).toEqual({
            kind: "UpdateExpression",
            operator: "--",
            argument: { kind: "Identifier", name: "b" },
            prefix: true
        });
    });

    it("builds an AST for postfix increment and decrement", () => {
        expect(parseExpression(tokenizeReader("a++"))).toEqual({
            kind: "UpdateExpression",
            operator: "++",
            argument: { kind: "Identifier", name: "a" },
            prefix: false
        });
        expect(parseExpression(tokenizeReader("b--"))).toEqual({
            kind: "UpdateExpression",
            operator: "--",
            argument: { kind: "Identifier", name: "b" },
            prefix: false
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

    it("builds an AST for chained member access with function call", () => {
        expect(parseExpression(tokenizeReader("hello.world[0].test(arg1, arg2)"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "MemberExpression",
                    object: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "hello" },
                        property: { kind: "Identifier", name: "world" },
                        computed: false
                    },
                    property: { kind: "IntLiteral", value: 0 },
                    computed: true
                },
                property: { kind: "Identifier", name: "test" },
                computed: false
            },
            arguments: [
                { kind: "Identifier", name: "arg1" },
                { kind: "Identifier", name: "arg2" }
            ]
        });
    });

    it("builds an AST for new expression variants", () => {
        expect(parseExpression(tokenizeReader("new instance()"))).toEqual({
            kind: "NewExpression",
            callee: { kind: "Identifier", name: "instance" },
            arguments: []
        });

        expect(parseExpression(tokenizeReader("new instance"))).toEqual({
            kind: "NewExpression",
            callee: { kind: "Identifier", name: "instance" }
        });

        expect(parseExpression(tokenizeReader("new hello.world[0].test(arg1, arg2)"))).toEqual({
            kind: "NewExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "MemberExpression",
                    object: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "hello" },
                        property: { kind: "Identifier", name: "world" },
                        computed: false
                    },
                    property: { kind: "IntLiteral", value: 0 },
                    computed: true
                },
                property: { kind: "Identifier", name: "test" },
                computed: false
            },
            arguments: [
                { kind: "Identifier", name: "arg1" },
                { kind: "Identifier", name: "arg2" }
            ]
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

    it("applies precedence for shift and relational operators", () => {
        expect(parseExpression(tokenizeReader("1 + 2 << 3 < 4"))).toEqual({
            kind: "BinaryExpression",
            operator: "<",
            left: {
                kind: "BinaryExpression",
                operator: "<<",
                left: {
                    kind: "BinaryExpression",
                    operator: "+",
                    left: { kind: "IntLiteral", value: 1 },
                    right: { kind: "IntLiteral", value: 2 }
                },
                right: { kind: "IntLiteral", value: 3 }
            },
            right: { kind: "IntLiteral", value: 4 }
        });

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
        expect(parseExpression(tokenizeReader("1 < 2 == 3 != 4 === 5 !== 6 & 7"))).toEqual({
            kind: "BinaryExpression",
            operator: "&",
            left: {
                kind: "BinaryExpression",
                operator: "!==",
                left: {
                    kind: "BinaryExpression",
                    operator: "===",
                    left: {
                        kind: "BinaryExpression",
                        operator: "!=",
                        left: {
                            kind: "BinaryExpression",
                            operator: "==",
                            left: {
                                kind: "BinaryExpression",
                                operator: "<",
                                left: { kind: "IntLiteral", value: 1 },
                                right: { kind: "IntLiteral", value: 2 }
                            },
                            right: { kind: "IntLiteral", value: 3 }
                        },
                        right: { kind: "IntLiteral", value: 4 }
                    },
                    right: { kind: "IntLiteral", value: 5 }
                },
                right: { kind: "IntLiteral", value: 6 }
            },
            right: { kind: "IntLiteral", value: 7 }
        });
    });

    it("parses all requested compound assignment operators", () => {
        const operators = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||=", "<<=", ">>=", ">>>="] as const;

        for (const operator of operators) {
            expect(parseExpression(tokenizeReader(`a ${operator} 1`))).toEqual({
                kind: "AssignmentExpression",
                operator,
                left: { kind: "Identifier", name: "a" },
                right: { kind: "IntLiteral", value: 1 }
            });
        }
    });

    it("parses all requested shift operators", () => {
        const operators = ["<<", ">>", ">>>"] as const;

        for (const operator of operators) {
            expect(parseExpression(tokenizeReader(`a ${operator} 1`))).toEqual({
                kind: "BinaryExpression",
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
            kind: "VarStatement",
            declarationKind: "let",
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
            kind: "VarStatement",
            declarationKind: "let",
            name: { kind: "Identifier", name: "name" },
            typeAnnotation: { kind: "Identifier", name: "Type" },
            initializer: { kind: "Identifier", name: "value" }
        });
    });

    it("parses a let statement with optional type and no initializer", () => {
        expect(parseStatement(tokenizeReader("let name: Type"))).toEqual({
            kind: "VarStatement",
            declarationKind: "let",
            name: { kind: "Identifier", name: "name" },
            typeAnnotation: { kind: "Identifier", name: "Type" }
        });
    });

    it("parses a let statement with no type and no initializer", () => {
        expect(parseStatement(tokenizeReader("let name"))).toEqual({
            kind: "VarStatement",
            declarationKind: "let",
            name: { kind: "Identifier", name: "name" }
        });
    });

    it("parses var/val/const declarations and stores declaration kind", () => {
        expect(parseStatement(tokenizeReader("var x = 1"))).toEqual({
            kind: "VarStatement",
            declarationKind: "var",
            name: { kind: "Identifier", name: "x" },
            initializer: { kind: "IntLiteral", value: 1 }
        });
        expect(parseStatement(tokenizeReader("val y: Num"))).toEqual({
            kind: "VarStatement",
            declarationKind: "val",
            name: { kind: "Identifier", name: "y" },
            typeAnnotation: { kind: "Identifier", name: "Num" }
        });
        expect(parseStatement(tokenizeReader("const z"))).toEqual({
            kind: "VarStatement",
            declarationKind: "const",
            name: { kind: "Identifier", name: "z" }
        });
    });

    it("parses multiple variable declarations separated by commas", () => {
        expect(parseStatement(tokenizeReader("val a = 10 * 2, lol = true"))).toEqual({
            kind: "VarStatement",
            declarationKind: "val",
            name: { kind: "Identifier", name: "a" },
            initializer: {
                kind: "BinaryExpression",
                operator: "*",
                left: { kind: "IntLiteral", value: 10 },
                right: { kind: "IntLiteral", value: 2 }
            },
            declarations: [
                {
                    kind: "VarDeclarator",
                    name: { kind: "Identifier", name: "a" },
                    initializer: {
                        kind: "BinaryExpression",
                        operator: "*",
                        left: { kind: "IntLiteral", value: 10 },
                        right: { kind: "IntLiteral", value: 2 }
                    }
                },
                {
                    kind: "VarDeclarator",
                    name: { kind: "Identifier", name: "lol" },
                    initializer: { kind: "Identifier", name: "true" }
                }
            ]
        });
    });

    it("parses a block statement with nested statements", () => {
        expect(parseStatement(tokenizeReader("{ let a = 1; { let b = a + 2 }\nlet c = 3 }"))).toEqual({
            kind: "BlockStatement",
            body: [
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
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
                    kind: "VarStatement",
                    declarationKind: "let",
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
                kind: "VarStatement",
                declarationKind: "let",
                name: { kind: "Identifier", name: "b" },
                initializer: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("parses a do-while statement with single-statement body", () => {
        expect(parseStatement(tokenizeReader("do let x = 1 while (x + 1)"))).toEqual({
            kind: "DoWhileStatement",
            body: {
                kind: "VarStatement",
                declarationKind: "let",
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

    it("parses an if statement with single-statement branch", () => {
        expect(parseStatement(tokenizeReader("if (a < 1) let b = 2"))).toEqual({
            kind: "IfStatement",
            condition: {
                kind: "BinaryExpression",
                operator: "<",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "IntLiteral", value: 1 }
            },
            thenBranch: {
                kind: "VarStatement",
                declarationKind: "let",
                name: { kind: "Identifier", name: "b" },
                initializer: { kind: "IntLiteral", value: 2 }
            }
        });
    });

    it("parses an if-else statement", () => {
        expect(parseStatement(tokenizeReader("if (a) return b else return c"))).toEqual({
            kind: "IfStatement",
            condition: { kind: "Identifier", name: "a" },
            thenBranch: {
                kind: "ReturnStatement",
                expression: { kind: "Identifier", name: "b" }
            },
            elseBranch: {
                kind: "ReturnStatement",
                expression: { kind: "Identifier", name: "c" }
            }
        });
    });

    it("parses a for statement with declaration initializer", () => {
        expect(parseStatement(tokenizeReader("for (let i = 0; i < 10; i += 1) let value = i"))).toEqual({
            kind: "ForStatement",
            initializer: {
                kind: "VarStatement",
                declarationKind: "let",
                name: { kind: "Identifier", name: "i" },
                initializer: { kind: "IntLiteral", value: 0 }
            },
            condition: {
                kind: "BinaryExpression",
                operator: "<",
                left: { kind: "Identifier", name: "i" },
                right: { kind: "IntLiteral", value: 10 }
            },
            update: {
                kind: "AssignmentExpression",
                operator: "+=",
                left: { kind: "Identifier", name: "i" },
                right: { kind: "IntLiteral", value: 1 }
            },
            body: {
                kind: "VarStatement",
                declarationKind: "let",
                name: { kind: "Identifier", name: "value" },
                initializer: { kind: "Identifier", name: "i" }
            }
        });
    });

    it("parses for statement clauses as optional", () => {
        expect(parseStatement(tokenizeReader("for (;; ) break"))).toEqual({
            kind: "ForStatement",
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("supports val declaration in for initializer in mylang mode", () => {
        expect(parseStatement(tokenizeReader("for (val i = 0; i < 1; i += 1) break"), { language: "mylang" })).toEqual({
            kind: "ForStatement",
            initializer: {
                kind: "VarStatement",
                declarationKind: "val",
                name: { kind: "Identifier", name: "i" },
                initializer: { kind: "IntLiteral", value: 0 }
            },
            condition: {
                kind: "BinaryExpression",
                operator: "<",
                left: { kind: "Identifier", name: "i" },
                right: { kind: "IntLiteral", value: 1 }
            },
            update: {
                kind: "AssignmentExpression",
                operator: "+=",
                left: { kind: "Identifier", name: "i" },
                right: { kind: "IntLiteral", value: 1 }
            },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("treats 'val' as identifier in for initializer in typescript mode", () => {
        expect(parseStatement(tokenizeReader("for (val = 0; val < 1; val += 1) break"), { language: "typescript" })).toEqual({
            kind: "ForStatement",
            initializer: {
                kind: "AssignmentExpression",
                operator: "=",
                left: { kind: "Identifier", name: "val" },
                right: { kind: "IntLiteral", value: 0 }
            },
            condition: {
                kind: "BinaryExpression",
                operator: "<",
                left: { kind: "Identifier", name: "val" },
                right: { kind: "IntLiteral", value: 1 }
            },
            update: {
                kind: "AssignmentExpression",
                operator: "+=",
                left: { kind: "Identifier", name: "val" },
                right: { kind: "IntLiteral", value: 1 }
            },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses TypeScript for-of with declaration iterator", () => {
        expect(parseStatement(tokenizeReader("for (const value of iterable) break"), { language: "typescript" })).toEqual({
            kind: "ForStatement",
            iterationKind: "of",
            iterator: {
                kind: "VarStatement",
                declarationKind: "const",
                name: { kind: "Identifier", name: "value" }
            },
            iterable: { kind: "Identifier", name: "iterable" },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses TypeScript for-in with declaration iterator", () => {
        expect(parseStatement(tokenizeReader("for (let value in iterable) break"), { language: "typescript" })).toEqual({
            kind: "ForStatement",
            iterationKind: "in",
            iterator: {
                kind: "VarStatement",
                declarationKind: "let",
                name: { kind: "Identifier", name: "value" }
            },
            iterable: { kind: "Identifier", name: "iterable" },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses MyLang for-in without declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value in iterable) break"), { language: "mylang" })).toEqual({
            kind: "ForStatement",
            iterationKind: "in",
            iterator: { kind: "Identifier", name: "value" },
            iterable: { kind: "Identifier", name: "iterable" },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses MyLang for-of without declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value of 0 ... 10) break"), { language: "mylang" })).toEqual({
            kind: "ForStatement",
            iterationKind: "of",
            iterator: { kind: "Identifier", name: "value" },
            iterable: {
                kind: "RangeExpression",
                start: { kind: "IntLiteral", value: 0 },
                end: { kind: "IntLiteral", value: 10 }
            },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses a switch statement with case and default", () => {
        expect(parseStatement(tokenizeReader("switch (value) { case 1: return 1; default: return 0 }"))).toEqual({
            kind: "SwitchStatement",
            discriminant: { kind: "Identifier", name: "value" },
            cases: [
                {
                    kind: "SwitchCase",
                    test: { kind: "IntLiteral", value: 1 },
                    consequent: [
                        {
                            kind: "ReturnStatement",
                            expression: { kind: "IntLiteral", value: 1 }
                        }
                    ]
                },
                {
                    kind: "SwitchCase",
                    consequent: [
                        {
                            kind: "ReturnStatement",
                            expression: { kind: "IntLiteral", value: 0 }
                        }
                    ]
                }
            ]
        });
    });

    it("parses switch default-only in typescript mode", () => {
        expect(parseStatement(tokenizeReader("switch (value) { default: break }"), { language: "typescript" })).toEqual({
            kind: "SwitchStatement",
            discriminant: { kind: "Identifier", name: "value" },
            cases: [
                {
                    kind: "SwitchCase",
                    consequent: [
                        {
                            kind: "BreakStatement"
                        }
                    ]
                }
            ]
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
        expect(parseStatement(tokenizeReader("a++"))).toEqual({
            kind: "ExprStatement",
            expression: {
                kind: "UpdateExpression",
                operator: "++",
                argument: { kind: "Identifier", name: "a" },
                prefix: false
            }
        });
    });

    it("parses a function statement with optional parameter and return types (fun)", () => {
        expect(parseStatement(tokenizeReader("fun demo(a, b, c: optType): optType { return a + b }"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
            name: { kind: "Identifier", name: "demo" },
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "a" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "b" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "c" },
                    typeAnnotation: { kind: "Identifier", name: "optType" }
                }
            ],
            returnType: { kind: "Identifier", name: "optType" },
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: {
                            kind: "BinaryExpression",
                            operator: "+",
                            left: { kind: "Identifier", name: "a" },
                            right: { kind: "Identifier", name: "b" }
                        }
                    }
                ]
            }
        });
    });

    it("parses a function statement using function keyword", () => {
        expect(parseStatement(tokenizeReader("function demo(a, b, c: optType): optType { return c }"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "function",
            name: { kind: "Identifier", name: "demo" },
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "a" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "b" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "c" },
                    typeAnnotation: { kind: "Identifier", name: "optType" }
                }
            ],
            returnType: { kind: "Identifier", name: "optType" },
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "Identifier", name: "c" }
                    }
                ]
            }
        });
    });

    it("parses function parameters with optional marker and default value", () => {
        expect(parseStatement(tokenizeReader("fun test(a, v, c?, d: Int = demo) { return d }"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
            name: { kind: "Identifier", name: "test" },
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "a" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "v" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "c" },
                    optional: true
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "d" },
                    typeAnnotation: { kind: "Identifier", name: "Int" },
                    defaultValue: { kind: "Identifier", name: "demo" }
                }
            ],
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "Identifier", name: "d" }
                    }
                ]
            }
        });
    });

    it("parses return/continue/break statements", () => {
        expect(parseStatement(tokenizeReader("return value"))).toEqual({
            kind: "ReturnStatement",
            expression: { kind: "Identifier", name: "value" }
        });
        expect(parseStatement(tokenizeReader("return"))).toEqual({
            kind: "ReturnStatement"
        });
        expect(parseStatement(tokenizeReader("continue"))).toEqual({
            kind: "ContinueStatement"
        });
        expect(parseStatement(tokenizeReader("break"))).toEqual({
            kind: "BreakStatement"
        });
    });

    it("parses class statement with field, constructor, and method", () => {
        expect(
            parseStatement(
                tokenizeReader("class Demo {\na = 10\n\nconstructor() {\n}\n\ndemo() {\n}\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Demo" },
            members: [
                {
                    kind: "ClassFieldMember",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 10 }
                },
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "constructor" },
                    parameters: [],
                    body: { kind: "BlockStatement", body: [] }
                },
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "demo" },
                    parameters: [],
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });

    it("parses class statement with primary constructor parameters", () => {
        expect(parseStatement(tokenizeReader("class Point(val x: number, val y: number) {\n}"))).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Point" },
            primaryConstructorParameters: [
                {
                    kind: "ClassPrimaryConstructorParameter",
                    declarationKind: "val",
                    name: { kind: "Identifier", name: "x" },
                    typeAnnotation: { kind: "Identifier", name: "number" }
                },
                {
                    kind: "ClassPrimaryConstructorParameter",
                    declarationKind: "val",
                    name: { kind: "Identifier", name: "y" },
                    typeAnnotation: { kind: "Identifier", name: "number" }
                }
            ],
            members: []
        });
    });

    it("parses class statement without braces in mylang mode", () => {
        expect(parseStatement(tokenizeReader("class Point"))).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Point" },
            members: []
        });

        expect(parseStatement(tokenizeReader("class Point(val x: number, val y: number)"))).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Point" },
            primaryConstructorParameters: [
                {
                    kind: "ClassPrimaryConstructorParameter",
                    declarationKind: "val",
                    name: { kind: "Identifier", name: "x" },
                    typeAnnotation: { kind: "Identifier", name: "number" }
                },
                {
                    kind: "ClassPrimaryConstructorParameter",
                    declarationKind: "val",
                    name: { kind: "Identifier", name: "y" },
                    typeAnnotation: { kind: "Identifier", name: "number" }
                }
            ],
            members: []
        });
    });

    it("rejects class primary constructor syntax in typescript parser mode", () => {
        expect(() =>
            parseStatement(tokenizeReader("class Point(val x: number, val y: number) {}"), {
                language: "typescript"
            })
        ).toThrow("Class primary constructor syntax is only available in MyLang mode");
    });

    it("treats 'val' as identifier in typescript parser mode", () => {
        expect(parseStatement(tokenizeReader("val = 1"), { language: "typescript" })).toEqual({
            kind: "ExprStatement",
            expression: {
                kind: "AssignmentExpression",
                operator: "=",
                left: { kind: "Identifier", name: "val" },
                right: { kind: "IntLiteral", value: 1 }
            }
        });
    });

    it("treats 'fun' as identifier in typescript parser mode", () => {
        expect(parseStatement(tokenizeReader("fun = 1"), { language: "typescript" })).toEqual({
            kind: "ExprStatement",
            expression: {
                kind: "AssignmentExpression",
                operator: "=",
                left: { kind: "Identifier", name: "fun" },
                right: { kind: "IntLiteral", value: 1 }
            }
        });
    });

    it("parses 'declare function' as a function declaration in typescript mode", () => {
        expect(
            parseStatement(
                tokenizeReader("declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;"),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "FunctionStatement",
            declarationKind: "function",
            declared: true,
            name: { kind: "Identifier", name: "moment" },
            parameters: [],
            body: { kind: "BlockStatement", body: [] }
        });
    });

    it("parses 'declare function' as a function declaration in mylang mode", () => {
        expect(
            parseStatement(
                tokenizeReader("declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;"),
                { language: "mylang" }
            )
        ).toEqual({
            kind: "FunctionStatement",
            declarationKind: "function",
            declared: true,
            name: { kind: "Identifier", name: "moment" },
            parameters: [],
            body: { kind: "BlockStatement", body: [] }
        });
    });

    it("parses 'declare class' with signature-only members", () => {
        expect(
            parseStatement(
                tokenizeReader("declare class Console { log(a: number) }"),
                { language: "mylang" }
            )
        ).toEqual({
            kind: "ClassStatement",
            declared: true,
            name: { kind: "Identifier", name: "Console" },
            members: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "log" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "a" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        }
                    ],
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });

    it("parses 'declare var/let/const/val' declarations", () => {
        expect(parseStatement(tokenizeReader("declare var console: Console"), { language: "mylang" })).toEqual({
            kind: "VarStatement",
            declared: true,
            declarationKind: "var",
            name: { kind: "Identifier", name: "console" },
            typeAnnotation: { kind: "Identifier", name: "Console" }
        });

        expect(parseStatement(tokenizeReader("declare let value = 1"), { language: "mylang" })).toEqual({
            kind: "VarStatement",
            declared: true,
            declarationKind: "let",
            name: { kind: "Identifier", name: "value" },
            initializer: { kind: "IntLiteral", value: 1 }
        });

        expect(parseStatement(tokenizeReader("declare const ready: boolean"), { language: "typescript" })).toEqual({
            kind: "VarStatement",
            declared: true,
            declarationKind: "const",
            name: { kind: "Identifier", name: "ready" },
            typeAnnotation: { kind: "Identifier", name: "boolean" }
        });

        expect(parseStatement(tokenizeReader("declare val total: number"), { language: "mylang" })).toEqual({
            kind: "VarStatement",
            declared: true,
            declarationKind: "val",
            name: { kind: "Identifier", name: "total" },
            typeAnnotation: { kind: "Identifier", name: "number" }
        });
    });
});

describe("parseProgram", () => {
    it("parses multiple let statements separated by semicolons", () => {
        expect(parseProgram(tokenizeReader("let a = 1; let b = a + 2;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
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
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
                            name: { kind: "Identifier", name: "b" },
                            initializer: { kind: "IntLiteral", value: 2 }
                        },
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
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
                                kind: "VarStatement",
                                declarationKind: "let",
                                name: { kind: "Identifier", name: "a" },
                                initializer: { kind: "IntLiteral", value: 2 }
                            },
                            {
                                kind: "VarStatement",
                                declarationKind: "let",
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
                    kind: "VarStatement",
                    declarationKind: "let",
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
                                kind: "VarStatement",
                                declarationKind: "let",
                                name: { kind: "Identifier", name: "i" },
                                initializer: { kind: "IntLiteral", value: 0 }
                            },
                            {
                                kind: "VarStatement",
                                declarationKind: "let",
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
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "done" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
    });

    it("parses if-else statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("if (ok) { let a = 1 } else { let b = 2 }; let done = 1;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "IfStatement",
                    condition: { kind: "Identifier", name: "ok" },
                    thenBranch: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "VarStatement",
                                declarationKind: "let",
                                name: { kind: "Identifier", name: "a" },
                                initializer: { kind: "IntLiteral", value: 1 }
                            }
                        ]
                    },
                    elseBranch: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "VarStatement",
                                declarationKind: "let",
                                name: { kind: "Identifier", name: "b" },
                                initializer: { kind: "IntLiteral", value: 2 }
                            }
                        ]
                    }
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "done" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
    });

    it("parses switch statements with multiple cases and fallthrough", () => {
        expect(parseProgram(tokenizeReader("switch (x) { case 1: case 2: let y = x; break; default: let z = 0 }; let done = 1;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "SwitchStatement",
                    discriminant: { kind: "Identifier", name: "x" },
                    cases: [
                        {
                            kind: "SwitchCase",
                            test: { kind: "IntLiteral", value: 1 },
                            consequent: []
                        },
                        {
                            kind: "SwitchCase",
                            test: { kind: "IntLiteral", value: 2 },
                            consequent: [
                                {
                                    kind: "VarStatement",
                                    declarationKind: "let",
                                    name: { kind: "Identifier", name: "y" },
                                    initializer: { kind: "Identifier", name: "x" }
                                },
                                {
                                    kind: "BreakStatement"
                                }
                            ]
                        },
                        {
                            kind: "SwitchCase",
                            consequent: [
                                {
                                    kind: "VarStatement",
                                    declarationKind: "let",
                                    name: { kind: "Identifier", name: "z" },
                                    initializer: { kind: "IntLiteral", value: 0 }
                                }
                            ]
                        }
                    ]
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "done" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
    });

    it("parses for statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("for (let i = 0; i < 2; i += 1) { let x = i }; let done = 1;"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "ForStatement",
                    initializer: {
                        kind: "VarStatement",
                        declarationKind: "let",
                        name: { kind: "Identifier", name: "i" },
                        initializer: { kind: "IntLiteral", value: 0 }
                    },
                    condition: {
                        kind: "BinaryExpression",
                        operator: "<",
                        left: { kind: "Identifier", name: "i" },
                        right: { kind: "IntLiteral", value: 2 }
                    },
                    update: {
                        kind: "AssignmentExpression",
                        operator: "+=",
                        left: { kind: "Identifier", name: "i" },
                        right: { kind: "IntLiteral", value: 1 }
                    },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "VarStatement",
                                declarationKind: "let",
                                name: { kind: "Identifier", name: "x" },
                                initializer: { kind: "Identifier", name: "i" }
                            }
                        ]
                    }
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
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
                    kind: "VarStatement",
                    declarationKind: "let",
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

    it("parses function bodies with return/continue/break statements", () => {
        expect(
            parseProgram(
                tokenizeReader("fun demo(a, b, c: optType): optType {\nreturn\ncontinue\nbreak\n}\n")
            )
        ).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "FunctionStatement",
                    declarationKind: "fun",
                    name: { kind: "Identifier", name: "demo" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "a" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "b" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "c" },
                            typeAnnotation: { kind: "Identifier", name: "optType" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "optType" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            { kind: "ReturnStatement" },
                            { kind: "ContinueStatement" },
                            { kind: "BreakStatement" }
                        ]
                    }
                }
            ]
        });
    });

    it("parses class declarations mixed with other statements", () => {
        expect(
            parseProgram(
                tokenizeReader("class Demo {\na = 10\nconstructor() {}\ndemo() {}\n}\nlet after = 1")
            )
        ).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "ClassStatement",
                    name: { kind: "Identifier", name: "Demo" },
                    members: [
                        {
                            kind: "ClassFieldMember",
                            name: { kind: "Identifier", name: "a" },
                            initializer: { kind: "IntLiteral", value: 10 }
                        },
                        {
                            kind: "ClassMethodMember",
                            name: { kind: "Identifier", name: "constructor" },
                            parameters: [],
                            body: { kind: "BlockStatement", body: [] }
                        },
                        {
                            kind: "ClassMethodMember",
                            name: { kind: "Identifier", name: "demo" },
                            parameters: [],
                            body: { kind: "BlockStatement", body: [] }
                        }
                    ]
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "after" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
    });

    it("parses class declarations without braces mixed with other statements", () => {
        expect(parseProgram(tokenizeReader("class Point\nlet after = 1"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "ClassStatement",
                    name: { kind: "Identifier", name: "Point" },
                    members: []
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "after" },
                    initializer: { kind: "IntLiteral", value: 1 }
                }
            ]
        });
    });

    it("parses programs with single-line and block comments", () => {
        expect(parseProgram(tokenizeReader("let a = 1 // comment\n/* block */\nlet b = a + 2"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "a" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
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
});

describe("parseFile", () => {
    it("parses an empty file", () => {
        expect(parseFile(tokenizeReader(""))).toEqual({
            kind: "Program",
            body: []
        });
    });

    it("stores first and last token metadata on AST nodes", () => {
        const ast = parseFile(tokenizeReader("let value = a + 1"));
        const statement = ast.body[0];

        expect(ast.firstToken?.value).toBe("let");
        expect(ast.lastToken?.value).toBe("1");
        expect(statement.firstToken?.value).toBe("let");
        expect(statement.lastToken?.value).toBe("1");
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
                    kind: "VarStatement",
                    declarationKind: "let",
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

    it("recovers from errors inside block statements and keeps valid statements", () => {
        const parser = new Parser(tokenizeReader("{ =; let ignored = 1; }; let ok = 2; =;"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
                            name: { kind: "Identifier", name: "ignored" },
                            initializer: { kind: "IntLiteral", value: 1 }
                        }
                    ]
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
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

    it("recovers at newline statement boundaries without needing semicolons", () => {
        const parser = new Parser(tokenizeReader("=\nlet ok = 1\nlet done = 2\n!"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "ok" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "VarStatement",
                    declarationKind: "let",
                    name: { kind: "Identifier", name: "done" },
                    initializer: { kind: "IntLiteral", value: 2 }
                }
            ]
        });
        expect(parser.errors).toHaveLength(2);
    });

    it("recovers inside block statements and keeps later valid statements", () => {
        const parser = new Parser(tokenizeReader("{ let a = ; let b = 2 }"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
                            name: { kind: "Identifier", name: "b" },
                            initializer: { kind: "IntLiteral", value: 2 }
                        }
                    ]
                }
            ]
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers inside switch cases and continues with following cases", () => {
        const parser = new Parser(tokenizeReader("switch (x) { case 1: let a = ; case 2: let b = 2; break; default: return 0 }"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "SwitchStatement",
                    discriminant: { kind: "Identifier", name: "x" },
                    cases: [
                        {
                            kind: "SwitchCase",
                            test: { kind: "IntLiteral", value: 1 },
                            consequent: []
                        },
                        {
                            kind: "SwitchCase",
                            test: { kind: "IntLiteral", value: 2 },
                            consequent: [
                                {
                                    kind: "VarStatement",
                                    declarationKind: "let",
                                    name: { kind: "Identifier", name: "b" },
                                    initializer: { kind: "IntLiteral", value: 2 }
                                },
                                { kind: "BreakStatement" }
                            ]
                        },
                        {
                            kind: "SwitchCase",
                            consequent: [
                                {
                                    kind: "ReturnStatement",
                                    expression: { kind: "IntLiteral", value: 0 }
                                }
                            ]
                        }
                    ]
                }
            ]
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers malformed statement separators by skipping to the next '}' or newline", () => {
        const parser = new Parser(tokenizeReader(
            "asdsa declare class Console {\n" +
            "  log(a: number)\n" +
            "}\n\n" +
            "declare var console: Console\n"
        ));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "ExprStatement",
                    expression: {
                        kind: "Identifier",
                        name: "asdsa"
                    }
                },
                {
                    kind: "VarStatement",
                    declared: true,
                    declarationKind: "var",
                    name: { kind: "Identifier", name: "console" },
                    typeAnnotation: { kind: "Identifier", name: "Console" }
                }
            ]
        });
        expect(parser.errors.map((issue) => issue.message)).toContain(
            "Expected ';', newline, or end of file between statements"
        );
    });
});
