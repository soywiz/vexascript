import { describe, expect, it } from "../test/expect";
import { Node } from "../ast/ast";
import { walkAst } from "../ast/traversal";
import { parseProgram } from "./parser";
import { tokenizeReader } from "./tokenizer";

describe("parseProgram", () => {
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
            expect(node instanceof Node, `Expected ${node.kind} to inherit from Node`).toBe(true);
        });
    });

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
