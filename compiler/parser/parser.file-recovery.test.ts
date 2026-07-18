import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { Parser, getProgramRecoveryMarkers, parseExpression, parseFile } from "./parser";
import { tokenizeReader } from "./tokenizer";

describe("parseFile", () => {
    it("parses an empty file", () => {
        expect(parseFile(tokenizeReader(""))).toEqual({
            kind: NodeKind.Program,
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
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "ok" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
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
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.BlockStatement,
                    body: [
                        {
                            kind: NodeKind.VarStatement,
                            declarationKind: "let",
                            name: { kind: NodeKind.Identifier, name: "ignored" },
                            initializer: { kind: NodeKind.IntLiteral, value: 1 }
                        }
                    ]
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "ok" },
                    initializer: { kind: NodeKind.IntLiteral, value: 2 }
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
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "ok" },
                    initializer: { kind: NodeKind.IntLiteral, value: 1 }
                },
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "let",
                    name: { kind: NodeKind.Identifier, name: "done" },
                    initializer: { kind: NodeKind.IntLiteral, value: 2 }
                }
            ]
        });
        expect(parser.errors).toHaveLength(2);
    });

    it("recovers inside block statements and keeps later valid statements", () => {
        const parser = new Parser(tokenizeReader("{ let a = ; let b = 2 }"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: NodeKind.Program,
            body: [
                {
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
            ]
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers inside switch cases and continues with following cases", () => {
        const parser = new Parser(tokenizeReader("switch (x) { case 1: let a = ; case 2: let b = 2; break; default: return 0 }"));
        const ast = parser.parseFile();

        expect(ast).toEqual({
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
                                    name: { kind: NodeKind.Identifier, name: "b" },
                                    initializer: { kind: NodeKind.IntLiteral, value: 2 }
                                },
                                { kind: NodeKind.BreakStatement }
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
                }
            ]
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers from malformed nested if statements inside switch cases", () => {
        const parser = new Parser(tokenizeReader(dedent`
            switch (x) {
              case 1:
                if (ok) { let bad = ; }
                let keep = 1
                break
              default:
                let fallback = 2
            }
            let after = 3
            `
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        expect(ast.body[0]).toMatchObject({
            kind: NodeKind.SwitchStatement,
            cases: [
                {
                    kind: NodeKind.SwitchCase,
                    test: { kind: NodeKind.IntLiteral, value: 1 },
                    consequent: [
                        {
                            kind: NodeKind.IfStatement,
                            condition: { kind: NodeKind.Identifier, name: "ok" },
                            thenBranch: { kind: NodeKind.BlockStatement, body: [] }
                        },
                        {
                            kind: NodeKind.VarStatement,
                            declarationKind: "let",
                            name: { kind: NodeKind.Identifier, name: "keep" },
                            initializer: { kind: NodeKind.IntLiteral, value: 1 }
                        },
                        { kind: NodeKind.BreakStatement }
                    ]
                },
                {
                    kind: NodeKind.SwitchCase,
                    consequent: [
                        {
                            kind: NodeKind.VarStatement,
                            declarationKind: "let",
                            name: { kind: NodeKind.Identifier, name: "fallback" }
                        }
                    ]
                }
            ]
        });
        expect(ast.body[1]).toMatchObject({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "after" }
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers from broken for headers and keeps following statements", () => {
        const parser = new Parser(tokenizeReader(dedent`
            {
              for (let i = ; i < 2; i += 1) let bad = i
              let ok = 1
            }
            let after = 2
            `
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        const block = ast.body[0];
        expect(block?.kind).toBe(NodeKind.BlockStatement);
        if (!block || block.kind !== NodeKind.BlockStatement) {
            throw new Error("Expected first statement to be a block");
        }
        const blockBody = (block as unknown as { body: Array<any> }).body;
        expect(
            blockBody.some((statement: any) =>
                statement.kind === NodeKind.VarStatement &&
                statement.name.name === "ok"
            )
        ).toBe(true);
        expect(ast.body[1]).toMatchObject({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "after" }
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers from malformed chained calls and parses subsequent statements", () => {
        const parser = new Parser(tokenizeReader(dedent`
            {
              target.run(1, ).next(;
              let ok = 1
            }
            let done = 2
            `
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        expect(ast.body[0]?.kind).toBe(NodeKind.BlockStatement);
        expect(ast.body[1]).toMatchObject({
            kind: NodeKind.VarStatement,
            declarationKind: "let",
            name: { kind: NodeKind.Identifier, name: "done" }
        });
        expect(parser.errors.length).toBeGreaterThan(0);
    });

    it("recovers malformed statement separators by skipping to the next '}' or newline", () => {
        const parser = new Parser(tokenizeReader(dedent`
            asdsa declare class Console {
              log(a: number)
            }
            
            declare var console: Console
            `
        ));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.ExprStatement,
                    expression: {
                        kind: NodeKind.Identifier,
                        name: "asdsa"
                    }
                },
                {
                    kind: NodeKind.VarStatement,
                    declared: true,
                    declarationKind: "var",
                    name: { kind: NodeKind.Identifier, name: "console" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "Console" }
                }
            ]
        });
        expect(parser.errors.map((issue) => issue.message)).toContain(
            "Expected ';', newline, or end of file between statements"
        );
    });

    it("recovers incomplete member access before newline and keeps following declarations", () => {
        const parser = new Parser(tokenizeReader(dedent`
            fun demo() {
              const result: Point = value
              return result.
            }
            class Point(val x: int, val y: int)
            `
        ));
        const ast = parser.parseFile();

        expect(ast.body).toHaveLength(2);
        expect(ast.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { kind: NodeKind.Identifier, name: "demo" },
            body: {
                body: [
                    {
                        kind: NodeKind.VarStatement,
                        declarationKind: "const",
                        name: { kind: NodeKind.Identifier, name: "result" },
                        typeAnnotation: { kind: NodeKind.Identifier, name: "Point" }
                    },
                    {
                        kind: NodeKind.ReturnStatement,
                        expression: { kind: NodeKind.Identifier, name: "result" }
                    }
                ]
            }
        });
        expect(ast.body[1]).toMatchObject({
            kind: NodeKind.ClassStatement,
            name: { kind: NodeKind.Identifier, name: "Point" }
        });
        expect(parser.errors.map((issue) => issue.message)).toContain("Expected identifier after '.'");
    });

    it("recovers separator errors across newline-heavy continuations until a likely statement start", () => {
        const parser = new Parser(tokenizeReader(dedent`
            { let a = 1 let b =
              +
              2
              let c = 3
            }
            `
        ));
        const ast = parser.parseFile();

        expect(ast).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.BlockStatement,
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
                            name: { kind: NodeKind.Identifier, name: "c" },
                            initializer: { kind: NodeKind.IntLiteral, value: 3 }
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
            kind: NodeKind.Program,
            body: [{
                kind: NodeKind.EnumStatement,
                name: { kind: NodeKind.Identifier, name: "Direction" },
                members: [
                    { kind: NodeKind.EnumMember, name: { kind: NodeKind.Identifier, name: "Up" } },
                    { kind: NodeKind.EnumMember, name: { kind: NodeKind.Identifier, name: "Down" }, initializer: { kind: NodeKind.IntLiteral, value: 4 } },
                    { kind: NodeKind.EnumMember, name: { kind: NodeKind.Identifier, name: "Left" } },
                    { kind: NodeKind.EnumMember, name: { kind: NodeKind.Identifier, name: "Right" }, initializer: { kind: NodeKind.StringLiteral, value: "right" } }
                ]
            }]
        });

        expect(parseFile(tokenizeReader("const enum Status { Ready = 1, Done }"))).toEqual({
            kind: NodeKind.Program,
            body: [{
                kind: NodeKind.EnumStatement,
                isConst: true,
                name: { kind: NodeKind.Identifier, name: "Status" },
                members: [
                    { kind: NodeKind.EnumMember, name: { kind: NodeKind.Identifier, name: "Ready" }, initializer: { kind: NodeKind.IntLiteral, value: 1 } },
                    { kind: NodeKind.EnumMember, name: { kind: NodeKind.Identifier, name: "Done" } }
                ]
            }]
        });
    });

    it("parses exported const enum declarations before const variables", () => {
        expect(parseFile(tokenizeReader("export const enum Status { Ready, Done }"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.Program,
            body: [{
                kind: NodeKind.ExportStatement,
                declaration: {
                    kind: NodeKind.EnumStatement,
                    isConst: true,
                    name: { kind: NodeKind.Identifier, name: "Status" }
                }
            }]
        });
    });
    it("parses async functions, generator functions, yield, and this parameters", () => {
        const program = parseFile(tokenizeReader(`async function load(this: Loader, id: string) { return await fetch(id) }
function* ids() { yield 1; yield* more }
class Store { async save(this: Store) { return await persist(this) }; *values() { yield 1 } }
`));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            async: true,
            name: { name: "load" },
            parameters: [
                { kind: NodeKind.FunctionParameter, thisParameter: true, name: { name: "this" }, typeAnnotation: { name: "Loader" } },
                { kind: NodeKind.FunctionParameter, name: { name: "id" }, typeAnnotation: { name: "string" } }
            ]
        });
        expect(program.body[1]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            generator: true,
            name: { name: "ids" },
            body: {
                body: [
                    { kind: NodeKind.ExprStatement, expression: { kind: NodeKind.UnaryExpression, operator: "yield" } },
                    { kind: NodeKind.ExprStatement, expression: { kind: NodeKind.UnaryExpression, operator: "yield*" } }
                ]
            }
        });
        expect(program.body[2]).toMatchObject({
            kind: NodeKind.ClassStatement,
            members: [
                { kind: NodeKind.ClassMethodMember, async: true, name: { name: "save" } },
                { kind: NodeKind.ClassMethodMember, generator: true, name: { name: "values" } }
            ]
        });
    });

    it("parses sync functions, methods, arrows, and function expressions", () => {
        const program = parseFile(tokenizeReader(`sync function load(id: string): int { return 1 }
sync fun fetchValue(): int { return 2 }
class Store { sync save(): int { return 3 } }
let arrow = sync () => { return 4 }
let expr = sync function(): int { return 5 }
`));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            sync: true,
            name: { name: "load" }
        });
        expect(program.body[1]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            sync: true,
            name: { name: "fetchValue" }
        });
        expect(program.body[2]).toMatchObject({
            kind: NodeKind.ClassStatement,
            members: [{ kind: NodeKind.ClassMethodMember, sync: true, name: { name: "save" } }]
        });
        expect(program.body[3]).toMatchObject({
            kind: NodeKind.VarStatement,
            initializer: { kind: NodeKind.ArrowFunctionExpression, sync: true }
        });
        expect(program.body[4]).toMatchObject({
            kind: NodeKind.VarStatement,
            initializer: { kind: NodeKind.FunctionExpression, sync: true }
        });
    });

    it("parses the contextual `go` operator while keeping `go` usable as an identifier", () => {
        const goOperator = parseExpression(tokenizeReader("go fetchValue()"));
        expect(goOperator).toMatchObject({
            kind: NodeKind.UnaryExpression,
            operator: "go",
            argument: { kind: NodeKind.CallExpression, callee: { name: "fetchValue" } }
        });

        const program = parseFile(tokenizeReader(`let go = 5
let total = go + 1
let result = go
go = 7
`));
        expect(program.body[0]).toMatchObject({ kind: NodeKind.VarStatement, initializer: { kind: NodeKind.IntLiteral, value: 5 } });
        expect(program.body[1]).toMatchObject({
            kind: NodeKind.VarStatement,
            initializer: { kind: NodeKind.BinaryExpression, operator: "+", left: { kind: NodeKind.Identifier, name: "go" } }
        });
        expect(program.body[2]).toMatchObject({
            kind: NodeKind.VarStatement,
            initializer: { kind: NodeKind.Identifier, name: "go" }
        });
        expect(program.body[3]).toMatchObject({
            kind: NodeKind.ExprStatement,
            expression: { kind: NodeKind.AssignmentExpression, left: { kind: NodeKind.Identifier, name: "go" } }
        });

        const goCall = parseExpression(tokenizeReader("go()"));
        expect(goCall).toMatchObject({ kind: NodeKind.CallExpression, callee: { kind: NodeKind.Identifier, name: "go" } });
    });

    it("parses object and array binding patterns in variable declarations", () => {
        const program = parseFile(tokenizeReader("let { id, name :: displayName, nested :: { value = 1 }, ...rest } = source\nconst [first, , third = 3, ...tail] = values"));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.VarStatement,
            name: {
                kind: NodeKind.ObjectBindingPattern,
                elements: [
                    { kind: NodeKind.BindingElement, name: { kind: NodeKind.Identifier, name: "id" }, shorthand: true },
                    { kind: NodeKind.BindingElement, propertyName: { name: "name" }, name: { name: "displayName" } },
                    { kind: NodeKind.BindingElement, propertyName: { name: "nested" }, name: { kind: NodeKind.ObjectBindingPattern } },
                    { kind: NodeKind.BindingElement, rest: true, name: { name: "rest" } }
                ]
            }
        });
        expect(program.body[1]).toMatchObject({
            kind: NodeKind.VarStatement,
            name: {
                kind: NodeKind.ArrayBindingPattern,
                elements: [
                    { kind: NodeKind.BindingElement, name: { name: "first" } },
                    { kind: NodeKind.BindingHole },
                    { kind: NodeKind.BindingElement, name: { name: "third" }, initializer: { kind: NodeKind.IntLiteral, value: 3 } },
                    { kind: NodeKind.BindingElement, rest: true, name: { name: "tail" } }
                ]
            }
        });
    });


    it("parses brace lambdas inside call argument lists while preserving object literals", () => {
        expect(parseExpression(tokenizeReader("apply({ value -> value + 1 })"))).toMatchObject({
            kind: NodeKind.CallExpression,
            args: [{ kind: NodeKind.ArrowFunctionExpression, parameters: [{ name: { name: "value" } }] }]
        });
        expect(parseExpression(tokenizeReader("apply({ it })"))).toMatchObject({
            kind: NodeKind.CallExpression,
            args: [{ kind: NodeKind.ArrowFunctionExpression, contextualObjectLiteral: { kind: NodeKind.ObjectLiteral } }]
        });
        expect(parseExpression(tokenizeReader("apply({ value: 1 })"))).toMatchObject({
            kind: NodeKind.CallExpression,
            args: [{ kind: NodeKind.ObjectLiteral }]
        });
    });

});

describe("destructured parameters", () => {
    it("parses VexaScript binding element type annotations and double-colon renames", () => {
        const program = parseFile(tokenizeReader("function Page({ name : string, title :: displayTitle : string }, [count : int]) { return displayTitle }"));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            parameters: [
                { name: { kind: NodeKind.ObjectBindingPattern, elements: [
                    { name: { name: "name" }, shorthand: true, typeAnnotation: { name: "string" } },
                    { propertyName: { name: "title" }, name: { name: "displayTitle" }, typeAnnotation: { name: "string" } }
                ] } },
                { name: { kind: NodeKind.ArrayBindingPattern, elements: [
                    { name: { name: "count" }, typeAnnotation: { name: "int" } }
                ] } }
            ]
        });
    });

    it("keeps TypeScript object binding colons as renames", () => {
        const program = parseFile(tokenizeReader("function Page({ name: displayName }: { name: string }) { return displayName }"), { language: "typescript" });

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            parameters: [
                {
                    name: { kind: NodeKind.ObjectBindingPattern, elements: [
                        { propertyName: { name: "name" }, name: { name: "displayName" } }
                    ] },
                    typeAnnotation: { name: "{ name: string }" }
                }
            ]
        });
    });

    it("parses object, array, nested, default, and rest binding patterns", () => {
        const program = parseFile(tokenizeReader("function unpack({ id, nested :: { value = 1 }, ...meta }, [first, , ...tail] = values) { return value }"));
        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            parameters: [
                { name: { kind: NodeKind.ObjectBindingPattern, elements: [
                    { name: { name: "id" }, shorthand: true },
                    { propertyName: { name: "nested" }, name: { kind: NodeKind.ObjectBindingPattern } },
                    { rest: true, name: { name: "meta" } }
                ] } },
                { name: { kind: NodeKind.ArrayBindingPattern, elements: [
                    { name: { name: "first" } }, { kind: NodeKind.BindingHole }, { rest: true, name: { name: "tail" } }
                ] }, defaultValue: { kind: NodeKind.Identifier, name: "values" } }
            ]
        });
    });

    it("parses string literal property names in TypeScript object binding patterns", () => {
        const program = parseFile(
            tokenizeReader('function unpack({ "aria-current": ariaCurrentProp = "page" }) { return ariaCurrentProp }'),
            { language: "typescript" }
        );

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            parameters: [
                {
                    name: {
                        kind: NodeKind.ObjectBindingPattern,
                        elements: [
                            {
                                kind: NodeKind.BindingElement,
                                propertyName: { kind: NodeKind.StringLiteral, value: "aria-current" },
                                name: { kind: NodeKind.Identifier, name: "ariaCurrentProp" },
                                initializer: { kind: NodeKind.StringLiteral, value: "page" }
                            }
                        ]
                    }
                }
            ]
        });
    });
});

describe("JavaScript implementation annotations", () => {
    it("parses @JsInline on bodyless functions", () => {
        const program = parseFile(tokenizeReader('@JsInline("if (!cond) throw new Error(message)")\nfun assert(cond: boolean, message: string = "assert failed")'));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { name: "assert" },
            missingBody: true,
            jsInline: "if (!cond) throw new Error(message)"
        });
    });

    it("rejects @JsInline on non-function declarations", () => {
        expect(() => parseFile(tokenizeReader('@JsInline("noop")\nclass Foo {}'))).toThrow();
    });

    it("parses @JsName on functions, classes and variables", () => {
        const fn = parseFile(tokenizeReader('@JsName("clamp01")\nfunction clampUnit(value: number): number { return value }'));
        expect(fn.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { name: "clampUnit" },
            jsName: "clamp01"
        });

        const cls = parseFile(tokenizeReader('@JsName("rgba")\nclass Color(val r: int)'));
        expect(cls.body[0]).toMatchObject({
            kind: NodeKind.ClassStatement,
            name: { name: "Color" },
            jsName: "rgba"
        });

        const variable = parseFile(tokenizeReader('@JsName("PI_JS")\nval pi = 3.14'));
        expect(variable.body[0]).toMatchObject({
            kind: NodeKind.VarStatement,
            jsName: "PI_JS"
        });
    });

    it("stacks @JsName and @JsInline on the same function", () => {
        const program = parseFile(tokenizeReader('@JsName("assertJs")\n@JsInline("if (!cond) throw new Error()")\nfun assert(cond: boolean)'));
        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { name: "assert" },
            jsName: "assertJs",
            jsInline: "if (!cond) throw new Error()"
        });
    });

    describe("embedded XML / JSX", () => {
        function jsxExpression(input: string) {
            return parseExpression(tokenizeReader(input, { jsx: true }), { language: "vexa" });
        }

        it("parses an element with attributes, text and expression children", () => {
            expect(jsxExpression('<div class="x">hi {name}</div>')).toMatchObject({
                kind: NodeKind.JsxElement,
                tagName: "div",
                selfClosing: false,
                attributes: [
                    { kind: NodeKind.JsxAttribute, name: "class", value: { kind: NodeKind.StringLiteral, value: "x" } }
                ],
                children: [
                    { kind: NodeKind.JsxText, value: "hi " },
                    { kind: NodeKind.JsxExpressionContainer, expression: { kind: NodeKind.Identifier, name: "name" } }
                ]
            });
        });

        it("parses self-closing elements and boolean attributes", () => {
            expect(jsxExpression("<input disabled />")).toMatchObject({
                kind: NodeKind.JsxElement,
                tagName: "input",
                selfClosing: true,
                attributes: [{ kind: NodeKind.JsxAttribute, name: "disabled", value: undefined }],
                children: []
            });
        });

        it("treats component and dotted tags as references but not intrinsic tags", () => {
            expect(jsxExpression("<Foo.Bar/>")).toMatchObject({
                kind: NodeKind.JsxElement,
                tagName: "Foo.Bar",
                reference: {
                    kind: NodeKind.MemberExpression,
                    object: { kind: NodeKind.Identifier, name: "Foo" },
                    property: { kind: NodeKind.Identifier, name: "Bar" }
                }
            });
            expect(jsxExpression("<div/>")).toHaveProperty("reference", undefined);
        });

        it("parses spread attributes and fragments", () => {
            expect(jsxExpression("<><span {...props}/></>")).toMatchObject({
                kind: NodeKind.JsxFragment,
                children: [
                    {
                        kind: NodeKind.JsxElement,
                        tagName: "span",
                        attributes: [
                            { kind: NodeKind.JsxSpreadAttribute, expression: { kind: NodeKind.Identifier, name: "props" } }
                        ]
                    }
                ]
            });
        });

        it("reports an error when closing tags do not match", () => {
            const reader = tokenizeReader("<div></span>", { jsx: true });
            const parser = new Parser(reader, { language: "vexa" });
            parser.parseExpression();
            expect(parser.errors.length).toBeGreaterThan(0);
        });

        it("reports an error for a corrupted expression inside a child container", () => {
            const reader = tokenizeReader("<div>{=}</div>", { jsx: true });
            const parser = new Parser(reader, { language: "vexa" });
            parser.parseExpression();
            expect(parser.errors.length).toBeGreaterThan(0);
        });

        it("reports an error for a corrupted expression in a JSX attribute value", () => {
            const reader = tokenizeReader("<div attr={=} />", { jsx: true });
            const parser = new Parser(reader, { language: "vexa" });
            parser.parseExpression();
            expect(parser.errors.length).toBeGreaterThan(0);
        });

        it("parses double-brace JSX attribute values as zero-argument lambdas when object literals do not parse", () => {
            expect(jsxExpression("<button onClick={{ count-- }} />")).toMatchObject({
                kind: NodeKind.JsxElement,
                tagName: "button",
                attributes: [
                    {
                        kind: NodeKind.JsxAttribute,
                        name: "onClick",
                        value: {
                            kind: NodeKind.JsxExpressionContainer,
                            expression: {
                                kind: NodeKind.ArrowFunctionExpression,
                                parameters: [],
                                body: { kind: NodeKind.UpdateExpression }
                            }
                        }
                    }
                ]
            });
        });

        it("reports an error when a JSX attribute opens a brace without spread dots", () => {
            const reader = tokenizeReader("<div {props} />", { jsx: true });
            const parser = new Parser(reader, { language: "vexa" });
            parser.parseExpression();
            expect(parser.errors.length).toBeGreaterThan(0);
            expect(parser.errors[0]?.message).toContain("'...'");
        });

        it("reports an error for a corrupted expression inside a spread attribute", () => {
            const reader = tokenizeReader("<div {...=} />", { jsx: true });
            const parser = new Parser(reader, { language: "vexa" });
            parser.parseExpression();
            expect(parser.errors.length).toBeGreaterThan(0);
        });

        it("throws an unterminated-element error when a JSX element has no closing tag", () => {
            expect(() => {
                const reader = tokenizeReader("<div>hello", { jsx: true });
                const parser = new Parser(reader, { language: "vexa" });
                parser.parseExpression();
            }).toThrow("Unterminated");
        });

        it("reports an error for a corrupted expression inside a nested JSX child", () => {
            const reader = tokenizeReader("<outer><inner>{=}</inner></outer>", { jsx: true });
            const parser = new Parser(reader, { language: "vexa" });
            parser.parseExpression();
            expect(parser.errors.length).toBeGreaterThan(0);
        });

        it("recovers from a corrupted child expression and continues parsing the next statement", () => {
            const parser = new Parser(
                tokenizeReader("let x = <div>{=}</div>; let ok = 1;", { jsx: true }),
                { language: "vexa" }
            );
            const ast = parser.parseFile();
            expect(parser.errors.length).toBeGreaterThan(0);
            expect(ast.body[ast.body.length - 1]).toMatchObject({
                kind: NodeKind.VarStatement,
                name: { kind: NodeKind.Identifier, name: "ok" }
            });
        });

        it("recovers from a corrupted attribute value expression and continues parsing the next statement", () => {
            const parser = new Parser(
                tokenizeReader("let x = <div attr={=} />; let ok = 1;", { jsx: true }),
                { language: "vexa" }
            );
            const ast = parser.parseFile();
            expect(parser.errors.length).toBeGreaterThan(0);
            expect(ast.body[ast.body.length - 1]).toMatchObject({
                kind: NodeKind.VarStatement,
                name: { kind: NodeKind.Identifier, name: "ok" }
            });
        });

        it("recovers from a mismatched JSX closing tag and continues parsing the next statement", () => {
            const parser = new Parser(
                tokenizeReader("let x = <div></span>; let ok = 1;", { jsx: true }),
                { language: "vexa" }
            );
            const ast = parser.parseFile();
            expect(parser.errors.length).toBeGreaterThan(0);
            expect(ast.body[ast.body.length - 1]).toMatchObject({
                kind: NodeKind.VarStatement,
                name: { kind: NodeKind.Identifier, name: "ok" }
            });
        });

        it("does not enable JSX casts in TypeScript mode by default", () => {
            expect(parseExpression(tokenizeReader("<string>value", { jsx: false }), { language: "typescript" })).toMatchObject({
                kind: NodeKind.AsExpression
            });
        });
    });
});
