import { describe, expect, it } from "vitest";
import { ParseError, Parser, getProgramRecoveryMarkers, parseExpression, parseFile, parseProgram, parseStatement } from "./parser";
import { tokenizeReader } from "./tokenizer";

describe("parseExpression", () => {
    it("builds an AST for a single literal", () => {
        expect(parseExpression(tokenizeReader("10"))).toEqual(
            { kind: "IntLiteral", value: 10 }
        );
    });

    it("builds an AST for decimal and scientific literals", () => {
        expect(parseExpression(tokenizeReader("10.573"))).toEqual(
            { kind: "FloatLiteral", value: 10.573 }
        );
        expect(parseExpression(tokenizeReader("10e-3"))).toEqual(
            { kind: "FloatLiteral", value: 0.01 }
        );
    });

    it("builds an AST for bigint and long literals", () => {
        expect(parseExpression(tokenizeReader("10n"))).toEqual(
            { kind: "BigIntLiteral", value: 10n }
        );
        expect(parseExpression(tokenizeReader("20L"))).toEqual(
            { kind: "LongLiteral", value: 20n }
        );
    });

    it("builds an AST for numeric separators and non-decimal literals", () => {
        expect(parseExpression(tokenizeReader("1_000"))).toEqual(
            { kind: "IntLiteral", value: 1000 }
        );
        expect(parseExpression(tokenizeReader("0xff"))).toEqual(
            { kind: "IntLiteral", value: 255 }
        );
        expect(parseExpression(tokenizeReader("0b1010"))).toEqual(
            { kind: "IntLiteral", value: 10 }
        );
        expect(parseExpression(tokenizeReader("0o755"))).toEqual(
            { kind: "IntLiteral", value: 493 }
        );
        expect(parseExpression(tokenizeReader("0xfn"))).toEqual(
            { kind: "BigIntLiteral", value: 15n }
        );
    });

    it("builds an AST for boolean, null, and undefined literals", () => {
        expect(parseExpression(tokenizeReader("true"))).toEqual({ kind: "BooleanLiteral", value: true });
        expect(parseExpression(tokenizeReader("false"))).toEqual({ kind: "BooleanLiteral", value: false });
        expect(parseExpression(tokenizeReader("null"))).toEqual({ kind: "NullLiteral" });
        expect(parseExpression(tokenizeReader("undefined"))).toEqual({ kind: "UndefinedLiteral" });
    });

    it("builds AST nodes for regular expression literals and sparse arrays", () => {
        expect(parseExpression(tokenizeReader("/a[0-9]+/gi"))).toEqual({
            kind: "RegExpLiteral",
            pattern: "a[0-9]+",
            flags: "gi"
        });

        expect(parseExpression(tokenizeReader("[1, , 3,]"))).toEqual({
            kind: "ArrayLiteral",
            elements: [
                { kind: "IntLiteral", value: 1 },
                { kind: "ArrayHole" },
                { kind: "IntLiteral", value: 3 }
            ]
        });
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

    it("builds an AST for template literal interpolation via concatenation", () => {
        expect(parseExpression(tokenizeReader("`hello ${name}`"))).toEqual({
            kind: "BinaryExpression",
            operator: "+",
            left: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "StringLiteral", value: "hello " },
                right: { kind: "Identifier", name: "name" }
            },
            right: { kind: "StringLiteral", value: "" }
        });
    });


    it("builds an AST for comma expressions at the lowest precedence", () => {
        expect(parseExpression(tokenizeReader("a = 1, b + 2, c"))).toEqual({
            kind: "CommaExpression",
            expressions: [
                {
                    kind: "AssignmentExpression",
                    operator: "=",
                    left: { kind: "Identifier", name: "a" },
                    right: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "BinaryExpression",
                    operator: "+",
                    left: { kind: "Identifier", name: "b" },
                    right: { kind: "IntLiteral", value: 2 }
                },
                { kind: "Identifier", name: "c" }
            ]
        });
    });

    it("keeps comma-delimited call arguments separate from comma expressions", () => {
        expect(parseExpression(tokenizeReader("fn(a, (b, c))"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "fn" },
            arguments: [
                { kind: "Identifier", name: "a" },
                {
                    kind: "CommaExpression",
                    expressions: [
                        { kind: "Identifier", name: "b" },
                        { kind: "Identifier", name: "c" }
                    ]
                }
            ]
        });
    });

    it("builds an AST for optional call, optional element access, spread expressions, and rest parameters", () => {
        expect(parseExpression(tokenizeReader("fn?.(...args)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "fn" },
            arguments: [
                {
                    kind: "SpreadExpression",
                    argument: { kind: "Identifier", name: "args" }
                }
            ],
            optional: true
        });
        expect(parseExpression(tokenizeReader("obj?.[key]"))).toEqual({
            kind: "MemberExpression",
            object: { kind: "Identifier", name: "obj" },
            property: { kind: "Identifier", name: "key" },
            computed: true,
            optional: true
        });

        const program = parseFile(tokenizeReader("fun collect(first: int, ...rest: int[]) { return rest }"));
        expect(program.body[0]).toMatchObject({
            kind: "FunctionStatement",
            parameters: [
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "first" } },
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "rest" }, rest: true }
            ]
        });
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

    it("builds an AST for TypeScript as assertions", () => {
        expect(parseExpression(tokenizeReader("value as string"))).toEqual({
            kind: "AsExpression",
            expression: { kind: "Identifier", name: "value" },
            typeAnnotation: { kind: "Identifier", name: "string" }
        });
        expect(parseExpression(tokenizeReader("a + b as number"))).toEqual({
            kind: "AsExpression",
            expression: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "Identifier", name: "b" }
            },
            typeAnnotation: { kind: "Identifier", name: "number" }
        });
    });

    it("builds an AST for TypeScript angle-bracket assertions", () => {
        expect(parseExpression(tokenizeReader("<string>value"))).toEqual({
            kind: "AsExpression",
            expression: { kind: "Identifier", name: "value" },
            typeAnnotation: { kind: "Identifier", name: "string" }
        });
        expect(parseExpression(tokenizeReader("<string[]>value"))).toEqual({
            kind: "AsExpression",
            expression: { kind: "Identifier", name: "value" },
            typeAnnotation: { kind: "Identifier", name: "string[]" }
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

    it("builds an AST for additional unary operators", () => {
        expect(parseExpression(tokenizeReader("!a"))).toEqual({
            kind: "UnaryExpression",
            operator: "!",
            argument: { kind: "Identifier", name: "a" }
        });
        expect(parseExpression(tokenizeReader("~a"))).toEqual({
            kind: "UnaryExpression",
            operator: "~",
            argument: { kind: "Identifier", name: "a" }
        });
        expect(parseExpression(tokenizeReader("typeof a"))).toEqual({
            kind: "UnaryExpression",
            operator: "typeof",
            argument: { kind: "Identifier", name: "a" }
        });
        expect(parseExpression(tokenizeReader("void a"))).toEqual({
            kind: "UnaryExpression",
            operator: "void",
            argument: { kind: "Identifier", name: "a" }
        });
        expect(parseExpression(tokenizeReader("delete a.b"))).toEqual({
            kind: "UnaryExpression",
            operator: "delete",
            argument: {
                kind: "MemberExpression",
                object: { kind: "Identifier", name: "a" },
                property: { kind: "Identifier", name: "b" },
                computed: false
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

    it("does not treat prefix ++/-- on next line as postfix continuation", () => {
        expect(parseProgram(tokenizeReader("var a: int = 10\n++a\n--a\n"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "VarStatement",
                    declarationKind: "var",
                    name: { kind: "Identifier", name: "a" },
                    typeAnnotation: { kind: "Identifier", name: "int" },
                    initializer: { kind: "IntLiteral", value: 10 }
                },
                {
                    kind: "ExprStatement",
                    expression: {
                        kind: "UpdateExpression",
                        operator: "++",
                        argument: { kind: "Identifier", name: "a" },
                        prefix: true
                    }
                },
                {
                    kind: "ExprStatement",
                    expression: {
                        kind: "UpdateExpression",
                        operator: "--",
                        argument: { kind: "Identifier", name: "a" },
                        prefix: true
                    }
                }
            ]
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

    it("builds an AST for object method literals", () => {
        const expr = parseExpression(tokenizeReader("{add(a: number, b: number): number { return a + b }, [name]() { return 1 }}"));
        expect(expr).toMatchObject({
            kind: "ObjectLiteral",
            properties: [
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "add" },
                    method: true,
                    value: {
                        kind: "FunctionExpression",
                        name: { kind: "Identifier", name: "add" },
                        parameters: [
                            { kind: "FunctionParameter", name: { kind: "Identifier", name: "a" }, typeAnnotation: { kind: "Identifier", name: "number" } },
                            { kind: "FunctionParameter", name: { kind: "Identifier", name: "b" }, typeAnnotation: { kind: "Identifier", name: "number" } }
                        ],
                        returnType: { kind: "Identifier", name: "number" }
                    }
                },
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "name" },
                    computed: true,
                    method: true,
                    value: { kind: "FunctionExpression" }
                }
            ]
        });
    });

    it("builds an AST for shorthand, spread, computed, and trailing-comma object literals", () => {
        expect(parseExpression(tokenizeReader('{a, ...base, [key]: value, "display name": name, 1: one,}'))).toEqual({
            kind: "ObjectLiteral",
            properties: [
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "a" },
                    value: { kind: "Identifier", name: "a" },
                    shorthand: true
                },
                {
                    kind: "ObjectSpreadProperty",
                    argument: { kind: "Identifier", name: "base" }
                },
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "key" },
                    value: { kind: "Identifier", name: "value" },
                    computed: true
                },
                {
                    kind: "ObjectProperty",
                    key: { kind: "StringLiteral", value: "display name" },
                    value: { kind: "Identifier", name: "name" }
                },
                {
                    kind: "ObjectProperty",
                    key: { kind: "IntLiteral", value: 1 },
                    value: { kind: "Identifier", name: "one" }
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

    it("builds an AST for generic call expressions", () => {
        expect(parseExpression(tokenizeReader("factory<string, number>(arg1)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "factory" },
            arguments: [{ kind: "Identifier", name: "arg1" }],
            typeArguments: [
                { kind: "Identifier", name: "string" },
                { kind: "Identifier", name: "number" }
            ]
        });
    });

    it("builds an AST for TypeScript-style arrow functions in call arguments", () => {
        expect(parseExpression(tokenizeReader("[1,2,3,4].map(a => 10)"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "a" }
                        }
                    ],
                    body: { kind: "IntLiteral", value: 10 }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map((it) => 10)"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "it" }
                        }
                    ],
                    body: { kind: "IntLiteral", value: 10 }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map((a, b, c) => a + b + c)"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "a" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "b" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "c" } }
                    ],
                    body: {
                        kind: "BinaryExpression",
                        operator: "+",
                        left: {
                            kind: "BinaryExpression",
                            operator: "+",
                            left: { kind: "Identifier", name: "a" },
                            right: { kind: "Identifier", name: "b" }
                        },
                        right: { kind: "Identifier", name: "c" }
                    }
                }
            ]
        });
    });

    it("builds an AST for TypeScript-style function expressions in call arguments", () => {
        expect(parseExpression(tokenizeReader("[1,2,3,4].map(function(it: number) { return 10 })"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "FunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "it" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        }
                    ],
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: { kind: "IntLiteral", value: 10 }
                            }
                        ]
                    }
                }
            ]
        });

        expect(
            parseExpression(tokenizeReader("[1,2,3,4].map(function(a: number, b: number, c: number) { return 10 })"))
        ).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "FunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "a" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "b" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "c" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        }
                    ],
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: { kind: "IntLiteral", value: 10 }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("builds an AST for Kotlin/Swift-style tail lambdas", () => {
        expect(parseExpression(tokenizeReader("[1,2,3,4].map { it }"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "it" }
                        }
                    ],
                    body: { kind: "Identifier", name: "it" }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map() { it }"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "it" }
                        }
                    ],
                    body: { kind: "Identifier", name: "it" }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map { a, b, c -> a + b + c }"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "a" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "b" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "c" } }
                    ],
                    body: {
                        kind: "BinaryExpression",
                        operator: "+",
                        left: {
                            kind: "BinaryExpression",
                            operator: "+",
                            left: { kind: "Identifier", name: "a" },
                            right: { kind: "Identifier", name: "b" }
                        },
                        right: { kind: "Identifier", name: "c" }
                    }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map { a: number, b: number, c: number -> a + b + c }"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "ArrayLiteral",
                    elements: [
                        { kind: "IntLiteral", value: 1 },
                        { kind: "IntLiteral", value: 2 },
                        { kind: "IntLiteral", value: 3 },
                        { kind: "IntLiteral", value: 4 }
                    ]
                },
                property: { kind: "Identifier", name: "map" },
                computed: false
            },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "a" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "b" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "c" },
                            typeAnnotation: { kind: "Identifier", name: "number" }
                        }
                    ],
                    body: {
                        kind: "BinaryExpression",
                        operator: "+",
                        left: {
                            kind: "BinaryExpression",
                            operator: "+",
                            left: { kind: "Identifier", name: "a" },
                            right: { kind: "Identifier", name: "b" }
                        },
                        right: { kind: "Identifier", name: "c" }
                    }
                }
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

        expect(parseExpression(tokenizeReader("new Map<string, string>()"))).toEqual({
            kind: "NewExpression",
            callee: { kind: "Identifier", name: "Map" },
            arguments: [],
            typeArguments: [
                { kind: "Identifier", name: "string" },
                { kind: "Identifier", name: "string" }
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

    it("parses nullish coalescing with logical precedence", () => {
        expect(parseExpression(tokenizeReader("a ?? b || c && d"))).toEqual({
            kind: "BinaryExpression",
            operator: "||",
            left: {
                kind: "BinaryExpression",
                operator: "??",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "Identifier", name: "b" }
            },
            right: {
                kind: "BinaryExpression",
                operator: "&&",
                left: { kind: "Identifier", name: "c" },
                right: { kind: "Identifier", name: "d" }
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

        expect(parseExpression(tokenizeReader("a in b instanceof c"))).toEqual({
            kind: "BinaryExpression",
            operator: "instanceof",
            left: {
                kind: "BinaryExpression",
                operator: "in",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "Identifier", name: "b" }
            },
            right: { kind: "Identifier", name: "c" }
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
        const operators = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||=", "??=", "<<=", ">>=", ">>>="] as const;

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

    it("parses ternary conditional expressions as right-associative", () => {
        expect(parseExpression(tokenizeReader("a ? b : c ? d : e"))).toEqual({
            kind: "ConditionalExpression",
            test: { kind: "Identifier", name: "a" },
            consequent: { kind: "Identifier", name: "b" },
            alternate: {
                kind: "ConditionalExpression",
                test: { kind: "Identifier", name: "c" },
                consequent: { kind: "Identifier", name: "d" },
                alternate: { kind: "Identifier", name: "e" }
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
    it("parses debugger and empty statements", () => {
        expect(parseStatement(tokenizeReader("debugger"))).toEqual({ kind: "DebuggerStatement" });
        expect(parseStatement(tokenizeReader(";"))).toEqual({ kind: "EmptyStatement" });
        expect(parseStatement(tokenizeReader("while (ready);"))).toEqual({
            kind: "WhileStatement",
            condition: { kind: "Identifier", name: "ready" },
            body: { kind: "EmptyStatement" }
        });
    });

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
                    initializer: { kind: "BooleanLiteral", value: true }
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

    it("parses an extension operator function statement", () => {
        expect(parseStatement(tokenizeReader("fun Point.operator+(other: Point): Point { return other }"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
            receiverType: { kind: "Identifier", name: "Point" },
            name: { kind: "Identifier", name: "operator+" },
            operator: "+",
            parameters: [
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "other" }, typeAnnotation: { kind: "Identifier", name: "Point" } }
            ],
            returnType: { kind: "Identifier", name: "Point" },
            body: { kind: "BlockStatement", body: [{ kind: "ReturnStatement", expression: { kind: "Identifier", name: "other" } }] }
        });
    });

    it("parses a generic function statement", () => {
        expect(parseStatement(tokenizeReader("fun identity<T>(value: T): T { return value }"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
            name: { kind: "Identifier", name: "identity" },
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }
            ],
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "value" },
                    typeAnnotation: { kind: "Identifier", name: "T" }
                }
            ],
            returnType: { kind: "Identifier", name: "T" },
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "Identifier", name: "value" }
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

    it("parses return/throw/continue/break statements", () => {
        expect(parseStatement(tokenizeReader("return value"))).toEqual({
            kind: "ReturnStatement",
            expression: { kind: "Identifier", name: "value" }
        });
        expect(parseStatement(tokenizeReader("return"))).toEqual({
            kind: "ReturnStatement"
        });
        expect(parseStatement(tokenizeReader("throw value"))).toEqual({
            kind: "ThrowStatement",
            expression: { kind: "Identifier", name: "value" }
        });
        expect(parseStatement(tokenizeReader("continue"))).toEqual({
            kind: "ContinueStatement"
        });
        expect(parseStatement(tokenizeReader("break"))).toEqual({
            kind: "BreakStatement"
        });
    });

    it("parses try/catch/finally statements", () => {
        expect(parseStatement(tokenizeReader("try { return a } catch (e) { throw e } finally { return b }"))).toEqual({
            kind: "TryStatement",
            tryBlock: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "Identifier", name: "a" }
                    }
                ]
            },
            catchClause: {
                kind: "CatchClause",
                parameter: { kind: "Identifier", name: "e" },
                body: {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "ThrowStatement",
                            expression: { kind: "Identifier", name: "e" }
                        }
                    ]
                }
            },
            finallyBlock: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "Identifier", name: "b" }
                    }
                ]
            }
        });
    });

    it("parses try/finally and catch without parameter", () => {
        expect(parseStatement(tokenizeReader("try { return 1 } finally { return 2 }"))).toEqual({
            kind: "TryStatement",
            tryBlock: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "IntLiteral", value: 1 }
                    }
                ]
            },
            finallyBlock: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "IntLiteral", value: 2 }
                    }
                ]
            }
        });

        expect(parseStatement(tokenizeReader("try { return 1 } catch { return 2 }"))).toEqual({
            kind: "TryStatement",
            tryBlock: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "IntLiteral", value: 1 }
                    }
                ]
            },
            catchClause: {
                kind: "CatchClause",
                body: {
                    kind: "BlockStatement",
                    body: [
                        {
                            kind: "ReturnStatement",
                            expression: { kind: "IntLiteral", value: 2 }
                        }
                    ]
                }
            }
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

    it("parses class get and set accessors", () => {
        expect(
            parseStatement(
                tokenizeReader("class Box {\nget value(): string { return this.raw }\nset value(next: string) { this.raw = next }\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Box" },
            members: [
                {
                    kind: "ClassMethodMember",
                    accessorKind: "get",
                    name: { kind: "Identifier", name: "value" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "string" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: {
                                    kind: "MemberExpression",
                                    object: { kind: "Identifier", name: "this" },
                                    property: { kind: "Identifier", name: "raw" },
                                    computed: false
                                }
                            }
                        ]
                    }
                },
                {
                    kind: "ClassMethodMember",
                    accessorKind: "set",
                    name: { kind: "Identifier", name: "value" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "next" },
                            typeAnnotation: { kind: "Identifier", name: "string" }
                        }
                    ],
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ExprStatement",
                                expression: {
                                    kind: "AssignmentExpression",
                                    operator: "=",
                                    left: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "this" },
                                        property: { kind: "Identifier", name: "raw" },
                                        computed: false
                                    },
                                    right: { kind: "Identifier", name: "next" }
                                }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("parses class members with override modifier", () => {
        expect(
            parseStatement(
                tokenizeReader("class Child extends Base {\noverride value: string\noverride getValue(a: int): string { }\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Child" },
            extendsType: { kind: "Identifier", name: "Base" },
            members: [
                {
                    kind: "ClassFieldMember",
                    override: true,
                    name: { kind: "Identifier", name: "value" },
                    typeAnnotation: { kind: "Identifier", name: "string" }
                },
                {
                    kind: "ClassMethodMember",
                    override: true,
                    name: { kind: "Identifier", name: "getValue" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "a" },
                            typeAnnotation: { kind: "Identifier", name: "int" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "string" },
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });


    it("parses definite assignment assertions on class fields", () => {
        expect(parseStatement(tokenizeReader("class User { id!: string }"))).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "User" },
            members: [
                {
                    kind: "ClassFieldMember",
                    name: { kind: "Identifier", name: "id" },
                    definiteAssignment: true,
                    typeAnnotation: { kind: "Identifier", name: "string" }
                }
            ]
        });
    });


    it("parses TypeScript-style class modifiers and optional fields", () => {
        expect(
            parseStatement(
                tokenizeReader("abstract class Demo {\npublic readonly id?: string\nprivate static count: int = 0\nprotected abstract run(): void\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            abstract: true,
            name: { kind: "Identifier", name: "Demo" },
            members: [
                {
                    kind: "ClassFieldMember",
                    accessModifier: "public",
                    readonly: true,
                    optional: true,
                    name: { kind: "Identifier", name: "id" },
                    typeAnnotation: { kind: "Identifier", name: "string" }
                },
                {
                    kind: "ClassFieldMember",
                    accessModifier: "private",
                    static: true,
                    name: { kind: "Identifier", name: "count" },
                    typeAnnotation: { kind: "Identifier", name: "int" },
                    initializer: { kind: "IntLiteral", value: 0 }
                },
                {
                    kind: "ClassMethodMember",
                    accessModifier: "protected",
                    abstract: true,
                    name: { kind: "Identifier", name: "run" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "void" },
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });

    it("parses TypeScript constructor parameter properties", () => {
        expect(
            parseStatement(
                tokenizeReader("class User { constructor(public readonly id: string, private age = 0, protected nickname?: string) {} }")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "User" },
            members: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "constructor" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            accessModifier: "public",
                            readonly: true,
                            name: { kind: "Identifier", name: "id" },
                            typeAnnotation: { kind: "Identifier", name: "string" }
                        },
                        {
                            kind: "FunctionParameter",
                            accessModifier: "private",
                            name: { kind: "Identifier", name: "age" },
                            defaultValue: { kind: "IntLiteral", value: 0 }
                        },
                        {
                            kind: "FunctionParameter",
                            accessModifier: "protected",
                            optional: true,
                            name: { kind: "Identifier", name: "nickname" },
                            typeAnnotation: { kind: "Identifier", name: "string" }
                        }
                    ],
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });

    it("rejects parameter properties outside constructors", () => {
        expect(() => parseStatement(tokenizeReader("fun demo(public value: string) {}"))).toThrow(
            "Parameter properties are only allowed in constructors"
        );
        expect(() => parseStatement(tokenizeReader("class Demo { run(private value: string) {} }"))).toThrow(
            "Parameter properties are only allowed in constructors"
        );
        expect(() => parseStatement(tokenizeReader("class Demo { constructor(public ...values: string[]) {} }"))).toThrow(
            "A parameter property cannot be a rest parameter"
        );
        expect(() => parseStatement(tokenizeReader("class Demo { constructor(public this: Demo) {} }"))).toThrow(
            "A this parameter cannot be a parameter property"
        );
    });

    it("parses class method signatures without body as semantic-level missing body", () => {
        expect(
            parseStatement(
                tokenizeReader("class Demo {\n  say(): number\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Demo" },
            members: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "say" },
                    missingBody: true,
                    parameters: [],
                    returnType: { kind: "Identifier", name: "number" },
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

    it("parses constrained type parameters", () => {
        const ast = new Parser(
            tokenizeReader("class Repository<T extends Entity, K extends string> {}")
        ).parseFile();

        expect(ast.body[0]).toMatchObject({
            kind: "ClassStatement",
            typeParameters: [
                {
                    kind: "TypeParameter",
                    name: { kind: "Identifier", name: "T" },
                    constraint: { kind: "Identifier", name: "Entity" }
                },
                {
                    kind: "TypeParameter",
                    name: { kind: "Identifier", name: "K" },
                    constraint: { kind: "Identifier", name: "string" }
                }
            ]
        });
    });

    it("parses class with type parameters, extends, and implements", () => {
        expect(
            parseStatement(
                tokenizeReader("class Map<K, V> extends BaseMap<K, V> implements Iterable<K>, Serializable {}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Map" },
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "K" } },
                { kind: "TypeParameter", name: { kind: "Identifier", name: "V" } }
            ],
            extendsType: { kind: "Identifier", name: "BaseMap<K, V>" },
            implementsTypes: [
                { kind: "Identifier", name: "Iterable<K>" },
                { kind: "Identifier", name: "Serializable" }
            ],
            members: []
        });
    });

    it("parses generic class methods with function-type parameter annotations", () => {
        expect(
            parseStatement(
                tokenizeReader("class Array<T> { map<R>(mapper: (item: T) => T): Array<R> {} }")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Array" },
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }
            ],
            members: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "map" },
                    typeParameters: [
                        { kind: "TypeParameter", name: { kind: "Identifier", name: "R" } }
                    ],
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "mapper" },
                            typeAnnotation: { kind: "Identifier", name: "(item:T) => T" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "Array<R>" },
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });

    it("parses nested generic type annotations without treating closing angles as shifts", () => {
        expect(parseStatement(tokenizeReader("let points: Array<Map<string, Point>>"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "Array<Map<string, Point>>" }
        });

        expect(parseStatement(tokenizeReader("let matrix: Array<Array<Map<string, Point>>>"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "Array<Array<Map<string, Point>>>" }
        });

        expect(parseStatement(tokenizeReader("function collect<T extends Array<Map<string, Point>>>(items: T): Array<Array<Map<string, Point>>> { return items }"))).toMatchObject({
            kind: "FunctionStatement",
            typeParameters: [
                {
                    kind: "TypeParameter",
                    name: { kind: "Identifier", name: "T" },
                    constraint: { kind: "Identifier", name: "Array<Map<string, Point>>" }
                }
            ],
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "items" },
                    typeAnnotation: { kind: "Identifier", name: "T" }
                }
            ],
            returnType: { kind: "Identifier", name: "Array<Array<Map<string, Point>>>" }
        });

        expect(parseExpression(tokenizeReader("factory<Array<Map<string, Point>>>(points)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "factory" },
            arguments: [{ kind: "Identifier", name: "points" }],
            typeArguments: [{ kind: "Identifier", name: "Array<Map<string, Point>>" }]
        });

        expect(parseExpression(tokenizeReader("a >> b >>> c"))).toEqual({
            kind: "BinaryExpression",
            operator: ">>>",
            left: {
                kind: "BinaryExpression",
                operator: ">>",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "Identifier", name: "b" }
            },
            right: { kind: "Identifier", name: "c" }
        });

        expect(parseExpression(tokenizeReader("a < b >> c"))).toEqual({
            kind: "BinaryExpression",
            operator: "<",
            left: { kind: "Identifier", name: "a" },
            right: {
                kind: "BinaryExpression",
                operator: ">>",
                left: { kind: "Identifier", name: "b" },
                right: { kind: "Identifier", name: "c" }
            }
        });
    });

    it("parses union, intersection, literal, and tuple type annotations", () => {
        expect(parseStatement(tokenizeReader("let value: string | number | null"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "string | number | null" }
        });
        expect(parseStatement(tokenizeReader("let value: A & B"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "A & B" }
        });
        expect(parseStatement(tokenizeReader("let status: \"ok\" | false"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: '"ok" | false' }
        });
        expect(parseStatement(tokenizeReader("let pair: [string, int]"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "[string, int]" }
        });
        expect(parseStatement(tokenizeReader("let point: { x: int; y?: string }"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "{ x: int, y?: string }" }
        });
    });

    it("parses mapped, conditional, and infer type annotations", () => {
        expect(parseStatement(tokenizeReader("type Optional<T> = { [K in keyof T]?: T[K] }"))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "{ [K in keyof T]?: T[K] }" }
        });
        expect(parseStatement(tokenizeReader("type Concrete<T> = { -readonly [K in keyof T as K]-?: T[K] }"))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "{ -readonly [K in keyof T as K]-?: T[K] }" }
        });
        expect(parseStatement(tokenizeReader("type Element<T> = T extends (infer U)[] ? U : T"))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "T extends (infer U)[] ? U : T" }
        });
        expect(parseStatement(tokenizeReader("type Constrained<T> = T extends infer U extends string ? U : never"))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "T extends infer U extends string ? U : never" }
        });
        expect(parseStatement(tokenizeReader("type Recursive<T> = T extends string ? true : T extends number ? false : never"))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "T extends string ? true : T extends number ? false : never" }
        });
    });

    it("parses keyof, typeof type queries, and indexed access type annotations", () => {
        expect(parseStatement(tokenizeReader("let key: keyof Person"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "keyof Person" }
        });
        expect(parseStatement(tokenizeReader("let copy: typeof person.name"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "typeof person.name" }
        });
        expect(parseStatement(tokenizeReader('let name: Person["name"]'))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "Person[\"name\"]" }
        });
        expect(parseStatement(tokenizeReader("type Values<T> = T[keyof T]"))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "T[keyof T]" }
        });
    });

    it("parses generic type aliases", () => {
        expect(parseStatement(tokenizeReader("type Boxed<T> = Box<T>[]"))).toEqual({
            kind: "TypeAliasStatement",
            name: { kind: "Identifier", name: "Boxed" },
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }
            ],
            targetType: { kind: "Identifier", name: "Box<T>[]" }
        });
    });

    it("parses interface with extends and generic annotations", () => {
        expect(
            parseStatement(
                tokenizeReader(
                    "interface Dictionary<K, V> extends Iterable<K>, Serializable { get(key: K): V; keys: K[] }"
                )
            )
        ).toEqual({
            kind: "InterfaceStatement",
            name: { kind: "Identifier", name: "Dictionary" },
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "K" } },
                { kind: "TypeParameter", name: { kind: "Identifier", name: "V" } }
            ],
            extendsTypes: [
                { kind: "Identifier", name: "Iterable<K>" },
                { kind: "Identifier", name: "Serializable" }
            ],
            members: [
                {
                    kind: "InterfaceMethodMember",
                    name: { kind: "Identifier", name: "get" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "key" },
                            typeAnnotation: { kind: "Identifier", name: "K" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "V" }
                },
                {
                    kind: "InterfacePropertyMember",
                    name: { kind: "Identifier", name: "keys" },
                    typeAnnotation: { kind: "Identifier", name: "K[]" }
                }
            ]
        });
    });

    it("parses class statement with kotlin-like primary constructor parameters without val/var", () => {
        expect(parseStatement(tokenizeReader("class Point(x: number, y: number) {\n}"))).toEqual({
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

        expect(parseStatement(tokenizeReader("class Point(x: number, y: number)"))).toEqual({
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
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "inp" },
                    optional: true,
                    typeAnnotation: { kind: "Identifier", name: "moment.MomentInput" }
                },
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "strict" },
                    optional: true,
                    typeAnnotation: { kind: "Identifier", name: "boolean" }
                }
            ],
            returnType: { kind: "Identifier", name: "moment.Moment" },
            missingBody: true,
            body: { kind: "BlockStatement", body: [] }
        });
    });

    it("parses additional ambient declaration forms", () => {
        const program = parseFile(tokenizeReader(
            "declare type Id = string;\n" +
            "declare abstract class Service { abstract run(id: Id): void }\n" +
            "export declare const service: Service;\n" +
            "export declare function create(id: Id): Service;"
        ), { language: "typescript" });

        expect(program.body).toMatchObject([
            { kind: "TypeAliasStatement", declared: true, name: { name: "Id" }, targetType: { name: "string" } },
            { kind: "ClassStatement", declared: true, abstract: true, name: { name: "Service" } },
            { kind: "ExportStatement", declaration: { kind: "VarStatement", declared: true, name: { name: "service" } } },
            {
                kind: "ExportStatement",
                declaration: {
                    kind: "FunctionStatement",
                    declared: true,
                    name: { name: "create" },
                    parameters: [{ name: { name: "id" }, typeAnnotation: { name: "Id" } }],
                    returnType: { name: "Service" }
                }
            }
        ]);
    });

    it("parses string-named ambient external modules in typescript mode", () => {
        expect(
            parseStatement(tokenizeReader('declare module "pixi.js" { export = PIXI; }'), { language: "typescript" })
        ).toEqual({
            kind: "NamespaceStatement",
            declared: true,
            declarationKind: "module",
            externalModuleName: { kind: "StringLiteral", value: "pixi.js" },
            body: {
                kind: "BlockStatement",
                body: [{
                    kind: "ExprStatement",
                    expression: { kind: "Identifier", name: "PIXI" }
                }]
            }
        });
    });

    it("parses runtime namespace declarations", () => {
        expect(parseStatement(tokenizeReader("namespace Tools { export const version = 1 }"))).toMatchObject({
            kind: "NamespaceStatement",
            declarationKind: "namespace",
            names: [{ kind: "Identifier", name: "Tools" }],
            body: { body: [{ kind: "ExportStatement", declaration: { kind: "VarStatement" } }] }
        });
    });

    it("parses dotted ambient namespace bodies in typescript mode", () => {
        expect(
            parseStatement(tokenizeReader("declare namespace Company.Tools {\nexport interface Config { name: string }\nexport const version: string;\n}"), { language: "typescript" })
        ).toEqual({
            kind: "NamespaceStatement",
            declared: true,
            declarationKind: "namespace",
            names: [
                { kind: "Identifier", name: "Company" },
                { kind: "Identifier", name: "Tools" }
            ],
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ExportStatement",
                        declaration: {
                            kind: "InterfaceStatement",
                            declared: true,
                            name: { kind: "Identifier", name: "Config" },
                            members: [{ kind: "InterfacePropertyMember", name: { kind: "Identifier", name: "name" }, typeAnnotation: { kind: "Identifier", name: "string" } }]
                        }
                    },
                    {
                        kind: "ExportStatement",
                        declaration: {
                            kind: "VarStatement",
                            declarationKind: "const",
                            declared: true,
                            name: { kind: "Identifier", name: "version" },
                            typeAnnotation: { kind: "Identifier", name: "string" }
                        }
                    }
                ]
            }
        });
    });

    it("rejects string-named namespaces in typescript mode", () => {
        expect(() =>
            parseStatement(tokenizeReader('declare namespace "pixi.js" {}'), { language: "typescript" })
        ).toThrow("Expected namespace or module name after declaration keyword");
    });

    it("parses generic 'declare function' type parameters", () => {
        expect(
            parseStatement(
                tokenizeReader("declare function identity<T>(value: T): T;"),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "FunctionStatement",
            declarationKind: "function",
            declared: true,
            name: { kind: "Identifier", name: "identity" },
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }
            ],
            parameters: [{ kind: "FunctionParameter", name: { kind: "Identifier", name: "value" }, typeAnnotation: { kind: "Identifier", name: "T" } }],
            returnType: { kind: "Identifier", name: "T" },
            missingBody: true,
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
            parameters: [
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "inp" }, optional: true, typeAnnotation: { kind: "Identifier", name: "moment.MomentInput" } },
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "strict" }, optional: true, typeAnnotation: { kind: "Identifier", name: "boolean" } }
            ],
            returnType: { kind: "Identifier", name: "moment.Moment" },
            missingBody: true,
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

    it("parses 'declare interface' with extends and members", () => {
        expect(
            parseStatement(
                tokenizeReader(
                    "declare interface Repo<T> extends Iterable<T> { find(id: int): T; items: T[] }"
                )
            )
        ).toEqual({
            kind: "InterfaceStatement",
            declared: true,
            name: { kind: "Identifier", name: "Repo" },
            typeParameters: [{ kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }],
            extendsTypes: [{ kind: "Identifier", name: "Iterable<T>" }],
            members: [
                {
                    kind: "InterfaceMethodMember",
                    name: { kind: "Identifier", name: "find" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "id" },
                            typeAnnotation: { kind: "Identifier", name: "int" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "T" }
                },
                {
                    kind: "InterfacePropertyMember",
                    name: { kind: "Identifier", name: "items" },
                    typeAnnotation: { kind: "Identifier", name: "T[]" }
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


    it("parses extension properties", () => {
        expect(parseStatement(tokenizeReader("val number.milliseconds => Duration(this)"))).toEqual({
            kind: "VarStatement",
            declarationKind: "val",
            receiverType: { kind: "Identifier", name: "number" },
            name: { kind: "Identifier", name: "milliseconds" },
            initializer: {
                kind: "CallExpression",
                callee: { kind: "Identifier", name: "Duration" },
                arguments: [{ kind: "Identifier", name: "this" }]
            }
        });
    });


    it("parses export declarations and export lists", () => {
        expect(parseStatement(tokenizeReader("export const value: number = 1"))).toEqual({
            kind: "ExportStatement",
            declaration: {
                kind: "VarStatement",
                declarationKind: "const",
                name: { kind: "Identifier", name: "value" },
                typeAnnotation: { kind: "Identifier", name: "number" },
                initializer: { kind: "IntLiteral", value: 1 }
            }
        });

        expect(parseStatement(tokenizeReader("export { value as renamed, other } from \"./mod\""))).toEqual({
            kind: "ExportStatement",
            specifiers: [
                {
                    kind: "ExportSpecifier",
                    local: { kind: "Identifier", name: "value" },
                    exported: { kind: "Identifier", name: "renamed" }
                },
                {
                    kind: "ExportSpecifier",
                    exported: { kind: "Identifier", name: "other" }
                }
            ],
            from: { kind: "StringLiteral", value: "./mod" }
        });

        expect(parseStatement(tokenizeReader("export * from \"./all\""))).toEqual({
            kind: "ExportStatement",
            exportAll: true,
            from: { kind: "StringLiteral", value: "./all" }
        });

        expect(parseStatement(tokenizeReader("export as namespace MyLib"))).toEqual({
            kind: "ExportStatement",
            namespaceExport: { kind: "Identifier", name: "MyLib" }
        });
    });

    it("parses default and type-only exports", () => {
        expect(parseStatement(tokenizeReader("export default value"))).toEqual({
            kind: "ExportStatement",
            default: true,
            declaration: {
                kind: "ExprStatement",
                expression: { kind: "Identifier", name: "value" }
            }
        });

        expect(parseStatement(tokenizeReader("export type Name = string"))).toEqual({
            kind: "ExportStatement",
            declaration: {
                kind: "TypeAliasStatement",
                name: { kind: "Identifier", name: "Name" },
                targetType: { kind: "Identifier", name: "string" }
            }
        });

        expect(parseStatement(tokenizeReader("export type { Name } from \"./types\""))).toEqual({
            kind: "ExportStatement",
            typeOnly: true,
            specifiers: [
                {
                    kind: "ExportSpecifier",
                    exported: { kind: "Identifier", name: "Name" }
                }
            ],
            from: { kind: "StringLiteral", value: "./types" }
        });
    });

    it("parses named import statements", () => {
        expect(parseStatement(tokenizeReader("import { Point, Demo } from \"./a\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "Point" }
                },
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "Demo" }
                }
            ],
            from: { kind: "StringLiteral", value: "./a" }
        });
    });

    it("parses default, namespace, side-effect, type-only, and aliased import forms", () => {
        expect(parseStatement(tokenizeReader("import React from \"react\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [],
            defaultImport: { kind: "Identifier", name: "React" },
            from: { kind: "StringLiteral", value: "react" }
        });

        expect(parseStatement(tokenizeReader("import * as fs from \"fs\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [],
            namespaceImport: { kind: "Identifier", name: "fs" },
            from: { kind: "StringLiteral", value: "fs" }
        });

        expect(parseStatement(tokenizeReader("import \"./setup\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [],
            sideEffectOnly: true,
            from: { kind: "StringLiteral", value: "./setup" }
        });

        expect(parseStatement(tokenizeReader("import type { Point as LocalPoint } from \"./a\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "Point" },
                    local: { kind: "Identifier", name: "LocalPoint" }
                }
            ],
            typeOnly: true,
            from: { kind: "StringLiteral", value: "./a" }
        });

        expect(parseStatement(tokenizeReader("import React, { useState as useLocalState } from \"react\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "useState" },
                    local: { kind: "Identifier", name: "useLocalState" }
                }
            ],
            defaultImport: { kind: "Identifier", name: "React" },
            from: { kind: "StringLiteral", value: "react" }
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

    it("parses with statements, statement labels, and labeled break/continue", () => {
        expect(parseProgram(tokenizeReader("outer: while (ok) { with (scope) { break outer }; continue outer }; done"))).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "LabeledStatement",
                    label: { kind: "Identifier", name: "outer" },
                    body: {
                        kind: "WhileStatement",
                        condition: { kind: "Identifier", name: "ok" },
                        body: {
                            kind: "BlockStatement",
                            body: [
                                {
                                    kind: "WithStatement",
                                    object: { kind: "Identifier", name: "scope" },
                                    body: {
                                        kind: "BlockStatement",
                                        body: [
                                            {
                                                kind: "BreakStatement",
                                                label: { kind: "Identifier", name: "outer" }
                                            }
                                        ]
                                    }
                                },
                                {
                                    kind: "ContinueStatement",
                                    label: { kind: "Identifier", name: "outer" }
                                }
                            ]
                        }
                    }
                },
                { kind: "ExprStatement", expression: { kind: "Identifier", name: "done" } }
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

    it("treats leading '[' on a new line as a new expression statement", () => {
        expect(
            parseProgram(
                tokenizeReader("var res = map.b\n\n[1,2,3,4].map(10)")
            )
        ).toEqual({
            kind: "Program",
            body: [
                {
                    kind: "VarStatement",
                    declarationKind: "var",
                    name: { kind: "Identifier", name: "res" },
                    initializer: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "map" },
                        property: { kind: "Identifier", name: "b" },
                        computed: false
                    }
                },
                {
                    kind: "ExprStatement",
                    expression: {
                        kind: "CallExpression",
                        callee: {
                            kind: "MemberExpression",
                            object: {
                                kind: "ArrayLiteral",
                                elements: [
                                    { kind: "IntLiteral", value: 1 },
                                    { kind: "IntLiteral", value: 2 },
                                    { kind: "IntLiteral", value: 3 },
                                    { kind: "IntLiteral", value: 4 }
                                ]
                            },
                            property: { kind: "Identifier", name: "map" },
                            computed: false
                        },
                        arguments: [{ kind: "IntLiteral", value: 10 }]
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
        expect(statement?.firstToken?.value).toBe("let");
        expect(statement?.lastToken?.value).toBe("1");
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
        expect(parser.errors[0]?.token?.range.start).toEqual({
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
        expect(parser.errors[0]?.token?.value).toBe("=");
        expect(parser.errors[1]?.token?.value).toBe("=");
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

    it("recovers from malformed nested if statements inside switch cases", () => {
        const parser = new Parser(tokenizeReader(
            "switch (x) {\n" +
            "  case 1:\n" +
            "    if (ok) { let bad = ; }\n" +
            "    let keep = 1\n" +
            "    break\n" +
            "  default:\n" +
            "    let fallback = 2\n" +
            "}\n" +
            "let after = 3\n"
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        expect(ast.body[0]).toMatchObject({
            kind: "SwitchStatement",
            cases: [
                {
                    kind: "SwitchCase",
                    test: { kind: "IntLiteral", value: 1 },
                    consequent: [
                        {
                            kind: "IfStatement",
                            condition: { kind: "Identifier", name: "ok" },
                            thenBranch: { kind: "BlockStatement", body: [] }
                        },
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
                            name: { kind: "Identifier", name: "keep" },
                            initializer: { kind: "IntLiteral", value: 1 }
                        },
                        { kind: "BreakStatement" }
                    ]
                },
                {
                    kind: "SwitchCase",
                    consequent: [
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
                            name: { kind: "Identifier", name: "fallback" }
                        }
                    ]
                }
            ]
        });
        expect(ast.body[1]).toMatchObject({
            kind: "VarStatement",
            declarationKind: "let",
            name: { kind: "Identifier", name: "after" }
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers from broken for headers and keeps following statements", () => {
        const parser = new Parser(tokenizeReader(
            "{\n" +
            "  for (let i = ; i < 2; i += 1) let bad = i\n" +
            "  let ok = 1\n" +
            "}\n" +
            "let after = 2\n"
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        const block = ast.body[0];
        expect(block?.kind).toBe("BlockStatement");
        if (!block || block.kind !== "BlockStatement") {
            throw new Error("Expected first statement to be a block");
        }
        const blockBody = (block as unknown as { body: Array<any> }).body;
        expect(
            blockBody.some((statement: any) =>
                statement.kind === "VarStatement" &&
                statement.name.name === "ok"
            )
        ).toBe(true);
        expect(ast.body[1]).toMatchObject({
            kind: "VarStatement",
            declarationKind: "let",
            name: { kind: "Identifier", name: "after" }
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers from malformed chained calls and parses subsequent statements", () => {
        const parser = new Parser(tokenizeReader(
            "{\n" +
            "  target.run(1, ).next(;\n" +
            "  let ok = 1\n" +
            "}\n" +
            "let done = 2\n"
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        expect(ast.body[0]?.kind).toBe("BlockStatement");
        expect(ast.body[1]).toMatchObject({
            kind: "VarStatement",
            declarationKind: "let",
            name: { kind: "Identifier", name: "done" }
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

    it("recovers incomplete member access before newline and keeps following declarations", () => {
        const parser = new Parser(tokenizeReader(
            "fun demo() {\n" +
            "  const result: Point = value\n" +
            "  return result.\n" +
            "}\n" +
            "class Point(val x: int, val y: int)\n"
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        expect(ast.body[0]).toMatchObject({
            kind: "FunctionStatement",
            name: { kind: "Identifier", name: "demo" },
            body: {
                body: [
                    {
                        kind: "VarStatement",
                        declarationKind: "const",
                        name: { kind: "Identifier", name: "result" },
                        typeAnnotation: { kind: "Identifier", name: "Point" }
                    },
                    {
                        kind: "ReturnStatement",
                        expression: { kind: "Identifier", name: "result" }
                    }
                ]
            }
        });
        expect(ast.body[1]).toMatchObject({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Point" }
        });
        expect(parser.errors.map((issue) => issue.message)).toContain("Expected identifier after '.'");
    });

    it("recovers separator errors across newline-heavy continuations until a likely statement start", () => {
        const parser = new Parser(tokenizeReader(
            "{ let a = 1 let b =\n" +
            "  +\n" +
            "  2\n" +
            "  let c = 3\n" +
            "}\n"
        ));
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
                            name: { kind: "Identifier", name: "a" },
                            initializer: { kind: "IntLiteral", value: 1 }
                        },
                        {
                            kind: "VarStatement",
                            declarationKind: "let",
                            name: { kind: "Identifier", name: "c" },
                            initializer: { kind: "IntLiteral", value: 3 }
                        }
                    ]
                }
            ]
        });
        expect(parser.errors.map((issue) => issue.message)).toContain(
            "Expected ';', newline, or '}' between statements"
        );
    });

    it("attaches parse recovery markers to the returned AST", () => {
        const parser = new Parser(tokenizeReader("{ let bad = ; let ok = 1 }"));
        const ast = parser.parseFile();

        const markers = getProgramRecoveryMarkers(ast);
        expect(markers.length).toBeGreaterThan(0);
        expect(markers[0]?.token.value).toBe(";");
        expect(markers[0]?.token.range.start.line).toBe(0);
    });
});


describe("parse enum declarations", () => {
    it("builds AST nodes for enum and const enum declarations", () => {
        expect(parseFile(tokenizeReader("enum Direction { Up, Down = 4, Left, Right = \"right\" }"))).toEqual({
            kind: "Program",
            body: [{
                kind: "EnumStatement",
                name: { kind: "Identifier", name: "Direction" },
                members: [
                    { kind: "EnumMember", name: { kind: "Identifier", name: "Up" } },
                    { kind: "EnumMember", name: { kind: "Identifier", name: "Down" }, initializer: { kind: "IntLiteral", value: 4 } },
                    { kind: "EnumMember", name: { kind: "Identifier", name: "Left" } },
                    { kind: "EnumMember", name: { kind: "Identifier", name: "Right" }, initializer: { kind: "StringLiteral", value: "right" } }
                ]
            }]
        });

        expect(parseFile(tokenizeReader("const enum Status { Ready = 1, Done }"))).toEqual({
            kind: "Program",
            body: [{
                kind: "EnumStatement",
                const: true,
                name: { kind: "Identifier", name: "Status" },
                members: [
                    { kind: "EnumMember", name: { kind: "Identifier", name: "Ready" }, initializer: { kind: "IntLiteral", value: 1 } },
                    { kind: "EnumMember", name: { kind: "Identifier", name: "Done" } }
                ]
            }]
        });
    });
    it("parses async functions, generator functions, yield, and this parameters", () => {
        const program = parseFile(tokenizeReader(`async function load(this: Loader, id: string) { return await fetch(id) }
function* ids() { yield 1; yield* more }
class Store { async save(this: Store) { return await persist(this) }; *values() { yield 1 } }`));

        expect(program.body[0]).toMatchObject({
            kind: "FunctionStatement",
            async: true,
            name: { name: "load" },
            parameters: [
                { kind: "FunctionParameter", thisParameter: true, name: { name: "this" }, typeAnnotation: { name: "Loader" } },
                { kind: "FunctionParameter", name: { name: "id" }, typeAnnotation: { name: "string" } }
            ]
        });
        expect(program.body[1]).toMatchObject({
            kind: "FunctionStatement",
            generator: true,
            name: { name: "ids" },
            body: {
                body: [
                    { kind: "ExprStatement", expression: { kind: "UnaryExpression", operator: "yield" } },
                    { kind: "ExprStatement", expression: { kind: "UnaryExpression", operator: "yield*" } }
                ]
            }
        });
        expect(program.body[2]).toMatchObject({
            kind: "ClassStatement",
            members: [
                { kind: "ClassMethodMember", async: true, name: { name: "save" } },
                { kind: "ClassMethodMember", generator: true, name: { name: "values" } }
            ]
        });
    });

    it("parses object and array binding patterns in variable declarations", () => {
        const program = parseFile(tokenizeReader("let { id, name: displayName, nested: { value = 1 }, ...rest } = source\nconst [first, , third = 3, ...tail] = values"));

        expect(program.body[0]).toMatchObject({
            kind: "VarStatement",
            name: {
                kind: "ObjectBindingPattern",
                elements: [
                    { kind: "BindingElement", name: { kind: "Identifier", name: "id" }, shorthand: true },
                    { kind: "BindingElement", propertyName: { name: "name" }, name: { name: "displayName" } },
                    { kind: "BindingElement", propertyName: { name: "nested" }, name: { kind: "ObjectBindingPattern" } },
                    { kind: "BindingElement", rest: true, name: { name: "rest" } }
                ]
            }
        });
        expect(program.body[1]).toMatchObject({
            kind: "VarStatement",
            name: {
                kind: "ArrayBindingPattern",
                elements: [
                    { kind: "BindingElement", name: { name: "first" } },
                    { kind: "BindingHole" },
                    { kind: "BindingElement", name: { name: "third" }, initializer: { kind: "IntLiteral", value: 3 } },
                    { kind: "BindingElement", rest: true, name: { name: "tail" } }
                ]
            }
        });
    });


    it("parses brace lambdas inside call argument lists while preserving object literals", () => {
        expect(parseExpression(tokenizeReader("apply({ value -> value + 1 })"))).toMatchObject({
            kind: "CallExpression",
            arguments: [{ kind: "ArrowFunctionExpression", parameters: [{ name: { name: "value" } }] }]
        });
        expect(parseExpression(tokenizeReader("apply({ it })"))).toMatchObject({
            kind: "CallExpression",
            arguments: [{ kind: "ArrowFunctionExpression", contextualObjectLiteral: { kind: "ObjectLiteral" } }]
        });
        expect(parseExpression(tokenizeReader("apply({ value: 1 })"))).toMatchObject({
            kind: "CallExpression",
            arguments: [{ kind: "ObjectLiteral" }]
        });
    });

});

describe("destructured parameters", () => {
    it("parses object, array, nested, default, and rest binding patterns", () => {
        const program = parseFile(tokenizeReader("function unpack({ id, nested: { value = 1 }, ...meta }, [first, , ...tail] = values) { return value }"));
        expect(program.body[0]).toMatchObject({
            kind: "FunctionStatement",
            parameters: [
                { name: { kind: "ObjectBindingPattern", elements: [
                    { name: { name: "id" }, shorthand: true },
                    { propertyName: { name: "nested" }, name: { kind: "ObjectBindingPattern" } },
                    { rest: true, name: { name: "meta" } }
                ] } },
                { name: { kind: "ArrayBindingPattern", elements: [
                    { name: { name: "first" } }, { kind: "BindingHole" }, { rest: true, name: { name: "tail" } }
                ] }, defaultValue: { kind: "Identifier", name: "values" } }
            ]
        });
    });
});

describe("JavaScript implementation annotations", () => {
    it("parses @JsImpl on bodyless functions", () => {
        const program = parseFile(tokenizeReader('@JsImpl("if (!cond) throw new Error(message)")\nfun assert(cond: boolean, message: string = "assert failed")'));

        expect(program.body[0]).toMatchObject({
            kind: "FunctionStatement",
            name: { name: "assert" },
            missingBody: true,
            jsImpl: "if (!cond) throw new Error(message)"
        });
    });
});
