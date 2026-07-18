import { describe, expect, it } from "../test/expect";
import { Identifier, IntLiteral, Node, NodeKind, nodeKindName, ObjectProperty, ReturnStatement } from "../ast/ast";
import { walkAst } from "../ast/traversal";
import { parseProgram } from "./parser";
import { tokenizeReader } from "./tokenizer";

describe("parseProgram", () => {
    it("uses typed positional node constructors with class-owned discriminators", () => {
        const key = new Identifier("answer");
        const value = new IntLiteral(42);
        const property = new ObjectProperty(key, value);

        expect(property.kind).toBe(NodeKind.ObjectProperty);
        expect(typeof property.kind).toBe("number");
        expect(property.key).toBe(key);
        expect(property.value).toBe(value);
        const returned = new ReturnStatement();
        expect(returned.kind).toBe(NodeKind.ReturnStatement);
        expect(returned).toHaveProperty("firstToken", undefined);
        expect(returned).toHaveProperty("lastToken", undefined);
        expect(returned).toHaveProperty("__vexaNativeSourcePath", undefined);
    });

    it("constructs every parsed AST value as a nominal node", () => {
        const program = parseProgram(tokenizeReader(`
            @JsName("run")
            fun demo(items: int[]) {
                for (val item in items) {
                    if (item > 1) console.log({ item, doubled: item * 2 })
                }
            }
            class Box(val value: int) { fun get() => value }
            demo([1, 2, 3])
        `));

        walkAst(program, node => {
            expect(node instanceof Node, `Expected ${nodeKindName(node.kind)} to inherit from Node`).toBe(true);
        });
    });

    it("parses multiple let statements separated by semicolons", () => {
        expect(parseProgram(tokenizeReader("let a = 1; let b = a + 2;"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "a" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                },
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
        });
    });

    it("parses block statements at top level", () => {
        expect(parseProgram(tokenizeReader("let a = 1; { let b = 2; let c = b + 1 };"))).toEqual({
            kind: NodeKind.Program,
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
                            initializer: { kind: NodeKind.IntLiteral, value: 2 }
                        },
                        {
                            kind: NodeKind.VarStatement,
                            declarationKind: "let",
                            name: { kind: NodeKind.Identifier, name: "c" },
                            initializer: {
                                kind: NodeKind.BinaryExpression,
                                operator: "+",
                                left: { kind: NodeKind.Identifier, name: "b" },
                                right: { kind: NodeKind.IntLiteral, value: 1 }
                            }
                        }
                    ]
                }
            ]
        });
    });

    it("parses while statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("while (1) { let a = 2; let b = a + 3 }; let c = 4;"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.WhileStatement,
                    condition: { kind: NodeKind.IntLiteral, value: 1 },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "a" },
                                initializer: { kind: NodeKind.IntLiteral, value: 2 }
                            },
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "b" },
                                initializer: {
                                    kind: NodeKind.BinaryExpression,
                                    operator: "+",
                                    left: { kind: NodeKind.Identifier, name: "a" },
                                    right: { kind: NodeKind.IntLiteral, value: 3 }
                                }
                            }
                        ]
                    }
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "c" },
                    initializer: { kind: NodeKind.IntLiteral, value: 4 }
                }
            ]
        });
    });

    it("parses do-while statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("do { let i = 0; let j = i + 1 } while (j); let done = 1;"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.DoWhileStatement,
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "i" },
                                initializer: { kind: NodeKind.IntLiteral, value: 0 }
                            },
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "j" },
                                initializer: {
                                    kind: NodeKind.BinaryExpression,
                                    operator: "+",
                                    left: { kind: NodeKind.Identifier, name: "i" },
                                    right: { kind: NodeKind.IntLiteral, value: 1 }
                                }
                            }
                        ]
                    },
                    condition: { kind: NodeKind.Identifier, name: "j" }
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "done" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                }
            ]
        });
    });

    it("parses if-else statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("if (ok) { let a = 1 } else { let b = 2 }; let done = 1;"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.IfStatement,
                    condition: { kind: NodeKind.Identifier, name: "ok" },
                    thenBranch: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "a" },
                                initializer: { kind: NodeKind.IntLiteral, value: 1 }
                            }
                        ]
                    },
                    elseBranch: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "b" },
                                initializer: { kind: NodeKind.IntLiteral, value: 2 }
                            }
                        ]
                    }
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "done" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                }
            ]
        });
    });

    it("parses switch statements with multiple cases and fallthrough", () => {
        expect(parseProgram(tokenizeReader("switch (x) { case 1: case 2: let y = x; break; default: let z = 0 }; let done = 1;"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.SwitchStatement,
                    discriminant: { kind: NodeKind.Identifier, name: "x" },
                    cases: [
                        {
                            kind: NodeKind.SwitchCase,
                            test: { kind: NodeKind.IntLiteral, value: 1 },
                            consequent: []
                        },
                        {
                            kind: NodeKind.SwitchCase,
                            test: { kind: NodeKind.IntLiteral, value: 2 },
                            consequent: [
                                {
                                    kind: NodeKind.VarStatement,
                                    declarationKind: "let",
                                    name: { kind: NodeKind.Identifier, name: "y" },
                                    initializer: { kind: NodeKind.Identifier, name: "x" }
                                },
                                {
                                    kind: NodeKind.BreakStatement
                                }
                            ]
                        },
                        {
                            kind: NodeKind.SwitchCase,
                            consequent: [
                                {
                                    kind: NodeKind.VarStatement,
                                    declarationKind: "let",
                                    name: { kind: NodeKind.Identifier, name: "z" },
                                    initializer: { kind: NodeKind.IntLiteral, value: 0 }
                                }
                            ]
                        }
                    ]
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "done" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                }
            ]
        });
    });

    it("parses with statements, statement labels, and labeled break/continue", () => {
        expect(parseProgram(tokenizeReader("outer: while (ok) { with (scope) { break outer }; continue outer }; done"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.LabeledStatement,
                    label: { kind: NodeKind.Identifier, name: "outer" },
                    body: {
                        kind: NodeKind.WhileStatement,
                        condition: { kind: NodeKind.Identifier, name: "ok" },
                        body: {
                            kind: NodeKind.BlockStatement,
                            body: [
                                {
                                    kind: NodeKind.WithStatement,
                                    object: { kind: NodeKind.Identifier, name: "scope" },
                                    body: {
                                        kind: NodeKind.BlockStatement,
                                        body: [
                                            {
                                                kind: NodeKind.BreakStatement,
                                                label: { kind: NodeKind.Identifier, name: "outer" }
                                            }
                                        ]
                                    }
                                },
                                {
                                    kind: NodeKind.ContinueStatement,
                                    label: { kind: NodeKind.Identifier, name: "outer" }
                                }
                            ]
                        }
                    }
                },
                { kind: NodeKind.ExprStatement, expression: { kind: NodeKind.Identifier, name: "done" } }
            ]
        });
    });

    it("parses for statements with block bodies", () => {
        expect(parseProgram(tokenizeReader("for (let i = 0; i < 2; i += 1) { let x = i }; let done = 1;"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
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
                        right: { kind: NodeKind.IntLiteral, value: 2 }
                    },
                    update: {
                        kind: NodeKind.AssignmentExpression,
                        operator: "+=",
                        left: { kind: NodeKind.Identifier, name: "i" },
                        right: { kind: NodeKind.IntLiteral, value: 1 }
                    },
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.VarStatement,
                                declarationKind: "let",
                                name: { kind: NodeKind.Identifier, name: "x" },
                                initializer: { kind: NodeKind.Identifier, name: "i" }
                            }
                        ]
                    }
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "done" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                }
            ]
        });
    });

    it("parses statements separated by newlines", () => {
        expect(parseProgram(tokenizeReader("let a = 1\na += 2\na + 3"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "a" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                },
                {
                    kind: NodeKind.ExprStatement,
                    expression: {
                        kind: NodeKind.AssignmentExpression,
                        operator: "+=",
                        left: { kind: NodeKind.Identifier, name: "a" },
                        right: { kind: NodeKind.IntLiteral, value: 2 }
                    }
                },
                {
                    kind: NodeKind.ExprStatement,
                    expression: {
                        kind: NodeKind.BinaryExpression,
                        operator: "+",
                        left: { kind: NodeKind.Identifier, name: "a" },
                        right: { kind: NodeKind.IntLiteral, value: 3 }
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
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "var",
                    name: { kind: NodeKind.Identifier, name: "res" },
                    initializer: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "map" },
                        property: { kind: NodeKind.Identifier, name: "b" },
                        computed: false
                    }
                },
                {
                    kind: NodeKind.ExprStatement,
                    expression: {
                        kind: NodeKind.CallExpression,
                        callee: {
                            kind: NodeKind.MemberExpression,
                            object: {
                                kind: NodeKind.ArrayLiteral,
                                elements: [
                                    { kind: NodeKind.IntLiteral, value: 1 },
                                    { kind: NodeKind.IntLiteral, value: 2 },
                                    { kind: NodeKind.IntLiteral, value: 3 },
                                    { kind: NodeKind.IntLiteral, value: 4 }
                                ]
                            },
                            property: { kind: NodeKind.Identifier, name: "map" },
                            computed: false
                        },
                        args: [{ kind: NodeKind.IntLiteral, value: 10 }]
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
            kind: NodeKind.Program,
            body: [
                {
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
                            { kind: NodeKind.ReturnStatement },
                            { kind: NodeKind.ContinueStatement },
                            { kind: NodeKind.BreakStatement }
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
            kind: NodeKind.Program,
            body: [
                {
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
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "after" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                }
            ]
        });
    });

    it("parses class declarations without braces mixed with other statements", () => {
        expect(parseProgram(tokenizeReader("class Point\nlet after = 1"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.ClassStatement,
                    name: { kind: NodeKind.Identifier, name: "Point" },
                    members: []
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "after" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                }
            ]
        });
    });

    it("parses programs with single-line and block comments", () => {
        expect(parseProgram(tokenizeReader("let a = 1 // comment\n/* block */\nlet b = a + 2"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "a" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                },
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
        });
    });
});
