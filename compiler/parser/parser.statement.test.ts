import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { Parser, parseExpression, parseFile, parseStatement } from "./parser";
import { tokenizeReader } from "./tokenizer";
import type { ClassStatement } from "compiler/ast/ast";

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

    it("supports val declaration in for initializer in vexa mode", () => {
        expect(parseStatement(tokenizeReader("for (val i = 0; i < 1; i += 1) break"), { language: "vexa" })).toEqual({
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

    it("parses TypeScript for-in without a declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value in iterable) break"), { language: "typescript" })).toEqual({
            kind: "ForStatement",
            iterationKind: "in",
            iterator: { kind: "Identifier", name: "value" },
            iterable: { kind: "Identifier", name: "iterable" },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses VexaScript for-in without declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value in iterable) break"), { language: "vexa" })).toEqual({
            kind: "ForStatement",
            iterationKind: "in",
            iterator: { kind: "Identifier", name: "value" },
            iterable: { kind: "Identifier", name: "iterable" },
            body: {
                kind: "BreakStatement"
            }
        });
    });

    it("parses VexaScript for-of without declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value of 0 ... 10) break"), { language: "vexa" })).toEqual({
            kind: "ForStatement",
            iterationKind: "of",
            iterator: { kind: "Identifier", name: "value" },
            iterable: {
                kind: "RangeExpression",
                start: { kind: "IntLiteral", value: 0 },
                end: { kind: "IntLiteral", value: 10 },
                exclusive: false
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

    it("parses extension index operator function statements", () => {
        expect(parseStatement(tokenizeReader("fun Bag.operator[](index: int): string { return \"item\" }"))).toMatchObject({
            kind: "FunctionStatement",
            declarationKind: "fun",
            receiverType: { kind: "Identifier", name: "Bag" },
            name: { kind: "Identifier", name: "operator[]" },
            operator: "[]",
            parameters: [
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "index" }, typeAnnotation: { kind: "Identifier", name: "int" } }
            ],
            returnType: { kind: "Identifier", name: "string" }
        });
        expect(parseStatement(tokenizeReader("fun Bag.operator[]=(value: string, index: int): void { }"))).toMatchObject({
            kind: "FunctionStatement",
            declarationKind: "fun",
            receiverType: { kind: "Identifier", name: "Bag" },
            name: { kind: "Identifier", name: "operator[]=" },
            operator: "[]=",
            parameters: [
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "value" }, typeAnnotation: { kind: "Identifier", name: "string" } },
                { kind: "FunctionParameter", name: { kind: "Identifier", name: "index" }, typeAnnotation: { kind: "Identifier", name: "int" } }
            ],
            returnType: { kind: "Identifier", name: "void" }
        });
    });

    it("parses a generic extension method on a generic receiver", () => {
        expect(parseStatement(tokenizeReader("fun <T> Array<T>.demo(): int { return length }"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
            name: { kind: "Identifier", name: "demo" },
            receiverType: { kind: "Identifier", name: "Array" },
            receiverTypeArguments: [{ kind: "Identifier", name: "T" }],
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }
            ],
            parameters: [],
            returnType: { kind: "Identifier", name: "int" },
            body: {
                kind: "BlockStatement",
                body: [{ kind: "ReturnStatement", expression: { kind: "Identifier", name: "length" } }]
            }
        });
    });

    it("parses a generic extension property on a generic receiver", () => {
        expect(parseStatement(tokenizeReader("val <T> Array<T>.doubledLength => length * 2"))).toEqual({
            kind: "VarStatement",
            declarationKind: "val",
            receiverType: { kind: "Identifier", name: "Array" },
            receiverTypeArguments: [{ kind: "Identifier", name: "T" }],
            typeParameters: [
                { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }
            ],
            name: { kind: "Identifier", name: "doubledLength" },
            initializer: {
                kind: "BinaryExpression",
                operator: "*",
                left: { kind: "Identifier", name: "length" },
                right: { kind: "IntLiteral", value: 2 }
            }
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

    it("parses function shorthand bodies with =>", () => {
        expect(parseStatement(tokenizeReader("fun demo(value: int): int => value + 1"))).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
            name: { kind: "Identifier", name: "demo" },
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "value" },
                    typeAnnotation: { kind: "Identifier", name: "int" }
                }
            ],
            returnType: { kind: "Identifier", name: "int" },
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "ReturnStatement",
                        expression: {
                            kind: "BinaryExpression",
                            operator: "+",
                            left: { kind: "Identifier", name: "value" },
                            right: { kind: "IntLiteral", value: 1 }
                        }
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

    it("parses defer statements", () => {
        expect(parseStatement(tokenizeReader("defer file.close()"))).toEqual({
            kind: "DeferStatement",
            expression: {
                kind: "CallExpression",
                callee: {
                    kind: "MemberExpression",
                    object: { kind: "Identifier", name: "file" },
                    computed: false,
                    property: { kind: "Identifier", name: "close" },
                },
                arguments: []
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

    it("parses computed class methods like [Symbol.asyncIterator]()", () => {
        expect(
            parseStatement(
                tokenizeReader("class Stream {\nasync *[Symbol.asyncIterator](): AsyncGenerator<int> { yield 1 }\n}", { jsx: false }),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Stream" },
            members: [
                {
                    kind: "ClassMethodMember",
                    async: true,
                    generator: true,
                    computed: true,
                    computedKey: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "Symbol" },
                        property: { kind: "Identifier", name: "asyncIterator" },
                        computed: false
                    },
                    name: { kind: "Identifier", name: "[Symbol.asyncIterator]" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "AsyncGenerator<int>" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ExprStatement",
                                expression: {
                                    kind: "UnaryExpression",
                                    operator: "yield",
                                    argument: { kind: "IntLiteral", value: 1 }
                                }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("parses class members with explicit property and function declaration keywords", () => {
        expect(
            parseStatement(
                tokenizeReader("class Demo {\nval id: string\nvar count = 0\nasync fun save(): void { }\nfun operator+(other: Demo): Demo { }\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Demo" },
            members: [
                {
                    kind: "ClassFieldMember",
                    declarationKind: "val",
                    readonly: true,
                    name: { kind: "Identifier", name: "id" },
                    typeAnnotation: { kind: "Identifier", name: "string" }
                },
                {
                    kind: "ClassFieldMember",
                    declarationKind: "var",
                    name: { kind: "Identifier", name: "count" },
                    initializer: { kind: "IntLiteral", value: 0 }
                },
                {
                    kind: "ClassMethodMember",
                    declarationKind: "fun",
                    async: true,
                    name: { kind: "Identifier", name: "save" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "void" },
                    body: { kind: "BlockStatement", body: [] }
                },
                {
                    kind: "ClassMethodMember",
                    declarationKind: "fun",
                    name: { kind: "Identifier", name: "operator+" },
                    operator: "+",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "other" },
                            typeAnnotation: { kind: "Identifier", name: "Demo" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "Demo" },
                    body: { kind: "BlockStatement", body: [] }
                }
            ]
        });
    });

    it("parses class method shorthand bodies with =>", () => {
        expect(
            parseStatement(
                tokenizeReader("class Point { operator*(other: Point): Point => Point(x * other.x, y * other.y) }")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Point" },
            members: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "operator*" },
                    operator: "*",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "other" },
                            typeAnnotation: { kind: "Identifier", name: "Point" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "Point" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: {
                                    kind: "CallExpression",
                                    callee: { kind: "Identifier", name: "Point" },
                                    arguments: [
                                        {
                                            kind: "BinaryExpression",
                                            operator: "*",
                                            left: { kind: "Identifier", name: "x" },
                                            right: {
                                                kind: "MemberExpression",
                                                object: { kind: "Identifier", name: "other" },
                                                property: { kind: "Identifier", name: "x" },
                                                computed: false
                                            }
                                        },
                                        {
                                            kind: "BinaryExpression",
                                            operator: "*",
                                            left: { kind: "Identifier", name: "y" },
                                            right: {
                                                kind: "MemberExpression",
                                                object: { kind: "Identifier", name: "other" },
                                                property: { kind: "Identifier", name: "y" },
                                                computed: false
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("parses class index operator methods", () => {
        expect(
            parseStatement(
                tokenizeReader("class Bag {\noperator[](x: int, y: int): string => \"item\"\noperator[]=(value: string, x: int, y: int): void { }\n}")
            )
        ).toMatchObject({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Bag" },
            members: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "operator[]" },
                    operator: "[]",
                    parameters: [
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "x" }, typeAnnotation: { kind: "Identifier", name: "int" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "y" }, typeAnnotation: { kind: "Identifier", name: "int" } }
                    ],
                    returnType: { kind: "Identifier", name: "string" }
                },
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "operator[]=" },
                    operator: "[]=",
                    parameters: [
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "value" }, typeAnnotation: { kind: "Identifier", name: "string" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "x" }, typeAnnotation: { kind: "Identifier", name: "int" } },
                        { kind: "FunctionParameter", name: { kind: "Identifier", name: "y" }, typeAnnotation: { kind: "Identifier", name: "int" } }
                    ],
                    returnType: { kind: "Identifier", name: "void" }
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

    it("parses getter shorthand class members", () => {
        expect(
            parseStatement(
                tokenizeReader("class Rect {\narea: number => this.width * this.height\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Rect" },
            members: [
                {
                    kind: "ClassMethodMember",
                    accessorKind: "get",
                    name: { kind: "Identifier", name: "area" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "number" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: {
                                    kind: "BinaryExpression",
                                    operator: "*",
                                    left: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "this" },
                                        property: { kind: "Identifier", name: "width" },
                                        computed: false
                                    },
                                    right: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "this" },
                                        property: { kind: "Identifier", name: "height" },
                                        computed: false
                                    }
                                }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("parses compound accessor block with implicit newValue setter parameter", () => {
        expect(
            parseStatement(
                tokenizeReader("class Point {\n  var x: int {\n    set { _x = newValue }\n    get { return _x }\n  }\n}")
            )
        ).toMatchObject({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Point" },
            members: [
                {
                    kind: "ClassMethodMember",
                    accessorKind: "get",
                    name: { kind: "Identifier", name: "x" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "int" }
                },
                {
                    kind: "ClassMethodMember",
                    accessorKind: "set",
                    name: { kind: "Identifier", name: "x" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "newValue" },
                            typeAnnotation: { kind: "Identifier", name: "int" }
                        }
                    ]
                }
            ]
        });
    });

    it("parses compound accessor block with explicit setter parameter name", () => {
        expect(
            parseStatement(
                tokenizeReader("class Point {\n  var x: int {\n    set(value) { _x = value }\n    get { return _x }\n  }\n}")
            )
        ).toMatchObject({
            kind: "ClassStatement",
            members: [
                {
                    kind: "ClassMethodMember",
                    accessorKind: "get",
                    name: { kind: "Identifier", name: "x" }
                },
                {
                    kind: "ClassMethodMember",
                    accessorKind: "set",
                    name: { kind: "Identifier", name: "x" },
                    parameters: [{ kind: "FunctionParameter", name: { kind: "Identifier", name: "value" } }]
                }
            ]
        });
    });

    it("parses compound accessor block with typed setter parameter and arrow getter", () => {
        expect(
            parseStatement(
                tokenizeReader("class Point {\n  var x: int {\n    set(value: int) { _x = value }\n    get => _x\n  }\n}")
            )
        ).toMatchObject({
            kind: "ClassStatement",
            members: [
                {
                    kind: "ClassMethodMember",
                    accessorKind: "get",
                    name: { kind: "Identifier", name: "x" }
                },
                {
                    kind: "ClassMethodMember",
                    accessorKind: "set",
                    name: { kind: "Identifier", name: "x" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "value" },
                            typeAnnotation: { kind: "Identifier", name: "int" }
                        }
                    ]
                }
            ]
        });
    });

    it("parses compound accessor block with getter defined first", () => {
        expect(
            parseStatement(
                tokenizeReader("class Point {\n  var x: int {\n    get { return _x }\n    set { _x = newValue }\n  }\n}")
            )
        ).toMatchObject({
            kind: "ClassStatement",
            members: [
                { kind: "ClassMethodMember", accessorKind: "get", name: { kind: "Identifier", name: "x" } },
                { kind: "ClassMethodMember", accessorKind: "set", name: { kind: "Identifier", name: "x" } }
            ]
        });
    });

    it("parses class delegates in colon interface clauses", () => {
        expect(
            parseStatement(tokenizeReader("class MyDemo(val shape: Shape) : Shape by { shape } {}"))
        ).toMatchObject({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "MyDemo" },
            extendsType: { kind: "Identifier", name: "Shape" },
            classDelegates: [
                {
                    kind: "ClassDelegate",
                    typeAnnotation: { kind: "Identifier", name: "Shape" },
                    expression: {
                        kind: "ObjectLiteral",
                        properties: [
                            {
                                kind: "ObjectProperty",
                                key: { kind: "Identifier", name: "shape" },
                                value: { kind: "Identifier", name: "shape" },
                                shorthand: true
                            }
                        ]
                    }
                }
            ],
            members: []
        });
    });

    it("parses getter shorthand class members in implemented interfaces", () => {
        expect(
            parseStatement(
                tokenizeReader("class Rectangle implements Shape {\narea: number => this.width * this.height\n}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Rectangle" },
            implementsTypes: [{ kind: "Identifier", name: "Shape" }],
            members: [
                {
                    kind: "ClassMethodMember",
                    accessorKind: "get",
                    name: { kind: "Identifier", name: "area" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "number" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: {
                                    kind: "BinaryExpression",
                                    operator: "*",
                                    left: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "this" },
                                        property: { kind: "Identifier", name: "width" },
                                        computed: false
                                    },
                                    right: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "this" },
                                        property: { kind: "Identifier", name: "height" },
                                        computed: false
                                    }
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

    it("parses private class fields and methods that reference them", () => {
        expect(
            parseStatement(
                tokenizeReader("class Counter { #value = 1\nread(): int { return this.#value } }"),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Counter" },
            members: [
                {
                    kind: "ClassFieldMember",
                    name: { kind: "Identifier", name: "#value" },
                    initializer: { kind: "IntLiteral", value: 1 }
                },
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "read" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "int" },
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ReturnStatement",
                                expression: {
                                    kind: "MemberExpression",
                                    object: { kind: "Identifier", name: "this" },
                                    property: { kind: "Identifier", name: "#value" },
                                    computed: false
                                }
                            }
                        ]
                    }
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

    it("parses annotations on class field and method members", () => {
        const statement = parseStatement(
            tokenizeReader(dedent`
                class Test extends Behaviour {
                  @Range(1, 10)
                  var scale: number
                  @Deprecated
                  fun init() {}
                }
            `),
            { language: "vexa" }
        ) as ClassStatement;

        const field = statement.members[0]!;
        const method = statement.members[1]!;
        expect(field.kind).toBe("ClassFieldMember");
        expect(field.annotations?.map((annotation) => annotation.name.name)).toEqual(["Range"]);
        expect(field.annotations?.[0]?.arguments).toHaveLength(2);

        expect(method.kind).toBe("ClassMethodMember");
        expect(method.annotations?.map((annotation) => annotation.name.name)).toEqual(["Deprecated"]);
        expect(method.annotations?.[0]?.arguments).toEqual([]);
    });

    it("stacks multiple annotations on a single class member", () => {
        const statement = parseStatement(
            tokenizeReader(dedent`
                class Test {
                  @Range(0.1, 10.0)
                  @Tooltip("scale factor")
                  var scale: number
                }
            `),
            { language: "vexa" }
        ) as ClassStatement;

        expect(statement.members[0]?.annotations?.map((annotation) => annotation.name.name)).toEqual([
            "Range",
            "Tooltip"
        ]);
    });

    it("parses optional static class method signatures in TypeScript ambient classes", () => {
        expect(
            parseStatement(
                tokenizeReader(dedent`
                    export abstract class Component<P, S> {
                      static getDerivedStateFromProps?(props: Readonly<P>, state: Readonly<S>): Partial<S> | null;
                    }
                `.trim()),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "ExportStatement",
            declaration: {
                kind: "ClassStatement",
                abstract: true,
                name: { kind: "Identifier", name: "Component" },
                typeParameters: [
                    { kind: "TypeParameter", name: { kind: "Identifier", name: "P" } },
                    { kind: "TypeParameter", name: { kind: "Identifier", name: "S" } }
                ],
                members: [
                    {
                        kind: "ClassMethodMember",
                        name: { kind: "Identifier", name: "getDerivedStateFromProps" },
                        static: true,
                        optional: true,
                        missingBody: true,
                        parameters: [
                            {
                                kind: "FunctionParameter",
                                name: { kind: "Identifier", name: "props" },
                                typeAnnotation: { kind: "Identifier", name: "Readonly<P>" }
                            },
                            {
                                kind: "FunctionParameter",
                                name: { kind: "Identifier", name: "state" },
                                typeAnnotation: { kind: "Identifier", name: "Readonly<S>" }
                            }
                        ],
                        returnType: { kind: "Identifier", name: "Partial<S> | null" },
                        body: { kind: "BlockStatement", body: [] }
                    }
                ]
            }
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

    it("parses surplus extends/implements clauses into extra heritage lists", () => {
        expect(
            parseStatement(
                tokenizeReader("class Demo extends A extends B implements I implements J, K {}")
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Demo" },
            extendsType: { kind: "Identifier", name: "A" },
            implementsTypes: [{ kind: "Identifier", name: "I" }],
            extraExtendsTypes: [{ kind: "Identifier", name: "B" }],
            extraImplementsTypes: [
                { kind: "Identifier", name: "J" },
                { kind: "Identifier", name: "K" }
            ],
            members: []
        });
    });

    it("parses vexa class colon syntax: BaseShape, Shape, Comparable<Circle>", () => {
        expect(
            parseStatement(
                tokenizeReader("class Circle : BaseShape, Shape, Comparable<Circle> {}"),
                { language: "vexa" }
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Circle" },
            extendsType: { kind: "Identifier", name: "BaseShape" },
            implementsTypes: [
                { kind: "Identifier", name: "Shape" },
                { kind: "Identifier", name: "Comparable<Circle>" }
            ],
            members: []
        });
    });

    it("parses vexa class colon syntax with single base type", () => {
        expect(
            parseStatement(
                tokenizeReader("class Foo : Bar {}"),
                { language: "vexa" }
            )
        ).toEqual({
            kind: "ClassStatement",
            name: { kind: "Identifier", name: "Foo" },
            extendsType: { kind: "Identifier", name: "Bar" },
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
        expect(parseStatement(tokenizeReader("let maybe: any?"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "any?" }
        });
        expect(parseStatement(tokenizeReader("let callback: (() => void)?"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "(() => void)?" }
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
        expect(parseStatement(tokenizeReader("let path: [EventTarget?]"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "[EventTarget?]" }
        });
        expect(parseStatement(tokenizeReader("let point: { x: int; y?: string }"))).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: "{ x: int, y?: string }" }
        });
    });

    it("parses template-literal and import-member generic type annotations", () => {
        expect(parseStatement(tokenizeReader("type UUID = `${string}-${string}-${string}-${string}-${string}`", { jsx: false }), { language: "typescript" })).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: "`${string}-${string}-${string}-${string}-${string}`" }
        });
        expect(parseStatement(tokenizeReader("type Stream<R = any> = typeof globalThis extends { onmessage: any } ? {} : import(\"stream/web\").ReadableStream<R>", { jsx: false }), { language: "typescript" })).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: 'typeof globalThis extends { onmessage: any } ? {  } : import("stream/web").ReadableStream<R>' }
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
        expect(parseStatement(tokenizeReader('type ArrayOutputType<T, C> = C extends "one" ? [T["_output"], ...T["_output"][]] : T["_output"][]'))).toMatchObject({
            kind: "TypeAliasStatement",
            targetType: { kind: "Identifier", name: 'C extends "one" ? [T["_output"], ...T["_output"][]] : T["_output"][]' }
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
        expect(parseStatement(tokenizeReader('let formatter: typeof import("node:util").format'), { language: "typescript" })).toMatchObject({
            kind: "VarStatement",
            typeAnnotation: { kind: "Identifier", name: 'typeof import("node:util").format' }
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

    it("parses interface index signatures in TypeScript declarations", () => {
        expect(
            parseStatement(
                tokenizeReader("interface ParsedArgs {\n  [arg: string]: any\n  _: string[]\n}"),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "InterfaceStatement",
            name: { kind: "Identifier", name: "ParsedArgs" },
            members: [
                {
                    kind: "InterfacePropertyMember",
                    name: { kind: "Identifier", name: "[string]" },
                    typeAnnotation: { kind: "Identifier", name: "any" }
                },
                {
                    kind: "InterfacePropertyMember",
                    name: { kind: "Identifier", name: "_" },
                    typeAnnotation: { kind: "Identifier", name: "string[]" }
                }
            ]
        });
    });

    it("parses class statement without braces in vexa mode", () => {
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
        ).toThrow("Class primary constructor syntax is only available in VexaScript mode");
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
        const program = parseFile(tokenizeReader(dedent`
            declare type Id = string;
            declare abstract class Service { abstract run(id: Id): void }
            export declare const service: Service;
            export declare function create(id: Id): Service;
        `.trimEnd()), { language: "typescript" });

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

    it("parses declare global augmentations in typescript mode", () => {
        expect(
            parseStatement(tokenizeReader("declare global {\ninterface Iterator<T> {}\ndeclare var Iterator: IteratorConstructor\n}"), { language: "typescript" })
        ).toEqual({
            kind: "NamespaceStatement",
            declared: true,
            globalAugmentation: true,
            declarationKind: "namespace",
            body: {
                kind: "BlockStatement",
                body: [
                    {
                        kind: "InterfaceStatement",
                        declared: true,
                        name: { kind: "Identifier", name: "Iterator" },
                        typeParameters: [{ kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }],
                        members: []
                    },
                    {
                        kind: "VarStatement",
                        declared: true,
                        declarationKind: "var",
                        name: { kind: "Identifier", name: "Iterator" },
                        typeAnnotation: { kind: "Identifier", name: "IteratorConstructor" }
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

    it("parses 'declare function' as a function declaration in vexa mode", () => {
        expect(
            parseStatement(
                tokenizeReader("declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;"),
                { language: "vexa" }
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

    it("parses 'declare fun' as a function declaration in vexa mode", () => {
        expect(
            parseStatement(
                tokenizeReader("declare fun moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;"),
                { language: "vexa" }
            )
        ).toEqual({
            kind: "FunctionStatement",
            declarationKind: "fun",
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
                { language: "vexa" }
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

    it("parses computed interface methods like [Symbol.asyncIterator]()", () => {
        expect(
            parseStatement(
                tokenizeReader("interface Stream<T> { [Symbol.asyncIterator](): AsyncIterator<T> }", { jsx: false }),
                { language: "typescript" }
            )
        ).toEqual({
            kind: "InterfaceStatement",
            name: { kind: "Identifier", name: "Stream" },
            typeParameters: [{ kind: "TypeParameter", name: { kind: "Identifier", name: "T" } }],
            members: [
                {
                    kind: "InterfaceMethodMember",
                    computed: true,
                    computedKey: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "Symbol" },
                        property: { kind: "Identifier", name: "asyncIterator" },
                        computed: false
                    },
                    name: { kind: "Identifier", name: "[Symbol.asyncIterator]" },
                    parameters: [],
                    returnType: { kind: "Identifier", name: "AsyncIterator<T>" }
                }
            ]
        });
    });

    it("parses interface members with explicit property and function declaration keywords", () => {
        expect(
            parseStatement(
                tokenizeReader("interface Repo {\nval size: int\nfun get(id: string): string\n}")
            )
        ).toEqual({
            kind: "InterfaceStatement",
            name: { kind: "Identifier", name: "Repo" },
            members: [
                {
                    kind: "InterfacePropertyMember",
                    declarationKind: "val",
                    name: { kind: "Identifier", name: "size" },
                    typeAnnotation: { kind: "Identifier", name: "int" }
                },
                {
                    kind: "InterfaceMethodMember",
                    declarationKind: "fun",
                    name: { kind: "Identifier", name: "get" },
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "id" },
                            typeAnnotation: { kind: "Identifier", name: "string" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "string" }
                }
            ]
        });
    });

    it("parses 'declare var/let/const/val' declarations", () => {
        expect(parseStatement(tokenizeReader("declare var console: Console"), { language: "vexa" })).toEqual({
            kind: "VarStatement",
            declared: true,
            declarationKind: "var",
            name: { kind: "Identifier", name: "console" },
            typeAnnotation: { kind: "Identifier", name: "Console" }
        });

        expect(parseStatement(tokenizeReader("declare let value = 1"), { language: "vexa" })).toEqual({
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

        expect(parseStatement(tokenizeReader("declare val total: number"), { language: "vexa" })).toEqual({
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

        expect(parseStatement(tokenizeReader("val number.seconds: TimeSpan => TimeSpan(this * 1000)"))).toEqual({
            kind: "VarStatement",
            declarationKind: "val",
            receiverType: { kind: "Identifier", name: "number" },
            name: { kind: "Identifier", name: "seconds" },
            typeAnnotation: { kind: "Identifier", name: "TimeSpan" },
            initializer: {
                kind: "CallExpression",
                callee: { kind: "Identifier", name: "TimeSpan" },
                arguments: [
                    {
                        kind: "BinaryExpression",
                        operator: "*",
                        left: { kind: "Identifier", name: "this" },
                        right: { kind: "IntLiteral", value: 1000 }
                    }
                ]
            }
        });

        expect(parseStatement(tokenizeReader(dedent`
            var View.point: Vec2 {
                get => Vec2(x, y)
                set { x = newValue.x; y = newValue.y }
            }
        `.trim()))).toEqual({
            kind: "VarStatement",
            declarationKind: "var",
            receiverType: { kind: "Identifier", name: "View" },
            name: { kind: "Identifier", name: "point" },
            typeAnnotation: { kind: "Identifier", name: "Vec2" },
            accessors: [
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "point" },
                    accessorKind: "get",
                    parameters: [],
                    returnType: { kind: "Identifier", name: "Vec2" },
                    body: {
                        kind: "BlockStatement",
                        body: [{
                            kind: "ReturnStatement",
                            expression: {
                                kind: "CallExpression",
                                callee: { kind: "Identifier", name: "Vec2" },
                                arguments: [
                                    { kind: "Identifier", name: "x" },
                                    { kind: "Identifier", name: "y" }
                                ]
                            }
                        }]
                    }
                },
                {
                    kind: "ClassMethodMember",
                    name: { kind: "Identifier", name: "point" },
                    accessorKind: "set",
                    parameters: [{
                        kind: "FunctionParameter",
                        name: { kind: "Identifier", name: "newValue" },
                        typeAnnotation: { kind: "Identifier", name: "Vec2" }
                    }],
                    body: {
                        kind: "BlockStatement",
                        body: [
                            {
                                kind: "ExprStatement",
                                expression: {
                                    kind: "AssignmentExpression",
                                    operator: "=",
                                    left: {
                                        kind: "Identifier",
                                        name: "x"
                                    },
                                    right: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "newValue" },
                                        property: { kind: "Identifier", name: "x" },
                                        computed: false
                                    }
                                }
                            },
                            {
                                kind: "ExprStatement",
                                expression: {
                                    kind: "AssignmentExpression",
                                    operator: "=",
                                    left: {
                                        kind: "Identifier",
                                        name: "y"
                                    },
                                    right: {
                                        kind: "MemberExpression",
                                        object: { kind: "Identifier", name: "newValue" },
                                        property: { kind: "Identifier", name: "y" },
                                        computed: false
                                    }
                                }
                            }
                        ]
                    }
                }
            ]
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

        expect(parseStatement(tokenizeReader("export * as widgets from \"./all\""))).toEqual({
            kind: "ExportStatement",
            exportAll: true,
            namespaceExport: { kind: "Identifier", name: "widgets" },
            from: { kind: "StringLiteral", value: "./all" }
        });

        expect(parseStatement(tokenizeReader("export as namespace MyLib"))).toEqual({
            kind: "ExportStatement",
            namespaceExport: { kind: "Identifier", name: "MyLib" }
        });

        expect(parseStatement(tokenizeReader("export async fun load(): Promise<int> { return Promise.resolve(1) }"))).toMatchObject({
            kind: "ExportStatement",
            declaration: {
                kind: "FunctionStatement",
                async: true,
                name: { kind: "Identifier", name: "load" }
            }
        });

        expect(parseStatement(tokenizeReader("export sync fun loadSync(): int { return 1 }"))).toMatchObject({
            kind: "ExportStatement",
            declaration: {
                kind: "FunctionStatement",
                sync: true,
                name: { kind: "Identifier", name: "loadSync" }
            }
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

    it("parses consecutive minified function declarations in TypeScript mode", () => {
        const program = parseFile(
            tokenizeReader("function first(){}function second(){}"),
            { language: "typescript" }
        );

        expect(program.body).toHaveLength(2);
        expect(program.body[0]).toMatchObject({
            kind: "FunctionStatement",
            name: { kind: "Identifier", name: "first" }
        });
        expect(program.body[1]).toMatchObject({
            kind: "FunctionStatement",
            name: { kind: "Identifier", name: "second" }
        });
    });

    it("parses TypeScript function names that use '$' identifiers", () => {
        expect(parseStatement(tokenizeReader("function $() {}"), { language: "typescript" })).toMatchObject({
            kind: "FunctionStatement",
            name: { kind: "Identifier", name: "$" }
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

    it("parses index operator overloads in named import specifiers", () => {
        expect(parseStatement(tokenizeReader("import { operator[], operator[]= } from \"./grid\""))).toMatchObject({
            kind: "ImportStatement",
            specifiers: [
                { kind: "ImportSpecifier", imported: { kind: "Identifier", name: "operator[]" } },
                { kind: "ImportSpecifier", imported: { kind: "Identifier", name: "operator[]=" } }
            ],
            from: { kind: "StringLiteral", value: "./grid" }
        });
    });

    it("parses inline type-only import and export specifiers", () => {
        expect(parseStatement(tokenizeReader("import { type AnalysisType, typeToString } from \"./types\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "AnalysisType" },
                    typeOnly: true
                },
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "typeToString" }
                }
            ],
            from: { kind: "StringLiteral", value: "./types" }
        });

        expect(parseStatement(tokenizeReader("export { type AnalysisType, typeToString } from \"./types\""))).toEqual({
            kind: "ExportStatement",
            specifiers: [
                {
                    kind: "ExportSpecifier",
                    exported: { kind: "Identifier", name: "AnalysisType" },
                    typeOnly: true
                },
                {
                    kind: "ExportSpecifier",
                    exported: { kind: "Identifier", name: "typeToString" }
                }
            ],
            from: { kind: "StringLiteral", value: "./types" }
        });
    });

    it("parses operator overloads in named import specifiers", () => {
        expect(parseStatement(tokenizeReader("import { Point, operator+ } from \"./other\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "Point" }
                },
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "operator+" }
                }
            ],
            from: { kind: "StringLiteral", value: "./other" }
        });

        expect(parseStatement(tokenizeReader("import { operator- } from \"./other\""))).toEqual({
            kind: "ImportStatement",
            specifiers: [
                {
                    kind: "ImportSpecifier",
                    imported: { kind: "Identifier", name: "operator-" }
                }
            ],
            from: { kind: "StringLiteral", value: "./other" }
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
