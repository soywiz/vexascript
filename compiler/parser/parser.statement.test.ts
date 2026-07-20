import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { Parser, parseExpression, parseFile, parseStatement } from "./parser";
import { tokenizeReader } from "./tokenizer";
import type { ClassStatement } from "compiler/ast/ast";

describe("parseStatement", () => {
    it("parses debugger and empty statements", () => {
        expect(parseStatement(tokenizeReader("debugger"))).toEqual({ kind: NodeKind.DebuggerStatement });
        expect(parseStatement(tokenizeReader(";"))).toEqual({ kind: NodeKind.EmptyStatement });
        expect(parseStatement(tokenizeReader("while (ready);"))).toEqual({
            kind: NodeKind.WhileStatement,
            condition: { kind: NodeKind.Identifier, name: "ready" },
            body: { kind: NodeKind.EmptyStatement }
        });
    });

    it("parses a let statement", () => {
        expect(parseStatement(tokenizeReader("let myvar = 1 + 2"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "myvar" },
            initializer: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.IntLiteral, value: 1 },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("parses a let statement with optional type and initializer", () => {
        expect(parseStatement(tokenizeReader("let name: Type = value"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "name" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "Type" },
            initializer: { kind: NodeKind.Identifier, name: "value" }
        });
    });

    it("parses a let statement with optional type and no initializer", () => {
        expect(parseStatement(tokenizeReader("let name: Type"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "name" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "Type" }
        });
    });

    it("parses a let statement with no type and no initializer", () => {
        expect(parseStatement(tokenizeReader("let name"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "name" }
        });
    });

    it("parses var/val/const declarations and stores declaration kind", () => {
        expect(parseStatement(tokenizeReader("var x = 1"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "var",
            name: { kind: NodeKind.Identifier, name: "x" },
            initializer: { kind: NodeKind.IntLiteral, value: 1 }
        });
        expect(parseStatement(tokenizeReader("val y: Num"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "val",
            name: { kind: NodeKind.Identifier, name: "y" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "Num" }
        });
        expect(parseStatement(tokenizeReader("const z"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "const",
            name: { kind: NodeKind.Identifier, name: "z" }
        });
    });

    it("parses multiple variable declarations separated by commas", () => {
        expect(parseStatement(tokenizeReader("val a = 10 * 2, lol = true"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "val",
            name: { kind: NodeKind.Identifier, name: "a" },
            initializer: {
                kind: NodeKind.BinaryExpression,
                operator: "*",
                left: { kind: NodeKind.IntLiteral, value: 10 },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            },
            declarations: [
                {
                    kind: NodeKind.VarDeclarator,
                    name: { kind: NodeKind.Identifier, name: "a" },
                    initializer: {
                        kind: NodeKind.BinaryExpression,
                        operator: "*",
                        left: { kind: NodeKind.IntLiteral, value: 10 },
                        right: { kind: NodeKind.IntLiteral, value: 2 }
                    }
                },
                {
                    kind: NodeKind.VarDeclarator,
                    name: { kind: NodeKind.Identifier, name: "lol" },
                    initializer: { kind: NodeKind.BooleanLiteral, value: true }
                }
            ]
        });
    });

    it("parses a block statement with nested statements", () => {
        expect(parseStatement(tokenizeReader("{ let a = 1; { let b = a + 2 }\nlet c = 3 }"))).toEqual({
            kind: NodeKind.BlockStatement,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "a" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                },
                {
                    kind: NodeKind.BlockStatement,
                    body: [
                        {
                            kind: NodeKind.VarStatement,
                            declarationKind: "let",
                            name: { kind: NodeKind.Identifier, name: "b" },
                            initializer: {
                                kind: NodeKind.BinaryExpression,
                                operator: "+",
                                left: { kind: NodeKind.Identifier, name: "a" },
                                right: { kind: NodeKind.IntLiteral, value: 2 }
                            }
                        }
                    ]
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "c" },
                    initializer: { kind: NodeKind.IntLiteral, value: 3 }
                }
            ]
        });
    });

    it("parses a while statement with single-statement body", () => {
        expect(parseStatement(tokenizeReader("while (a + 1) let b = 2"))).toEqual({
            kind: NodeKind.WhileStatement,
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            body: {
                kind: NodeKind.VarStatement,
                declarationKind: "let",
                name: { kind: NodeKind.Identifier, name: "b" },
                initializer: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("parses a do-while statement with single-statement body", () => {
        expect(parseStatement(tokenizeReader("do let x = 1 while (x + 1)"))).toEqual({
            kind: NodeKind.DoWhileStatement,
            body: {
                kind: NodeKind.VarStatement,
                declarationKind: "let",
                name: { kind: NodeKind.Identifier, name: "x" },
                initializer: { kind: NodeKind.IntLiteral, value: 1 }
            },
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.Identifier, name: "x" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            }
        });
    });

    it("parses an if statement with single-statement branch", () => {
        expect(parseStatement(tokenizeReader("if (a < 1) let b = 2"))).toEqual({
            kind: NodeKind.IfStatement,
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "<",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            thenBranch: {
                kind: NodeKind.VarStatement,
                declarationKind: "let",
                name: { kind: NodeKind.Identifier, name: "b" },
                initializer: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("parses an if-else statement", () => {
        expect(parseStatement(tokenizeReader("if (a) return b else return c"))).toEqual({
            kind: NodeKind.IfStatement,
            condition: { kind: NodeKind.Identifier, name: "a" },
            thenBranch: {
                kind: NodeKind.ReturnStatement,
                expression: { kind: NodeKind.Identifier, name: "b" }
            },
            elseBranch: {
                kind: NodeKind.ReturnStatement,
                expression: { kind: NodeKind.Identifier, name: "c" }
            }
        });
    });

    it("parses a for statement with declaration initializer", () => {
        expect(parseStatement(tokenizeReader("for (let i = 0; i < 10; i += 1) let value = i"))).toEqual({
            kind: NodeKind.ForStatement,
            initializer: {
                kind: NodeKind.VarStatement,
                declarationKind: "let",
                name: { kind: NodeKind.Identifier, name: "i" },
                initializer: { kind: NodeKind.IntLiteral, value: 0 }
            },
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "<",
                left: { kind: NodeKind.Identifier, name: "i" },
                right: { kind: NodeKind.IntLiteral, value: 10 }
            },
            update: {
                kind: NodeKind.AssignmentExpression,
                operator: "+=",
                left: { kind: NodeKind.Identifier, name: "i" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            body: {
                kind: NodeKind.VarStatement,
                declarationKind: "let",
                name: { kind: NodeKind.Identifier, name: "value" },
                initializer: { kind: NodeKind.Identifier, name: "i" }
            }
        });
    });

    it("parses for statement clauses as optional", () => {
        expect(parseStatement(tokenizeReader("for (;; ) break"))).toEqual({
            kind: NodeKind.ForStatement,
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("supports val declaration in for initializer in vexa mode", () => {
        expect(parseStatement(tokenizeReader("for (val i = 0; i < 1; i += 1) break"), { language: "vexa" })).toEqual({
            kind: NodeKind.ForStatement,
            initializer: {
                kind: NodeKind.VarStatement,
                declarationKind: "val",
                name: { kind: NodeKind.Identifier, name: "i" },
                initializer: { kind: NodeKind.IntLiteral, value: 0 }
            },
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "<",
                left: { kind: NodeKind.Identifier, name: "i" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            update: {
                kind: NodeKind.AssignmentExpression,
                operator: "+=",
                left: { kind: NodeKind.Identifier, name: "i" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("treats 'val' as identifier in for initializer in typescript mode", () => {
        expect(parseStatement(tokenizeReader("for (val = 0; val < 1; val += 1) break"), { language: "typescript" })).toEqual({
            kind: NodeKind.ForStatement,
            initializer: {
                kind: NodeKind.AssignmentExpression,
                operator: "=",
                left: { kind: NodeKind.Identifier, name: "val" },
                right: { kind: NodeKind.IntLiteral, value: 0 }
            },
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "<",
                left: { kind: NodeKind.Identifier, name: "val" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            update: {
                kind: NodeKind.AssignmentExpression,
                operator: "+=",
                left: { kind: NodeKind.Identifier, name: "val" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("parses TypeScript for-of with declaration iterator", () => {
        expect(parseStatement(tokenizeReader("for (const value of iterable) break"), { language: "typescript" })).toEqual({
            kind: NodeKind.ForStatement,
            iterationKind: "of",
            iterator: {
                kind: NodeKind.VarStatement,
                declarationKind: "const",
                name: { kind: NodeKind.Identifier, name: "value" }
            },
            iterable: { kind: NodeKind.Identifier, name: "iterable" },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("parses TypeScript for-in with declaration iterator", () => {
        expect(parseStatement(tokenizeReader("for (let value in iterable) break"), { language: "typescript" })).toEqual({
            kind: NodeKind.ForStatement,
            iterationKind: "in",
            iterator: {
                kind: NodeKind.VarStatement,
                declarationKind: "let",
                name: { kind: NodeKind.Identifier, name: "value" }
            },
            iterable: { kind: NodeKind.Identifier, name: "iterable" },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("parses TypeScript for-in without a declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value in iterable) break"), { language: "typescript" })).toEqual({
            kind: NodeKind.ForStatement,
            iterationKind: "in",
            iterator: { kind: NodeKind.Identifier, name: "value" },
            iterable: { kind: NodeKind.Identifier, name: "iterable" },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("parses VexaScript for-in without declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value in iterable) break"), { language: "vexa" })).toEqual({
            kind: NodeKind.ForStatement,
            iterationKind: "in",
            iterator: { kind: NodeKind.Identifier, name: "value" },
            iterable: { kind: NodeKind.Identifier, name: "iterable" },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("parses VexaScript for-of without declaration keyword", () => {
        expect(parseStatement(tokenizeReader("for (value of 0 ... 10) break"), { language: "vexa" })).toEqual({
            kind: NodeKind.ForStatement,
            iterationKind: "of",
            iterator: { kind: NodeKind.Identifier, name: "value" },
            iterable: {
                kind: NodeKind.RangeExpression,
                start: { kind: NodeKind.IntLiteral, value: 0 },
                end: { kind: NodeKind.IntLiteral, value: 10 },
                exclusive: false
            },
            body: {
                kind: NodeKind.BreakStatement
            }
        });
    });

    it("parses a switch statement with case and default", () => {
        expect(parseStatement(tokenizeReader("switch (value) { case 1: return 1; default: return 0 }"))).toEqual({
            kind: NodeKind.SwitchStatement,
            discriminant: { kind: NodeKind.Identifier, name: "value" },
            cases: [
                {
                    kind: NodeKind.SwitchCase,
                    test: { kind: NodeKind.IntLiteral, value: 1 },
                    consequent: [
                        {
                            kind: NodeKind.ReturnStatement,
                            expression: { kind: NodeKind.IntLiteral, value: 1 }
                        }
                    ]
                },
                {
                    kind: NodeKind.SwitchCase,
                    consequent: [
                        {
                            kind: NodeKind.ReturnStatement,
                            expression: { kind: NodeKind.IntLiteral, value: 0 }
                        }
                    ]
                }
            ]
        });
    });

    it("parses switch default-only in typescript mode", () => {
        expect(parseStatement(tokenizeReader("switch (value) { default: break }"), { language: "typescript" })).toEqual({
            kind: NodeKind.SwitchStatement,
            discriminant: { kind: NodeKind.Identifier, name: "value" },
            cases: [
                {
                    kind: NodeKind.SwitchCase,
                    consequent: [
                        {
                            kind: NodeKind.BreakStatement
                        }
                    ]
                }
            ]
        });
    });

    it("parses an expression statement", () => {
        expect(parseStatement(tokenizeReader("a + 1"))).toEqual({
            kind: NodeKind.ExprStatement,
            expression: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            }
        });
        expect(parseStatement(tokenizeReader("a++"))).toEqual({
            kind: NodeKind.ExprStatement,
            expression: {
                kind: NodeKind.UpdateExpression,
                operator: "++",
                argument: { kind: NodeKind.Identifier, name: "a" },
                prefix: false
            }
        });
    });

    it("parses a function statement with optional parameter and return types (fun)", () => {
        expect(parseStatement(tokenizeReader("fun demo(a, b, c: optType): optType { return a + b }"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            name: { kind: NodeKind.Identifier, name: "demo" },
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "a" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "b" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "c" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "optType" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "optType" },
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: {
                            kind: NodeKind.BinaryExpression,
                            operator: "+",
                            left: { kind: NodeKind.Identifier, name: "a" },
                            right: { kind: NodeKind.Identifier, name: "b" }
                        }
                    }
                ]
            }
        });
    });

    it("parses an extension operator function statement", () => {
        expect(parseStatement(tokenizeReader("fun Point.operator+(other: Point): Point { return other }"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            receiverType: { kind: NodeKind.Identifier, name: "Point" },
            name: { kind: NodeKind.Identifier, name: "operator+" },
            operator: "+",
            parameters: [
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "other" }, typeAnnotation: { kind: NodeKind.Identifier, name: "Point" } }
            ],
            returnType: { kind: NodeKind.Identifier, name: "Point" },
            body: { kind: NodeKind.BlockStatement, body: [{ kind: NodeKind.ReturnStatement, expression: { kind: NodeKind.Identifier, name: "other" } }] }
        });
    });

    it("parses extension index operator function statements", () => {
        expect(parseStatement(tokenizeReader("fun Bag.operator[](index: int): string { return \"item\" }"))).toMatchObject({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            receiverType: { kind: NodeKind.Identifier, name: "Bag" },
            name: { kind: NodeKind.Identifier, name: "operator[]" },
            operator: "[]",
            parameters: [
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "index" }, typeAnnotation: { kind: NodeKind.Identifier, name: "int" } }
            ],
            returnType: { kind: NodeKind.Identifier, name: "string" }
        });
        expect(parseStatement(tokenizeReader("fun Bag.operator[]=(value: string, index: int): void { }"))).toMatchObject({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            receiverType: { kind: NodeKind.Identifier, name: "Bag" },
            name: { kind: NodeKind.Identifier, name: "operator[]=" },
            operator: "[]=",
            parameters: [
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "value" }, typeAnnotation: { kind: NodeKind.Identifier, name: "string" } },
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "index" }, typeAnnotation: { kind: NodeKind.Identifier, name: "int" } }
            ],
            returnType: { kind: NodeKind.Identifier, name: "void" }
        });
    });

    it("parses a generic extension method on a generic receiver", () => {
        expect(parseStatement(tokenizeReader("fun <T> Array<T>.demo(): int { return length }"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            name: { kind: NodeKind.Identifier, name: "demo" },
            receiverType: { kind: NodeKind.Identifier, name: "Array" },
            receiverTypeArguments: [{ kind: NodeKind.Identifier, name: "T" }],
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }
            ],
            parameters: [],
            returnType: { kind: NodeKind.Identifier, name: "int" },
            body: {
                kind: NodeKind.BlockStatement,
                body: [{ kind: NodeKind.ReturnStatement, expression: { kind: NodeKind.Identifier, name: "length" } }]
            }
        });
    });

    it("parses receiver function type parameters with the VexaScript arrow", () => {
        expect(parseStatement(tokenizeReader(
            "fun <T> T.apply(block: T.() -> void): T { block(this); return this }"
        ))).toMatchObject({
            kind: NodeKind.FunctionStatement,
            receiverType: { kind: NodeKind.Identifier, name: "T" },
            name: { kind: NodeKind.Identifier, name: "apply" },
            parameters: [{
                kind: NodeKind.FunctionParameter,
                name: { kind: NodeKind.Identifier, name: "block" },
                typeAnnotation: { kind: NodeKind.Identifier, name: "T.() => void" }
            }],
            returnType: { kind: NodeKind.Identifier, name: "T" }
        });
    });

    it("parses a generic extension property on a generic receiver", () => {
        expect(parseStatement(tokenizeReader("val <T> Array<T>.doubledLength => length * 2"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "val",
            receiverType: { kind: NodeKind.Identifier, name: "Array" },
            receiverTypeArguments: [{ kind: NodeKind.Identifier, name: "T" }],
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }
            ],
            name: { kind: NodeKind.Identifier, name: "doubledLength" },
            initializer: {
                kind: NodeKind.BinaryExpression,
                operator: "*",
                left: { kind: NodeKind.Identifier, name: "length" },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("parses a generic function statement", () => {
        expect(parseStatement(tokenizeReader("fun identity<T>(value: T): T { return value }"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            name: { kind: NodeKind.Identifier, name: "identity" },
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }
            ],
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "value" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "T" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "T" },
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.Identifier, name: "value" }
                    }
                ]
            }
        });
    });

    it("parses a function statement using function keyword", () => {
        expect(parseStatement(tokenizeReader("function demo(a, b, c: optType): optType { return c }"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "function",
            name: { kind: NodeKind.Identifier, name: "demo" },
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "a" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "b" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "c" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "optType" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "optType" },
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.Identifier, name: "c" }
                    }
                ]
            }
        });
    });

    it("parses function parameters with optional marker and default value", () => {
        expect(parseStatement(tokenizeReader("fun test(a, v, c?, d: Int = demo) { return d }"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            name: { kind: NodeKind.Identifier, name: "test" },
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "a" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "v" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "c" },
                    optional: true
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "d" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "Int" },
                    defaultValue: { kind: NodeKind.Identifier, name: "demo" }
                }
            ],
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.Identifier, name: "d" }
                    }
                ]
            }
        });
    });

    it("parses function shorthand bodies with =>", () => {
        expect(parseStatement(tokenizeReader("fun demo(value: int): int => value + 1"))).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            name: { kind: NodeKind.Identifier, name: "demo" },
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "value" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "int" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "int" },
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: {
                            kind: NodeKind.BinaryExpression,
                            operator: "+",
                            left: { kind: NodeKind.Identifier, name: "value" },
                            right: { kind: NodeKind.IntLiteral, value: 1 }
                        }
                    }
                ]
            }
        });
    });

    it("parses return/throw/continue/break statements", () => {
        expect(parseStatement(tokenizeReader("return value"))).toEqual({
            kind: NodeKind.ReturnStatement,
            expression: { kind: NodeKind.Identifier, name: "value" }
        });
        expect(parseStatement(tokenizeReader("return"))).toEqual({
            kind: NodeKind.ReturnStatement
        });
        expect(parseStatement(tokenizeReader("throw value"))).toEqual({
            kind: NodeKind.ThrowStatement,
            expression: { kind: NodeKind.Identifier, name: "value" }
        });
        expect(parseStatement(tokenizeReader("continue"))).toEqual({
            kind: NodeKind.ContinueStatement
        });
        expect(parseStatement(tokenizeReader("break"))).toEqual({
            kind: NodeKind.BreakStatement
        });
    });

    it("parses try/catch/finally statements", () => {
        expect(parseStatement(tokenizeReader("try { return a } catch (e) { throw e } finally { return b }"))).toEqual({
            kind: NodeKind.TryStatement,
            tryBlock: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.Identifier, name: "a" }
                    }
                ]
            },
            catchClause: {
                kind: NodeKind.CatchClause,
                parameter: { kind: NodeKind.Identifier, name: "e" },
                body: {
                    kind: NodeKind.BlockStatement,
                    body: [
                        {
                            kind: NodeKind.ThrowStatement,
                            expression: { kind: NodeKind.Identifier, name: "e" }
                        }
                    ]
                }
            },
            finallyBlock: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.Identifier, name: "b" }
                    }
                ]
            }
        });
    });

    it("parses try/finally and catch without parameter", () => {
        expect(parseStatement(tokenizeReader("try { return 1 } finally { return 2 }"))).toEqual({
            kind: NodeKind.TryStatement,
            tryBlock: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.IntLiteral, value: 1 }
                    }
                ]
            },
            finallyBlock: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.IntLiteral, value: 2 }
                    }
                ]
            }
        });

        expect(parseStatement(tokenizeReader("try { return 1 } catch { return 2 }"))).toEqual({
            kind: NodeKind.TryStatement,
            tryBlock: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.IntLiteral, value: 1 }
                    }
                ]
            },
            catchClause: {
                kind: NodeKind.CatchClause,
                body: {
                    kind: NodeKind.BlockStatement,
                    body: [
                        {
                            kind: NodeKind.ReturnStatement,
                            expression: { kind: NodeKind.IntLiteral, value: 2 }
                        }
                    ]
                }
            }
        });
    });

    it("parses defer statements", () => {
        expect(parseStatement(tokenizeReader("defer file.close()"))).toEqual({
            kind: NodeKind.DeferStatement,
            expression: {
                kind: NodeKind.CallExpression,
                callee: {
                    kind: NodeKind.MemberExpression,
                    object: { kind: NodeKind.Identifier, name: "file" },
                    computed: false,
                    property: { kind: NodeKind.Identifier, name: "close" },
                },
                args: []
            }
        });
    });

    it("parses class statement with field, constructor, and method", () => {
        expect(
            parseStatement(
                tokenizeReader("class Demo {\na = 10\n\nconstructor() {\n}\n\ndemo() {\n}\n}")
            )
        ).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Demo" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    name: { kind: NodeKind.Identifier, name: "a" },
                    initializer: { kind: NodeKind.IntLiteral, value: 10 }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "constructor" },
                    parameters: [],
                    body: { kind: NodeKind.BlockStatement, body: [] }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "demo" },
                    parameters: [],
                    body: { kind: NodeKind.BlockStatement, body: [] }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Stream" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    async: true,
                    generator: true,
                    computed: true,
                    computedKey: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "Symbol" },
                        property: { kind: NodeKind.Identifier, name: "asyncIterator" },
                        computed: false
                    },
                    name: { kind: NodeKind.Identifier, name: "[Symbol.asyncIterator]" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "AsyncGenerator<int>" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ExprStatement,
                                expression: {
                                    kind: NodeKind.UnaryExpression,
                                    operator: "yield",
                                    argument: { kind: NodeKind.IntLiteral, value: 1 }
                                }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("parses optional type suffixes on class method return types before bodies", () => {
        expect(parseStatement(tokenizeReader("class ViewNode {\nfun findNodeByName(name: string): ViewNode? { return undefined }\n}"))).toMatchObject({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "ViewNode" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "findNodeByName" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "name" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "ViewNode?" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Demo" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    declarationKind: "val",
                    isReadonly: true,
                    name: { kind: NodeKind.Identifier, name: "id" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                },
                {
                    kind: NodeKind.ClassFieldMember,
                    declarationKind: "var",
                    name: { kind: NodeKind.Identifier, name: "count" },
                    initializer: { kind: NodeKind.IntLiteral, value: 0 }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    declarationKind: "fun",
                    async: true,
                    name: { kind: NodeKind.Identifier, name: "save" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "void" },
                    body: { kind: NodeKind.BlockStatement, body: [] }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    declarationKind: "fun",
                    name: { kind: NodeKind.Identifier, name: "operator+" },
                    operator: "+",
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "other" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "Demo" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "Demo" },
                    body: { kind: NodeKind.BlockStatement, body: [] }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "operator*" },
                    operator: "*",
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "other" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "Point" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "Point" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: {
                                    kind: NodeKind.CallExpression,
                                    callee: { kind: NodeKind.Identifier, name: "Point" },
                                    args: [
                                        {
                                            kind: NodeKind.BinaryExpression,
                                            operator: "*",
                                            left: { kind: NodeKind.Identifier, name: "x" },
                                            right: {
                                                kind: NodeKind.MemberExpression,
                                                object: { kind: NodeKind.Identifier, name: "other" },
                                                property: { kind: NodeKind.Identifier, name: "x" },
                                                computed: false
                                            }
                                        },
                                        {
                                            kind: NodeKind.BinaryExpression,
                                            operator: "*",
                                            left: { kind: NodeKind.Identifier, name: "y" },
                                            right: {
                                                kind: NodeKind.MemberExpression,
                                                object: { kind: NodeKind.Identifier, name: "other" },
                                                property: { kind: NodeKind.Identifier, name: "y" },
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Bag" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "operator[]" },
                    operator: "[]",
                    parameters: [
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "x" }, typeAnnotation: { kind: NodeKind.Identifier, name: "int" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "y" }, typeAnnotation: { kind: NodeKind.Identifier, name: "int" } }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "string" }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "operator[]=" },
                    operator: "[]=",
                    parameters: [
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "value" }, typeAnnotation: { kind: NodeKind.Identifier, name: "string" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "x" }, typeAnnotation: { kind: NodeKind.Identifier, name: "int" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "y" }, typeAnnotation: { kind: NodeKind.Identifier, name: "int" } }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "void" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Box" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "get",
                    name: { kind: NodeKind.Identifier, name: "value" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "string" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: {
                                    kind: NodeKind.MemberExpression,
                                    object: { kind: NodeKind.Identifier, name: "this" },
                                    property: { kind: NodeKind.Identifier, name: "raw" },
                                    computed: false
                                }
                            }
                        ]
                    }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "set",
                    name: { kind: NodeKind.Identifier, name: "value" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "next" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                        }
                    ],
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ExprStatement,
                                expression: {
                                    kind: NodeKind.AssignmentExpression,
                                    operator: "=",
                                    left: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "this" },
                                        property: { kind: NodeKind.Identifier, name: "raw" },
                                        computed: false
                                    },
                                    right: { kind: NodeKind.Identifier, name: "next" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Rect" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "get",
                    name: { kind: NodeKind.Identifier, name: "area" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "number" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: {
                                    kind: NodeKind.BinaryExpression,
                                    operator: "*",
                                    left: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "this" },
                                        property: { kind: NodeKind.Identifier, name: "width" },
                                        computed: false
                                    },
                                    right: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "this" },
                                        property: { kind: NodeKind.Identifier, name: "height" },
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "get",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "int" }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "set",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "newValue" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "int" }
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
            kind: NodeKind.ClassStatement,
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "get",
                    name: { kind: NodeKind.Identifier, name: "x" }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "set",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    parameters: [{ kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "value" } }]
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
            kind: NodeKind.ClassStatement,
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "get",
                    name: { kind: NodeKind.Identifier, name: "x" }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "set",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "value" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "int" }
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
            kind: NodeKind.ClassStatement,
            members: [
                { kind: NodeKind.ClassMethodMember, accessorKind: "get", name: { kind: NodeKind.Identifier, name: "x" } },
                { kind: NodeKind.ClassMethodMember, accessorKind: "set", name: { kind: NodeKind.Identifier, name: "x" } }
            ]
        });
    });

    it("parses class delegates in colon interface clauses", () => {
        expect(
            parseStatement(tokenizeReader("class MyDemo(val shape: Shape) : Shape by { shape } {}"))
        ).toMatchObject({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "MyDemo" },
            extendsType: { kind: NodeKind.Identifier, name: "Shape" },
            classDelegates: [
                {
                    kind: NodeKind.ClassDelegate,
                    typeAnnotation: { kind: NodeKind.Identifier, name: "Shape" },
                    expression: {
                        kind: NodeKind.ObjectLiteral,
                        properties: [
                            {
                                kind: NodeKind.ObjectProperty,
                                key: { kind: NodeKind.Identifier, name: "shape" },
                                value: { kind: NodeKind.Identifier, name: "shape" },
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Rectangle" },
            implementsTypes: [{ kind: NodeKind.Identifier, name: "Shape" }],
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    accessorKind: "get",
                    name: { kind: NodeKind.Identifier, name: "area" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "number" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: {
                                    kind: NodeKind.BinaryExpression,
                                    operator: "*",
                                    left: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "this" },
                                        property: { kind: NodeKind.Identifier, name: "width" },
                                        computed: false
                                    },
                                    right: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "this" },
                                        property: { kind: NodeKind.Identifier, name: "height" },
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Child" },
            extendsType: { kind: NodeKind.Identifier, name: "Base" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    override: true,
                    name: { kind: NodeKind.Identifier, name: "value" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    override: true,
                    name: { kind: NodeKind.Identifier, name: "getValue" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "a" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "int" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "string" },
                    body: { kind: NodeKind.BlockStatement, body: [] }
                }
            ]
        });
    });


    it("parses definite assignment assertions on class fields", () => {
        expect(parseStatement(tokenizeReader("class User { id!: string }"))).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "User" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    name: { kind: NodeKind.Identifier, name: "id" },
                    definiteAssignment: true,
                    typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                }
            ]
        });
    });

    it("parses type-only declare class fields", () => {
        expect(parseStatement(
            tokenizeReader("class Identifier { declare kind: \"Identifier\" }"),
            { language: "typescript" }
        )).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Identifier" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    declared: true,
                    name: { kind: NodeKind.Identifier, name: "kind" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: '\"Identifier\"' }
                }
            ]
        });
    });

    it("keeps operator usable as a TypeScript class field name", () => {
        expect(parseStatement(
            tokenizeReader("class Operation { operator: string }"),
            { language: "typescript" }
        )).toMatchObject({
            kind: NodeKind.ClassStatement,
            members: [{
                kind: NodeKind.ClassFieldMember,
                name: { kind: NodeKind.Identifier, name: "operator" },
                typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
            }]
        });
    });

    it("parses private class fields and methods that reference them", () => {
        expect(
            parseStatement(
                tokenizeReader("class Counter { #value = 1\nread(): int { return this.#value } }"),
                { language: "typescript" }
            )
        ).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Counter" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    name: { kind: NodeKind.Identifier, name: "#value" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "read" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "int" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: {
                                    kind: NodeKind.MemberExpression,
                                    object: { kind: NodeKind.Identifier, name: "this" },
                                    property: { kind: NodeKind.Identifier, name: "#value" },
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
            kind: NodeKind.ClassStatement,
            abstract: true,
            name: { kind: NodeKind.Identifier, name: "Demo" },
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    accessModifier: "public",
                    isReadonly: true,
                    optional: true,
                    name: { kind: NodeKind.Identifier, name: "id" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                },
                {
                    kind: NodeKind.ClassFieldMember,
                    accessModifier: "private",
                    isStatic: true,
                    name: { kind: NodeKind.Identifier, name: "count" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "int" },
                    initializer: { kind: NodeKind.IntLiteral, value: 0 }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    accessModifier: "protected",
                    abstract: true,
                    name: { kind: NodeKind.Identifier, name: "run" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "void" },
                    body: { kind: NodeKind.BlockStatement, body: [] }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "User" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "constructor" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            accessModifier: "public",
                            isReadonly: true,
                            name: { kind: NodeKind.Identifier, name: "id" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            accessModifier: "private",
                            name: { kind: NodeKind.Identifier, name: "age" },
                            defaultValue: { kind: NodeKind.IntLiteral, value: 0 }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            accessModifier: "protected",
                            optional: true,
                            name: { kind: NodeKind.Identifier, name: "nickname" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                        }
                    ],
                    body: { kind: NodeKind.BlockStatement, body: [] }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Demo" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "say" },
                    missingBody: true,
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "number" },
                    body: { kind: NodeKind.BlockStatement, body: [] }
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
        expect(field.kind).toBe(NodeKind.ClassFieldMember);
        expect(field.annotations?.map((annotation) => annotation.name.name)).toEqual(["Range"]);
        expect(field.annotations?.[0]?.args).toHaveLength(2);

        expect(method.kind).toBe(NodeKind.ClassMethodMember);
        expect(method.annotations?.map((annotation) => annotation.name.name)).toEqual(["Deprecated"]);
        expect(method.annotations?.[0]?.args).toEqual([]);
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
            kind: NodeKind.ExportStatement,
            declaration: {
                kind: NodeKind.ClassStatement,
                abstract: true,
                name: { kind: NodeKind.Identifier, name: "Component" },
                typeParameters: [
                    { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "P" } },
                    { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "S" } }
                ],
                members: [
                    {
                        kind: NodeKind.ClassMethodMember,
                        name: { kind: NodeKind.Identifier, name: "getDerivedStateFromProps" },
                        isStatic: true,
                        optional: true,
                        missingBody: true,
                        parameters: [
                            {
                                kind: NodeKind.FunctionParameter,
                                name: { kind: NodeKind.Identifier, name: "props" },
                                typeAnnotation: { kind: NodeKind.Identifier, name: "Readonly<P>" }
                            },
                            {
                                kind: NodeKind.FunctionParameter,
                                name: { kind: NodeKind.Identifier, name: "state" },
                                typeAnnotation: { kind: NodeKind.Identifier, name: "Readonly<S>" }
                            }
                        ],
                        returnType: { kind: NodeKind.Identifier, name: "Partial<S> | null" },
                        body: { kind: NodeKind.BlockStatement, body: [] }
                    }
                ]
            }
        });
    });

    it("parses class statement with primary constructor parameters", () => {
        expect(parseStatement(tokenizeReader("class Point(val x: number, val y: number) {\n}"))).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            primaryConstructorParameters: [
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                },
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "y" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                }
            ],
            members: []
        });
    });

    it("parses class primary constructor parameter defaults with call expressions", () => {
        expect(parseStatement(tokenizeReader(dedent`
            class ViewNode(
              var position: Vector3 = Vector3(0, 0, 0),
              var rotation2: Vector3 = Vector3(0, 0, 0),
              var scale: Vector3 = Vector3(1, 1, 1),
            )
        `))).toMatchObject({
            kind: NodeKind.ClassStatement,
            name: { name: "ViewNode" },
            primaryConstructorParameters: [
                {
                    declarationKind: "var",
                    name: { name: "position" },
                    typeAnnotation: { name: "Vector3" },
                    defaultValue: {
                        kind: NodeKind.CallExpression,
                        callee: { kind: NodeKind.Identifier, name: "Vector3" }
                    }
                },
                {
                    declarationKind: "var",
                    name: { name: "rotation2" },
                    typeAnnotation: { name: "Vector3" },
                    defaultValue: {
                        kind: NodeKind.CallExpression,
                        callee: { kind: NodeKind.Identifier, name: "Vector3" }
                    }
                },
                {
                    declarationKind: "var",
                    name: { name: "scale" },
                    typeAnnotation: { name: "Vector3" },
                    defaultValue: {
                        kind: NodeKind.CallExpression,
                        callee: { kind: NodeKind.Identifier, name: "Vector3" }
                    }
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
            kind: NodeKind.ClassStatement,
            typeParameters: [
                {
                    kind: NodeKind.TypeParameter,
                    name: { kind: NodeKind.Identifier, name: "T" },
                    constraint: { kind: NodeKind.Identifier, name: "Entity" }
                },
                {
                    kind: NodeKind.TypeParameter,
                    name: { kind: NodeKind.Identifier, name: "K" },
                    constraint: { kind: NodeKind.Identifier, name: "string" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Map" },
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "K" } },
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "V" } }
            ],
            extendsType: { kind: NodeKind.Identifier, name: "BaseMap<K, V>" },
            implementsTypes: [
                { kind: NodeKind.Identifier, name: "Iterable<K>" },
                { kind: NodeKind.Identifier, name: "Serializable" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Demo" },
            extendsType: { kind: NodeKind.Identifier, name: "A" },
            implementsTypes: [{ kind: NodeKind.Identifier, name: "I" }],
            extraExtendsTypes: [{ kind: NodeKind.Identifier, name: "B" }],
            extraImplementsTypes: [
                { kind: NodeKind.Identifier, name: "J" },
                { kind: NodeKind.Identifier, name: "K" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Circle" },
            extendsType: { kind: NodeKind.Identifier, name: "BaseShape" },
            implementsTypes: [
                { kind: NodeKind.Identifier, name: "Shape" },
                { kind: NodeKind.Identifier, name: "Comparable<Circle>" }
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
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Foo" },
            extendsType: { kind: NodeKind.Identifier, name: "Bar" },
            members: []
        });
    });

    it("parses generic class methods with function-type parameter annotations", () => {
        expect(
            parseStatement(
                tokenizeReader("class Array<T> { map<R>(mapper: (item: T) => T): Array<R> {} }")
            )
        ).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Array" },
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }
            ],
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "map" },
                    typeParameters: [
                        { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "R" } }
                    ],
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "mapper" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "(item:T) => T" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "Array<R>" },
                    body: { kind: NodeKind.BlockStatement, body: [] }
                }
            ]
        });
    });

    it("parses nested generic type annotations without treating closing angles as shifts", () => {
        expect(parseStatement(tokenizeReader("let points: Array<Map<string, Point>>"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "Array<Map<string, Point>>" }
        });

        expect(parseStatement(tokenizeReader("let matrix: Array<Array<Map<string, Point>>>"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "Array<Array<Map<string, Point>>>" }
        });

        expect(parseStatement(tokenizeReader("function collect<T extends Array<Map<string, Point>>>(items: T): Array<Array<Map<string, Point>>> { return items }"))).toMatchObject({
            kind: NodeKind.FunctionStatement,
            typeParameters: [
                {
                    kind: NodeKind.TypeParameter,
                    name: { kind: NodeKind.Identifier, name: "T" },
                    constraint: { kind: NodeKind.Identifier, name: "Array<Map<string, Point>>" }
                }
            ],
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "items" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "T" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "Array<Array<Map<string, Point>>>" }
        });

        expect(parseExpression(tokenizeReader("factory<Array<Map<string, Point>>>(points)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "factory" },
            args: [{ kind: NodeKind.Identifier, name: "points" }],
            typeArguments: [{ kind: NodeKind.Identifier, name: "Array<Map<string, Point>>" }]
        });

        expect(parseExpression(tokenizeReader("a >> b >>> c"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: ">>>",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: ">>",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.Identifier, name: "b" }
            },
            right: { kind: NodeKind.Identifier, name: "c" }
        });

        expect(parseExpression(tokenizeReader("a < b >> c"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "<",
            left: { kind: NodeKind.Identifier, name: "a" },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: ">>",
                left: { kind: NodeKind.Identifier, name: "b" },
                right: { kind: NodeKind.Identifier, name: "c" }
            }
        });
    });

    it("parses union, intersection, literal, and tuple type annotations", () => {
        expect(parseStatement(tokenizeReader("let value: string | number | null"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "string | number | null" }
        });
        expect(parseStatement(tokenizeReader("let maybe: any?"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "any?" }
        });
        expect(parseStatement(tokenizeReader("let callback: (() => void)?"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "(() => void)?" }
        });
        expect(parseStatement(tokenizeReader("let value: A & B"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "A & B" }
        });
        expect(parseStatement(tokenizeReader("let status: \"ok\" | false"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: '"ok" | false' }
        });
        expect(parseStatement(tokenizeReader("let pair: [string, int]"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "[string, int]" }
        });
        expect(parseStatement(tokenizeReader("let frames: [int, number, Animation][]"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "[int, number, Animation][]" }
        });
        expect(parseStatement(tokenizeReader("let path: [EventTarget?]"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "[EventTarget?]" }
        });
        expect(parseStatement(tokenizeReader("let point: { x: int; y?: string }"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "{ x: int, y?: string }" }
        });
    });

    it("parses template-literal and import-member generic type annotations", () => {
        expect(parseStatement(tokenizeReader("type UUID = `${string}-${string}-${string}-${string}-${string}`", { jsx: false }), { language: "typescript" })).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "`${string}-${string}-${string}-${string}-${string}`" }
        });
        expect(parseStatement(tokenizeReader("type Stream<R = any> = typeof globalThis extends { onmessage: any } ? {} : import(\"stream/web\").ReadableStream<R>", { jsx: false }), { language: "typescript" })).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: 'typeof globalThis extends { onmessage: any } ? {  } : import("stream/web").ReadableStream<R>' }
        });
    });

    it("parses mapped, conditional, and infer type annotations", () => {
        expect(parseStatement(tokenizeReader("type Optional<T> = { [K in keyof T]?: T[K] }"))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "{ [K in keyof T]?: T[K] }" }
        });
        expect(parseStatement(tokenizeReader("type Concrete<T> = { -readonly [K in keyof T as K]-?: T[K] }"))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "{ -readonly [K in keyof T as K]-?: T[K] }" }
        });
        expect(parseStatement(tokenizeReader("type Element<T> = T extends (infer U)[] ? U : T"))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "T extends (infer U)[] ? U : T" }
        });
        expect(parseStatement(tokenizeReader("type Constrained<T> = T extends infer U extends string ? U : never"))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "T extends infer U extends string ? U : never" }
        });
        expect(parseStatement(tokenizeReader("type Recursive<T> = T extends string ? true : T extends number ? false : never"))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "T extends string ? true : T extends number ? false : never" }
        });
        expect(parseStatement(tokenizeReader('type ArrayOutputType<T, C> = C extends "one" ? [T["_output"], ...T["_output"][]] : T["_output"][]'))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: 'C extends "one" ? [T["_output"], ...T["_output"][]] : T["_output"][]' }
        });
    });

    it("parses keyof, typeof type queries, and indexed access type annotations", () => {
        expect(parseStatement(tokenizeReader("let key: keyof Person"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "keyof Person" }
        });
        expect(parseStatement(tokenizeReader("let copy: typeof person.name"))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "typeof person.name" }
        });
        expect(parseStatement(tokenizeReader('let formatter: typeof import("node:util").format'), { language: "typescript" })).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: 'typeof import("node:util").format' }
        });
        expect(parseStatement(tokenizeReader('let name: Person["name"]'))).toMatchObject({
            kind: NodeKind.VarStatement,
            typeAnnotation: { kind: NodeKind.Identifier, name: "Person[\"name\"]" }
        });
        expect(parseStatement(tokenizeReader("type Values<T> = T[keyof T]"))).toMatchObject({
            kind: NodeKind.TypeAliasStatement,
            targetType: { kind: NodeKind.Identifier, name: "T[keyof T]" }
        });
    });

    it("parses generic type aliases", () => {
        expect(parseStatement(tokenizeReader("type Boxed<T> = Box<T>[]"))).toEqual({
            kind: NodeKind.TypeAliasStatement,
            name: { kind: NodeKind.Identifier, name: "Boxed" },
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }
            ],
            targetType: { kind: NodeKind.Identifier, name: "Box<T>[]" }
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
            kind: NodeKind.InterfaceStatement,
            name: { kind: NodeKind.Identifier, name: "Dictionary" },
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "K" } },
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "V" } }
            ],
            extendsTypes: [
                { kind: NodeKind.Identifier, name: "Iterable<K>" },
                { kind: NodeKind.Identifier, name: "Serializable" }
            ],
            members: [
                {
                    kind: NodeKind.InterfaceMethodMember,
                    name: { kind: NodeKind.Identifier, name: "get" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "key" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "K" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "V" }
                },
                {
                    kind: NodeKind.InterfacePropertyMember,
                    name: { kind: NodeKind.Identifier, name: "keys" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "K[]" }
                }
            ]
        });
    });

    it("parses interface statements without braces in vexa mode", () => {
        expect(parseStatement(tokenizeReader("interface MyInterface"))).toEqual({
            kind: NodeKind.InterfaceStatement,
            name: { kind: NodeKind.Identifier, name: "MyInterface" },
            members: []
        });

        expect(parseStatement(tokenizeReader("interface MyInterface extends Readable, Writable"))).toEqual({
            kind: NodeKind.InterfaceStatement,
            name: { kind: NodeKind.Identifier, name: "MyInterface" },
            extendsTypes: [
                { kind: NodeKind.Identifier, name: "Readable" },
                { kind: NodeKind.Identifier, name: "Writable" }
            ],
            members: []
        });
    });

    it("rejects interface statements without braces in typescript mode", () => {
        expect(() =>
            parseStatement(tokenizeReader("interface MyInterface"), {
                language: "typescript"
            })
        ).toThrow("Expected '{' to start interface body");
    });

    it("parses class statement with kotlin-like primary constructor parameters without val/var", () => {
        expect(parseStatement(tokenizeReader("class Point(x: number, y: number) {\n}"))).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            primaryConstructorParameters: [
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                },
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "y" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
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
            kind: NodeKind.InterfaceStatement,
            name: { kind: NodeKind.Identifier, name: "ParsedArgs" },
            members: [
                {
                    kind: NodeKind.InterfacePropertyMember,
                    name: { kind: NodeKind.Identifier, name: "[string]" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "any" }
                },
                {
                    kind: NodeKind.InterfacePropertyMember,
                    name: { kind: NodeKind.Identifier, name: "_" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "string[]" }
                }
            ]
        });
    });

    it("parses class statement without braces in vexa mode", () => {
        expect(parseStatement(tokenizeReader("class Point"))).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            members: []
        });

        expect(parseStatement(tokenizeReader("class Point(val x: number, val y: number)"))).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            primaryConstructorParameters: [
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                },
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "y" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                }
            ],
            members: []
        });

        expect(parseStatement(tokenizeReader("class Point(x: number, y: number)"))).toEqual({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" },
            primaryConstructorParameters: [
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "x" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                },
                {
                    kind: NodeKind.ClassPrimaryConstructorParameter,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "y" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
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
            kind: NodeKind.ExprStatement,
            expression: {
                kind: NodeKind.AssignmentExpression,
                operator: "=",
                left: { kind: NodeKind.Identifier, name: "val" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            }
        });
    });

    it("treats 'fun' as identifier in typescript parser mode", () => {
        expect(parseStatement(tokenizeReader("fun = 1"), { language: "typescript" })).toEqual({
            kind: NodeKind.ExprStatement,
            expression: {
                kind: NodeKind.AssignmentExpression,
                operator: "=",
                left: { kind: NodeKind.Identifier, name: "fun" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
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
            kind: NodeKind.FunctionStatement,
            declarationKind: "function",
            declared: true,
            name: { kind: NodeKind.Identifier, name: "moment" },
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "inp" },
                    optional: true,
                    typeAnnotation: { kind: NodeKind.Identifier, name: "moment.MomentInput" }
                },
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "strict" },
                    optional: true,
                    typeAnnotation: { kind: NodeKind.Identifier, name: "boolean" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "moment.Moment" },
            missingBody: true,
            body: { kind: NodeKind.BlockStatement, body: [] }
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
            { kind: NodeKind.TypeAliasStatement, declared: true, name: { name: "Id" }, targetType: { name: "string" } },
            { kind: NodeKind.ClassStatement, declared: true, abstract: true, name: { name: "Service" } },
            { kind: NodeKind.ExportStatement, declaration: { kind: NodeKind.VarStatement, declared: true, name: { name: "service" } } },
            {
                kind: NodeKind.ExportStatement,
                declaration: {
                    kind: NodeKind.FunctionStatement,
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
            kind: NodeKind.NamespaceStatement,
            declared: true,
            declarationKind: "module",
            externalModuleName: { kind: NodeKind.StringLiteral, value: "pixi.js" },
            body: {
                kind: NodeKind.BlockStatement,
                body: [{
                    kind: NodeKind.ExprStatement,
                    expression: { kind: NodeKind.Identifier, name: "PIXI" }
                }]
            }
        });
    });

    it("parses runtime namespace declarations", () => {
        expect(parseStatement(tokenizeReader("namespace Tools { export const version = 1 }"))).toMatchObject({
            kind: NodeKind.NamespaceStatement,
            declarationKind: "namespace",
            names: [{ kind: NodeKind.Identifier, name: "Tools" }],
            body: { body: [{ kind: NodeKind.ExportStatement, declaration: { kind: NodeKind.VarStatement } }] }
        });
    });

    it("parses dotted ambient namespace bodies in typescript mode", () => {
        expect(
            parseStatement(tokenizeReader("declare namespace Company.Tools {\nexport interface Config { name: string }\nexport const version: string;\n}"), { language: "typescript" })
        ).toEqual({
            kind: NodeKind.NamespaceStatement,
            declared: true,
            declarationKind: "namespace",
            names: [
                { kind: NodeKind.Identifier, name: "Company" },
                { kind: NodeKind.Identifier, name: "Tools" }
            ],
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.ExportStatement,
                        declaration: {
                            kind: NodeKind.InterfaceStatement,
                            declared: true,
                            name: { kind: NodeKind.Identifier, name: "Config" },
                            members: [{ kind: NodeKind.InterfacePropertyMember, name: { kind: NodeKind.Identifier, name: "name" }, typeAnnotation: { kind: NodeKind.Identifier, name: "string" } }]
                        }
                    },
                    {
                        kind: NodeKind.ExportStatement,
                        declaration: {
                            kind: NodeKind.VarStatement,
                            declarationKind: "const",
                            declared: true,
                            name: { kind: NodeKind.Identifier, name: "version" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
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
            kind: NodeKind.NamespaceStatement,
            declared: true,
            globalAugmentation: true,
            declarationKind: "namespace",
            body: {
                kind: NodeKind.BlockStatement,
                body: [
                    {
                        kind: NodeKind.InterfaceStatement,
                        declared: true,
                        name: { kind: NodeKind.Identifier, name: "Iterator" },
                        typeParameters: [{ kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }],
                        members: []
                    },
                    {
                        kind: NodeKind.VarStatement,
                        declared: true,
                        declarationKind: "var",
                        name: { kind: NodeKind.Identifier, name: "Iterator" },
                        typeAnnotation: { kind: NodeKind.Identifier, name: "IteratorConstructor" }
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
            kind: NodeKind.FunctionStatement,
            declarationKind: "function",
            declared: true,
            name: { kind: NodeKind.Identifier, name: "identity" },
            typeParameters: [
                { kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }
            ],
            parameters: [{ kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "value" }, typeAnnotation: { kind: NodeKind.Identifier, name: "T" } }],
            returnType: { kind: NodeKind.Identifier, name: "T" },
            missingBody: true,
            body: { kind: NodeKind.BlockStatement, body: [] }
        });
    });

    it("parses 'declare function' as a function declaration in vexa mode", () => {
        expect(
            parseStatement(
                tokenizeReader("declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;"),
                { language: "vexa" }
            )
        ).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "function",
            declared: true,
            name: { kind: NodeKind.Identifier, name: "moment" },
            parameters: [
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "inp" }, optional: true, typeAnnotation: { kind: NodeKind.Identifier, name: "moment.MomentInput" } },
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "strict" }, optional: true, typeAnnotation: { kind: NodeKind.Identifier, name: "boolean" } }
            ],
            returnType: { kind: NodeKind.Identifier, name: "moment.Moment" },
            missingBody: true,
            body: { kind: NodeKind.BlockStatement, body: [] }
        });
    });

    it("parses 'declare fun' as a function declaration in vexa mode", () => {
        expect(
            parseStatement(
                tokenizeReader("declare fun moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;"),
                { language: "vexa" }
            )
        ).toEqual({
            kind: NodeKind.FunctionStatement,
            declarationKind: "fun",
            declared: true,
            name: { kind: NodeKind.Identifier, name: "moment" },
            parameters: [
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "inp" }, optional: true, typeAnnotation: { kind: NodeKind.Identifier, name: "moment.MomentInput" } },
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "strict" }, optional: true, typeAnnotation: { kind: NodeKind.Identifier, name: "boolean" } }
            ],
            returnType: { kind: NodeKind.Identifier, name: "moment.Moment" },
            missingBody: true,
            body: { kind: NodeKind.BlockStatement, body: [] }
        });
    });

    it("parses 'declare class' with signature-only members", () => {
        expect(
            parseStatement(
                tokenizeReader("declare class Console { log(a: number) }"),
                { language: "vexa" }
            )
        ).toEqual({
            kind: NodeKind.ClassStatement,
            declared: true,
            name: { kind: NodeKind.Identifier, name: "Console" },
            members: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "log" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "a" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        }
                    ],
                    body: { kind: NodeKind.BlockStatement, body: [] }
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
            kind: NodeKind.InterfaceStatement,
            declared: true,
            name: { kind: NodeKind.Identifier, name: "Repo" },
            typeParameters: [{ kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }],
            extendsTypes: [{ kind: NodeKind.Identifier, name: "Iterable<T>" }],
            members: [
                {
                    kind: NodeKind.InterfaceMethodMember,
                    name: { kind: NodeKind.Identifier, name: "find" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "id" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "int" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "T" }
                },
                {
                    kind: NodeKind.InterfacePropertyMember,
                    name: { kind: NodeKind.Identifier, name: "items" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "T[]" }
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
            kind: NodeKind.InterfaceStatement,
            name: { kind: NodeKind.Identifier, name: "Stream" },
            typeParameters: [{ kind: NodeKind.TypeParameter, name: { kind: NodeKind.Identifier, name: "T" } }],
            members: [
                {
                    kind: NodeKind.InterfaceMethodMember,
                    computed: true,
                    computedKey: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "Symbol" },
                        property: { kind: NodeKind.Identifier, name: "asyncIterator" },
                        computed: false
                    },
                    name: { kind: NodeKind.Identifier, name: "[Symbol.asyncIterator]" },
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "AsyncIterator<T>" }
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
            kind: NodeKind.InterfaceStatement,
            name: { kind: NodeKind.Identifier, name: "Repo" },
            members: [
                {
                    kind: NodeKind.InterfacePropertyMember,
                    declarationKind: "val",
                    name: { kind: NodeKind.Identifier, name: "size" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "int" }
                },
                {
                    kind: NodeKind.InterfaceMethodMember,
                    declarationKind: "fun",
                    name: { kind: NodeKind.Identifier, name: "get" },
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "id" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "string" }
                }
            ]
        });
    });

    it("parses 'declare var/let/const/val' declarations", () => {
        expect(parseStatement(tokenizeReader("declare var console: Console"), { language: "vexa" })).toEqual({
            kind: NodeKind.VarStatement,
            declared: true,
            declarationKind: "var",
            name: { kind: NodeKind.Identifier, name: "console" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "Console" }
        });

        expect(parseStatement(tokenizeReader("declare let value = 1"), { language: "vexa" })).toEqual({
            kind: NodeKind.VarStatement,
            declared: true,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "value" },
            initializer: { kind: NodeKind.IntLiteral, value: 1 }
        });

        expect(parseStatement(tokenizeReader("declare const ready: boolean"), { language: "typescript" })).toEqual({
            kind: NodeKind.VarStatement,
            declared: true,
            declarationKind: "const",
            name: { kind: NodeKind.Identifier, name: "ready" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "boolean" }
        });

        expect(parseStatement(tokenizeReader("declare val total: number"), { language: "vexa" })).toEqual({
            kind: NodeKind.VarStatement,
            declared: true,
            declarationKind: "val",
            name: { kind: NodeKind.Identifier, name: "total" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
        });
    });


    it("parses extension properties", () => {
        expect(parseStatement(tokenizeReader("val number.milliseconds => Duration(this)"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "val",
            receiverType: { kind: NodeKind.Identifier, name: "number" },
            name: { kind: NodeKind.Identifier, name: "milliseconds" },
            initializer: {
                kind: NodeKind.CallExpression,
                callee: { kind: NodeKind.Identifier, name: "Duration" },
                args: [{ kind: NodeKind.Identifier, name: "this" }]
            }
        });

        expect(parseStatement(tokenizeReader("val number.seconds: TimeSpan => TimeSpan(this * 1000)"))).toEqual({
            kind: NodeKind.VarStatement,
            declarationKind: "val",
            receiverType: { kind: NodeKind.Identifier, name: "number" },
            name: { kind: NodeKind.Identifier, name: "seconds" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "TimeSpan" },
            initializer: {
                kind: NodeKind.CallExpression,
                callee: { kind: NodeKind.Identifier, name: "TimeSpan" },
                args: [
                    {
                        kind: NodeKind.BinaryExpression,
                        operator: "*",
                        left: { kind: NodeKind.Identifier, name: "this" },
                        right: { kind: NodeKind.IntLiteral, value: 1000 }
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
            kind: NodeKind.VarStatement,
            declarationKind: "var",
            receiverType: { kind: NodeKind.Identifier, name: "View" },
            name: { kind: NodeKind.Identifier, name: "point" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "Vec2" },
            accessors: [
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "point" },
                    accessorKind: "get",
                    parameters: [],
                    returnType: { kind: NodeKind.Identifier, name: "Vec2" },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [{
                            kind: NodeKind.ReturnStatement,
                            expression: {
                                kind: NodeKind.CallExpression,
                                callee: { kind: NodeKind.Identifier, name: "Vec2" },
                                args: [
                                    { kind: NodeKind.Identifier, name: "x" },
                                    { kind: NodeKind.Identifier, name: "y" }
                                ]
                            }
                        }]
                    }
                },
                {
                    kind: NodeKind.ClassMethodMember,
                    name: { kind: NodeKind.Identifier, name: "point" },
                    accessorKind: "set",
                    parameters: [{
                        kind: NodeKind.FunctionParameter,
                        name: { kind: NodeKind.Identifier, name: "newValue" },
                        typeAnnotation: { kind: NodeKind.Identifier, name: "Vec2" }
                    }],
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ExprStatement,
                                expression: {
                                    kind: NodeKind.AssignmentExpression,
                                    operator: "=",
                                    left: {
                                        kind: NodeKind.Identifier,
                                        name: "x"
                                    },
                                    right: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "newValue" },
                                        property: { kind: NodeKind.Identifier, name: "x" },
                                        computed: false
                                    }
                                }
                            },
                            {
                                kind: NodeKind.ExprStatement,
                                expression: {
                                    kind: NodeKind.AssignmentExpression,
                                    operator: "=",
                                    left: {
                                        kind: NodeKind.Identifier,
                                        name: "y"
                                    },
                                    right: {
                                        kind: NodeKind.MemberExpression,
                                        object: { kind: NodeKind.Identifier, name: "newValue" },
                                        property: { kind: NodeKind.Identifier, name: "y" },
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
            kind: NodeKind.ExportStatement,
            declaration: {
                kind: NodeKind.VarStatement,
                declarationKind: "const",
                name: { kind: NodeKind.Identifier, name: "value" },
                typeAnnotation: { kind: NodeKind.Identifier, name: "number" },
                initializer: { kind: NodeKind.IntLiteral, value: 1 }
            }
        });

        expect(parseStatement(tokenizeReader("export { value as renamed, other } from \"./mod\""))).toEqual({
            kind: NodeKind.ExportStatement,
            specifiers: [
                {
                    kind: NodeKind.ExportSpecifier,
                    local: { kind: NodeKind.Identifier, name: "value" },
                    exported: { kind: NodeKind.Identifier, name: "renamed" }
                },
                {
                    kind: NodeKind.ExportSpecifier,
                    exported: { kind: NodeKind.Identifier, name: "other" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./mod" }
        });

        expect(parseStatement(tokenizeReader("export * from \"./all\""))).toEqual({
            kind: NodeKind.ExportStatement,
            exportAll: true,
            from: { kind: NodeKind.StringLiteral, value: "./all" }
        });

        expect(parseStatement(tokenizeReader("export * as widgets from \"./all\""))).toEqual({
            kind: NodeKind.ExportStatement,
            exportAll: true,
            namespaceExport: { kind: NodeKind.Identifier, name: "widgets" },
            from: { kind: NodeKind.StringLiteral, value: "./all" }
        });

        expect(parseStatement(tokenizeReader("export as namespace MyLib"))).toEqual({
            kind: NodeKind.ExportStatement,
            namespaceExport: { kind: NodeKind.Identifier, name: "MyLib" }
        });

        expect(parseStatement(tokenizeReader("export async fun load(): Promise<int> { return Promise.resolve(1) }"))).toMatchObject({
            kind: NodeKind.ExportStatement,
            declaration: {
                kind: NodeKind.FunctionStatement,
                async: true,
                name: { kind: NodeKind.Identifier, name: "load" }
            }
        });

        expect(parseStatement(tokenizeReader("export sync fun loadSync(): int { return 1 }"))).toMatchObject({
            kind: NodeKind.ExportStatement,
            declaration: {
                kind: NodeKind.FunctionStatement,
                sync: true,
                name: { kind: NodeKind.Identifier, name: "loadSync" }
            }
        });
    });

    it("parses default and type-only exports", () => {
        expect(parseStatement(tokenizeReader("export default value"))).toEqual({
            kind: NodeKind.ExportStatement,
            isDefault: true,
            declaration: {
                kind: NodeKind.ExprStatement,
                expression: { kind: NodeKind.Identifier, name: "value" }
            }
        });

        expect(parseStatement(tokenizeReader("export type Name = string"))).toEqual({
            kind: NodeKind.ExportStatement,
            declaration: {
                kind: NodeKind.TypeAliasStatement,
                name: { kind: NodeKind.Identifier, name: "Name" },
                targetType: { kind: NodeKind.Identifier, name: "string" }
            }
        });

        expect(parseStatement(tokenizeReader("export type { Name } from \"./types\""))).toEqual({
            kind: NodeKind.ExportStatement,
            typeOnly: true,
            specifiers: [
                {
                    kind: NodeKind.ExportSpecifier,
                    exported: { kind: NodeKind.Identifier, name: "Name" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./types" }
        });
    });

    it("parses consecutive minified function declarations in TypeScript mode", () => {
        const program = parseFile(
            tokenizeReader("function first(){}function second(){}"),
            { language: "typescript" }
        );

        expect(program.body).toHaveLength(2);
        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { kind: NodeKind.Identifier, name: "first" }
        });
        expect(program.body[1]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { kind: NodeKind.Identifier, name: "second" }
        });
    });

    it("parses TypeScript function names that use '$' identifiers", () => {
        expect(parseStatement(tokenizeReader("function $() {}"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { kind: NodeKind.Identifier, name: "$" }
        });
    });

    it("parses named import statements", () => {
        expect(parseStatement(tokenizeReader("import { Point, Demo } from \"./a\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "Point" }
                },
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "Demo" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./a" }
        });
    });

    it("parses index operator overloads in named import specifiers", () => {
        expect(parseStatement(tokenizeReader("import { operator[], operator[]= } from \"./grid\""))).toMatchObject({
            kind: NodeKind.ImportStatement,
            specifiers: [
                { kind: NodeKind.ImportSpecifier, imported: { kind: NodeKind.Identifier, name: "operator[]" } },
                { kind: NodeKind.ImportSpecifier, imported: { kind: NodeKind.Identifier, name: "operator[]=" } }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./grid" }
        });
    });

    it("parses inline type-only import and export specifiers", () => {
        expect(parseStatement(tokenizeReader("import { type AnalysisType, typeToString } from \"./types\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "AnalysisType" },
                    typeOnly: true
                },
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "typeToString" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./types" }
        });

        expect(parseStatement(tokenizeReader("export { type AnalysisType, typeToString } from \"./types\""))).toEqual({
            kind: NodeKind.ExportStatement,
            specifiers: [
                {
                    kind: NodeKind.ExportSpecifier,
                    exported: { kind: NodeKind.Identifier, name: "AnalysisType" },
                    typeOnly: true
                },
                {
                    kind: NodeKind.ExportSpecifier,
                    exported: { kind: NodeKind.Identifier, name: "typeToString" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./types" }
        });
    });

    it("parses operator overloads in named import specifiers", () => {
        expect(parseStatement(tokenizeReader("import { Point, operator+ } from \"./other\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "Point" }
                },
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "operator+" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./other" }
        });

        expect(parseStatement(tokenizeReader("import { operator- } from \"./other\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "operator-" }
                }
            ],
            from: { kind: NodeKind.StringLiteral, value: "./other" }
        });
    });

    it("parses default, namespace, side-effect, type-only, and aliased import forms", () => {
        expect(parseStatement(tokenizeReader("import React from \"react\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [],
            defaultImport: { kind: NodeKind.Identifier, name: "React" },
            from: { kind: NodeKind.StringLiteral, value: "react" }
        });

        expect(parseStatement(tokenizeReader("import * as fs from \"fs\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [],
            namespaceImport: { kind: NodeKind.Identifier, name: "fs" },
            from: { kind: NodeKind.StringLiteral, value: "fs" }
        });

        expect(parseStatement(tokenizeReader("import \"./setup\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [],
            sideEffectOnly: true,
            from: { kind: NodeKind.StringLiteral, value: "./setup" }
        });

        expect(parseStatement(tokenizeReader("import type { Point as LocalPoint } from \"./a\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "Point" },
                    local: { kind: NodeKind.Identifier, name: "LocalPoint" }
                }
            ],
            typeOnly: true,
            from: { kind: NodeKind.StringLiteral, value: "./a" }
        });

        expect(parseStatement(tokenizeReader("import React, { useState as useLocalState } from \"react\""))).toEqual({
            kind: NodeKind.ImportStatement,
            specifiers: [
                {
                    kind: NodeKind.ImportSpecifier,
                    imported: { kind: NodeKind.Identifier, name: "useState" },
                    local: { kind: NodeKind.Identifier, name: "useLocalState" }
                }
            ],
            defaultImport: { kind: NodeKind.Identifier, name: "React" },
            from: { kind: NodeKind.StringLiteral, value: "react" }
        });
    });
});
