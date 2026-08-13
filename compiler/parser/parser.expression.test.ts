import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { ParseError, parseExpression, parseFile, parseProgram } from "./parser";
import { tokenizeReader } from "./tokenizer";
import { parseSource } from "compiler/pipeline/parse";

describe("parseExpression", () => {
    it("parses control-flow forms as expressions in VexaScript", () => {
        expect(parseExpression(tokenizeReader("value || throw Error(\"Not found\")"))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "||",
            right: {
                kind: NodeKind.ThrowStatement,
                expression: { kind: NodeKind.CallExpression }
            }
        });
        expect(parseExpression(tokenizeReader("ready && return result"))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "&&",
            right: {
                kind: NodeKind.ReturnStatement,
                expression: { kind: NodeKind.Identifier, name: "result" }
            }
        });
        expect(parseExpression(tokenizeReader("if (ready) value else throw Error()"))).toMatchObject({
            kind: NodeKind.IfStatement,
            condition: { kind: NodeKind.Identifier, name: "ready" },
            thenBranch: {
                kind: NodeKind.ExprStatement,
                expression: { kind: NodeKind.Identifier, name: "value" }
            },
            elseBranch: { kind: NodeKind.ThrowStatement }
        });
        expect(parseExpression(tokenizeReader("continue outer"))).toMatchObject({
            kind: NodeKind.ContinueStatement,
            label: { kind: NodeKind.Identifier, name: "outer" }
        });
        expect(parseExpression(tokenizeReader("break"))).toMatchObject({
            kind: NodeKind.BreakStatement
        });
    });

    it("parses match arms as a lowered if-expression chain", () => {
        const expression = parseExpression(tokenizeReader(dedent`
            match {
                when value == 1: "one"
                value == 2 -> {
                    val label = "two"
                    label
                }
                default -> "other"
            }
        `));

        expect(expression).toMatchObject({
            kind: NodeKind.IfStatement,
            condition: {
                kind: NodeKind.BinaryExpression,
                operator: "=="
            },
            thenBranch: {
                kind: NodeKind.ExprStatement,
                expression: { kind: NodeKind.StringLiteral, value: "one" }
            },
            elseBranch: {
                kind: NodeKind.IfStatement,
                thenBranch: {
                    kind: NodeKind.BlockStatement,
                    body: [
                        { kind: NodeKind.VarStatement },
                        { kind: NodeKind.ExprStatement, expression: { kind: NodeKind.Identifier, name: "label" } }
                    ]
                },
                elseBranch: {
                    kind: NodeKind.ExprStatement,
                    expression: { kind: NodeKind.StringLiteral, value: "other" }
                }
            }
        });
    });

    it("parses structural is patterns as binary-expression operands", () => {
        expect(parseExpression(tokenizeReader(`event is { payload: { kind: "data" }, values }`))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "is",
            left: { kind: NodeKind.Identifier, name: "event" },
            right: {
                kind: NodeKind.ObjectLiteral,
                properties: [
                    {
                        kind: NodeKind.ObjectProperty,
                        value: {
                            kind: NodeKind.ObjectLiteral,
                            properties: [{ kind: NodeKind.ObjectProperty }]
                        }
                    },
                    { kind: NodeKind.ObjectProperty, shorthand: true }
                ]
            }
        });
        expect(parseExpression(tokenizeReader(`value is ["ok", 1]`))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "is",
            right: { kind: NodeKind.ArrayLiteral }
        });
        expect(parseExpression(tokenizeReader(`value is ({ kind: "ok" } and { payload })`))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "is",
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "&&",
                matcherCombinator: true,
                left: { kind: NodeKind.ObjectLiteral },
                right: { kind: NodeKind.ObjectLiteral }
            }
        });
        expect(parseExpression(tokenizeReader(`value is ("ok" or "ready")`))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "is",
            right: { kind: NodeKind.BinaryExpression, operator: "||", matcherCombinator: true }
        });
        expect(parseExpression(tokenizeReader(`value is (>= 10 and < 20)`))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "is",
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "&&",
                matcherCombinator: true,
                left: { kind: NodeKind.BinaryExpression, operator: ">=", matcherRelational: true },
                right: { kind: NodeKind.BinaryExpression, operator: "<", matcherRelational: true }
            }
        });
        expect(parseExpression(tokenizeReader(`value is /^ready$/i`))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            operator: "is",
            right: { kind: NodeKind.RegExpLiteral, pattern: "^ready$", flags: "i" }
        });
    });

    it("lowers subject match patterns through a single-evaluation arrow call", () => {
        expect(parseExpression(tokenizeReader(dedent`
            match (read()) {
                >= 10 and < 20 -> "range"
                else -> "other"
            }
        `))).toMatchObject({
            kind: NodeKind.CallExpression,
            matchSubjectLowering: true,
            args: [{ kind: NodeKind.CallExpression }],
            callee: {
                kind: NodeKind.ArrowFunctionExpression,
                parameters: [{ name: { name: "__vexa_match_subject" } }],
                body: {
                    kind: NodeKind.IfStatement,
                    condition: {
                        kind: NodeKind.BinaryExpression,
                        operator: "is",
                        right: { kind: NodeKind.BinaryExpression, matcherCombinator: true }
                    }
                }
            }
        });
    });

    it("requires when for colon arms and omits it for arrow arms", () => {
        expect(parseExpression(tokenizeReader(dedent`
            match (value) {
                when { kind: "ok" }: value.payload
                { kind: "error" } -> value.message
                default: "pending"
            }
        `))).toMatchObject({
            kind: NodeKind.IfStatement,
            matchSyntax: {
                arms: [
                    { delimiter: ":", explicitWhen: true },
                    { delimiter: "->", explicitWhen: false },
                    { delimiter: ":", defaultKeyword: "default" }
                ]
            }
        });

        expect(() => parseExpression(tokenizeReader('match { when ready -> "yes" else -> "no" }')))
            .toThrow("Match arms using '->' must omit 'when'");
        expect(() => parseExpression(tokenizeReader('match { ready: "yes" else: "no" }')))
            .toThrow("Match arms using ':' require 'when'");
    });

    it("parses a standalone array rest wildcard only in matcher patterns", () => {
        expect(parseExpression(tokenizeReader('value is ["ok", ..., 500]'))).toMatchObject({
            kind: NodeKind.BinaryExpression,
            right: {
                kind: NodeKind.ArrayLiteral,
                elements: [
                    { kind: NodeKind.StringLiteral },
                    { kind: NodeKind.SpreadExpression, matcherWildcard: true },
                    { kind: NodeKind.IntLiteral }
                ]
            }
        });
        expect(() => parseExpression(tokenizeReader('value is [1, ..., ...]')))
            .toThrow("Array matcher patterns may contain only one '...' wildcard");
    });

    it("parses consecutive regular-expression subject arms with both delimiters", () => {
        expect(() => parseExpression(tokenizeReader(dedent`
            match (value) {
                /^ready-/i -> "ready"
                /^pending-/ -> "pending"
                when /^error-/: "error"
                else -> "other"
            }
        `))).not.toThrow();
    });

    it("separates a relational subject arm after a regular-expression arm", () => {
        const expression = parseExpression(tokenizeReader(dedent`
            match (value) {
              /^user-[0-9]+$/i -> "regexp"
              >= 10 and < 20 -> "range"
              else -> "other"
            }
        `));

        expect(expression?.matchSyntax?.arms).toMatchObject([
            { condition: { kind: NodeKind.RegExpLiteral } },
            {
                condition: {
                    kind: NodeKind.BinaryExpression,
                    operator: "&&",
                    matcherCombinator: true
                }
            },
            { defaultKeyword: "else" }
        ]);
    });

    it("parses primitive type patterns and typed bindings in subject arrays", () => {
        expect(() => parseExpression(tokenizeReader(dedent`
            match (["test", 2, 3]) {
                [string, val b: number, 3] -> b
                [1, val value, ...] -> value
                else -> undefined
            }
        `))).not.toThrow();
    });

    it("keeps control-flow forms statement-only in TypeScript parser mode", () => {
        expect(parseExpression(tokenizeReader("throw Error()"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.Identifier,
            name: "throw"
        });
    });

    it("builds an AST for a single literal", () => {
        expect(parseExpression(tokenizeReader("10"))).toEqual(
            { kind: NodeKind.IntLiteral, value: 10 }
        );
    });

    it("builds an AST for decimal and scientific literals", () => {
        expect(parseExpression(tokenizeReader("10.573"))).toEqual(
            { kind: NodeKind.FloatLiteral, value: 10.573 }
        );
        expect(parseExpression(tokenizeReader("10e-3"))).toEqual(
            { kind: NodeKind.FloatLiteral, value: 0.01 }
        );
        expect(parseExpression(tokenizeReader("0."))).toEqual(
            { kind: NodeKind.FloatLiteral, value: 0 }
        );
    });

    it("builds an AST for bigint and long literals", () => {
        expect(parseExpression(tokenizeReader("10n"))).toEqual(
            { kind: NodeKind.BigIntLiteral, value: 10n }
        );
        expect(parseExpression(tokenizeReader("20L"))).toEqual(
            { kind: NodeKind.LongLiteral, value: 20n }
        );
    });

    it("parses anonymous interface call signatures in TypeScript declarations", () => {
        const ast = parseFile(
            tokenizeReader("interface BigIntConstructor {\n  (value: bigint | boolean | number | string): bigint;\n}"),
            { language: "typescript" }
        );

        expect(ast.body[0]).toMatchObject({
            kind: NodeKind.InterfaceStatement,
            name: { name: "BigIntConstructor" },
            members: [
                {
                    kind: NodeKind.InterfaceMethodMember,
                    name: { name: "call" },
                    parameters: [
                        {
                            name: { kind: NodeKind.Identifier, name: "value" },
                            typeAnnotation: { name: "bigint | boolean | number | string" }
                        }
                    ],
                    returnType: { name: "bigint" }
                }
            ]
        });
    });

    it("parses generic anonymous interface call signatures in TypeScript declarations", () => {
        const ast = parseFile(
            tokenizeReader("interface Renderer {\n  <P>(element: ReactElement<P>, container: Container | null): P | void;\n}"),
            { language: "typescript" }
        );

        expect(ast.body[0]).toMatchObject({
            kind: NodeKind.InterfaceStatement,
            name: { name: "Renderer" },
            members: [
                {
                    kind: NodeKind.InterfaceMethodMember,
                    name: { name: "call" },
                    typeParameters: [
                        {
                            kind: NodeKind.TypeParameter,
                            name: { kind: NodeKind.Identifier, name: "P" }
                        }
                    ],
                    parameters: [
                        {
                            name: { kind: NodeKind.Identifier, name: "element" },
                            typeAnnotation: { name: "ReactElement<P>" }
                        },
                        {
                            name: { kind: NodeKind.Identifier, name: "container" },
                            typeAnnotation: { name: "Container | null" }
                        }
                    ],
                    returnType: { kind: NodeKind.Identifier, name: "P | void" }
                }
            ]
        });
    });

    it("builds an AST for numeric separators and non-decimal literals", () => {
        expect(parseExpression(tokenizeReader("1_000"))).toEqual(
            { kind: NodeKind.IntLiteral, value: 1000 }
        );
        expect(parseExpression(tokenizeReader("0xff"))).toEqual(
            { kind: NodeKind.IntLiteral, value: 255 }
        );
        expect(parseExpression(tokenizeReader("0b1010"))).toEqual(
            { kind: NodeKind.IntLiteral, value: 10 }
        );
        expect(parseExpression(tokenizeReader("0o755"))).toEqual(
            { kind: NodeKind.IntLiteral, value: 493 }
        );
        expect(parseExpression(tokenizeReader("0xfn"))).toEqual(
            { kind: NodeKind.BigIntLiteral, value: 15n }
        );
    });

    it("builds an AST for boolean, null, and undefined literals", () => {
        expect(parseExpression(tokenizeReader("true"))).toEqual({ kind: NodeKind.BooleanLiteral, value: true });
        expect(parseExpression(tokenizeReader("false"))).toEqual({ kind: NodeKind.BooleanLiteral, value: false });
        expect(parseExpression(tokenizeReader("null"))).toEqual({ kind: NodeKind.NullLiteral });
        expect(parseExpression(tokenizeReader("undefined"))).toEqual({ kind: NodeKind.UndefinedLiteral });
    });

    it("builds AST nodes for regular expression literals and sparse arrays", () => {
        expect(parseExpression(tokenizeReader("/a[0-9]+/gi"))).toEqual({
            kind: NodeKind.RegExpLiteral,
            pattern: "a[0-9]+",
            flags: "gi"
        });

        expect(parseExpression(tokenizeReader("[1, , 3,]"))).toEqual({
            kind: NodeKind.ArrayLiteral,
            elements: [
                { kind: NodeKind.IntLiteral, value: 1 },
                { kind: NodeKind.ArrayHole },
                { kind: NodeKind.IntLiteral, value: 3 }
            ]
        });
    });

    it("parses named class expressions", () => {
        expect(parseExpression(tokenizeReader("class Widget extends Base {}"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.ClassExpression,
            name: { kind: NodeKind.Identifier, name: "Widget" },
            extendsType: { kind: NodeKind.Identifier, name: "Base" },
            members: []
        });
    });

    it("parses async single-parameter arrow functions without parentheses", () => {
        expect(parseExpression(tokenizeReader("async f => f + 1"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.ArrowFunctionExpression,
            async: true,
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "f" }
                }
            ],
            body: {
                kind: NodeKind.BinaryExpression,
                operator: "+"
            }
        });
    });

    it("parses computed class fields in class expressions", () => {
        expect(parseExpression(tokenizeReader("class Browser { [PropertySymbol.exceptionObserver] = null; }"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.ClassExpression,
            members: [
                {
                    kind: NodeKind.ClassFieldMember,
                    computed: true,
                    computedKey: {
                        kind: NodeKind.MemberExpression
                    },
                    initializer: { kind: NodeKind.NullLiteral }
                }
            ]
        });
    });

    it("parses new.target member access chains", () => {
        expect(parseExpression(tokenizeReader("new.target.prototype"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.NewExpression,
            callee: {
                kind: NodeKind.MemberExpression,
                property: { kind: NodeKind.Identifier, name: "prototype" },
                object: {
                    kind: NodeKind.MemberExpression,
                    property: { kind: NodeKind.Identifier, name: "target" },
                    object: { kind: NodeKind.Identifier, name: "new" }
                }
            }
        });
    });

    it("parses anonymous export default function and class expressions in TypeScript mode", () => {
        const functionAst = parseFile(tokenizeReader("export default function () { return 7; }"), { language: "typescript" });
        expect(functionAst.body[0]).toMatchObject({
            kind: NodeKind.ExportStatement,
            isDefault: true,
            declaration: {
                kind: NodeKind.ExprStatement,
                expression: {
                    kind: NodeKind.FunctionExpression,
                    body: {
                        kind: NodeKind.BlockStatement
                    }
                }
            }
        });

        const classAst = parseFile(tokenizeReader("export default class extends Base {}"), { language: "typescript" });
        expect(classAst.body[0]).toMatchObject({
            kind: NodeKind.ExportStatement,
            isDefault: true,
            declaration: {
                kind: NodeKind.ExprStatement,
                expression: {
                    kind: NodeKind.ClassExpression,
                    extendsType: { kind: NodeKind.Identifier, name: "Base" },
                    members: []
                }
            }
        });
    });

    it("builds an AST for escaped string literal", () => {
        expect(parseExpression(tokenizeReader("\"hello\\n\\r\\t...world\""))).toEqual(
            { kind: NodeKind.StringLiteral, value: "hello\n\r\t...world" }
        );
    });

    it("builds an AST for unicode escaped string literal", () => {
        expect(parseExpression(tokenizeReader("\"hi\\u0020there\""))).toEqual(
            { kind: NodeKind.StringLiteral, value: "hi there" }
        );
    });

    it("parses VexaScript single-quoted literals as Unicode code-point integers", () => {
        expect(parseExpression(tokenizeReader("'a'"))).toEqual(
            { kind: NodeKind.CharacterLiteral, value: 97 }
        );
        expect(parseExpression(tokenizeReader("'😀'"))).toEqual(
            { kind: NodeKind.CharacterLiteral, value: 0x1f600 }
        );
        expect(parseExpression(tokenizeReader("'\\u0061'"))).toEqual(
            { kind: NodeKind.CharacterLiteral, value: 97 }
        );
    });

    it("rejects VexaScript single-quoted literals that do not contain exactly one code point", () => {
        const multiCharacter = parseSource("val text = 'aaa'");
        const empty = parseSource("val text = ''");

        expect(multiCharacter.parserIssues.map((issue) => issue.message)).toContain(
            "Character literals must contain exactly one Unicode code point; use double quotes for strings"
        );
        expect(empty.parserIssues.map((issue) => issue.message)).toContain(
            "Character literals must contain exactly one Unicode code point; use double quotes for strings"
        );
    });

    it("keeps single-quoted literals as strings in TypeScript mode", () => {
        expect(parseExpression(tokenizeReader("'abc'", { language: "typescript" }), { language: "typescript" })).toEqual(
            { kind: NodeKind.StringLiteral, value: "abc" }
        );
    });

    it("builds an AST for template literal interpolation via concatenation", () => {
        expect(parseExpression(tokenizeReader("`hello ${name}`"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "+",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.StringLiteral, value: "hello " },
                right: { kind: NodeKind.Identifier, name: "name" }
            },
            right: { kind: NodeKind.StringLiteral, value: "" }
        });
    });

    it("builds an AST for empty template interpolation via a missing-expression placeholder", () => {
        expect(parseExpression(tokenizeReader("`${}`"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "+",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.StringLiteral, value: "" },
                right: { kind: NodeKind.MissingExpression }
            },
            right: { kind: NodeKind.StringLiteral, value: "" }
        });
    });


    it("builds an AST for comma expressions at the lowest precedence", () => {
        expect(parseExpression(tokenizeReader("a = 1, b + 2, c"))).toEqual({
            kind: NodeKind.CommaExpression,
            expressions: [
                {
                    kind: NodeKind.AssignmentExpression,
                    operator: "=",
                    left: { kind: NodeKind.Identifier, name: "a" },
                    right: { kind: NodeKind.IntLiteral, value: 1 }
                },
                {
                    kind: NodeKind.BinaryExpression,
                    operator: "+",
                    left: { kind: NodeKind.Identifier, name: "b" },
                    right: { kind: NodeKind.IntLiteral, value: 2 }
                },
                { kind: NodeKind.Identifier, name: "c" }
            ]
        });
    });

    it("keeps comma-delimited call arguments separate from comma expressions", () => {
        expect(parseExpression(tokenizeReader("fn(a, (b, c))"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "fn" },
            args: [
                { kind: NodeKind.Identifier, name: "a" },
                {
                    kind: NodeKind.CommaExpression,
                    expressions: [
                        { kind: NodeKind.Identifier, name: "b" },
                        { kind: NodeKind.Identifier, name: "c" }
                    ]
                }
            ]
        });
    });

    it("accepts trailing commas in call argument lists", () => {
        expect(parseExpression(tokenizeReader("fn(a, b,)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "fn" },
            args: [
                { kind: NodeKind.Identifier, name: "a" },
                { kind: NodeKind.Identifier, name: "b" }
            ]
        });
    });

    it("keeps parsing call argument lists with empty slots between commas", () => {
        expect(parseExpression(tokenizeReader("fn(a,,b)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "fn" },
            args: [
                { kind: NodeKind.Identifier, name: "a" },
                { kind: NodeKind.MissingExpression },
                { kind: NodeKind.Identifier, name: "b" }
            ]
        });
    });

    it("parses named call arguments as NamedArgument nodes", () => {
        expect(parseExpression(tokenizeReader('fetch(url: "https://hello.world")'))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "fetch" },
            args: [
                {
                    kind: NodeKind.NamedArgument,
                    name: { kind: NodeKind.Identifier, name: "url" },
                    value: { kind: NodeKind.StringLiteral, value: "https://hello.world" }
                }
            ]
        });
    });

    it("parses annotation declarations with parameter properties", () => {
        const program = parseFile(tokenizeReader("annotation JsName(val name: string)"));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.AnnotationStatement,
            name: { kind: NodeKind.Identifier, name: "JsName" },
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    accessModifier: "public",
                    isReadonly: true,
                    name: { kind: NodeKind.Identifier, name: "name" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
                }
            ]
        });
    });

    it("parses zero-argument annotations without parentheses in declarations and uses", () => {
        const program = parseFile(tokenizeReader(dedent`
            annotation DemoAnnotation
            @DemoAnnotation
            fun demo() {}
        `));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.AnnotationStatement,
            name: { kind: NodeKind.Identifier, name: "DemoAnnotation" },
            parameters: []
        });
        expect(program.body[1]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { kind: NodeKind.Identifier, name: "demo" },
            annotations: [
                {
                    kind: NodeKind.AnnotationApplication,
                    name: { kind: NodeKind.Identifier, name: "DemoAnnotation" },
                    args: []
                }
            ]
        });
    });

    it("parses '@' annotations and attaches them to declarations", () => {
        const program = parseFile(tokenizeReader(dedent`
            @JsName("rgba")
            fun color() {}
        `));

        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            name: { kind: NodeKind.Identifier, name: "color" },
            jsName: "rgba",
            annotations: [
                {
                    kind: NodeKind.AnnotationApplication,
                    name: { kind: NodeKind.Identifier, name: "JsName" },
                    args: [{ kind: NodeKind.StringLiteral, value: "rgba" }]
                }
            ]
        });
    });

    it("parses a mix of positional and named call arguments", () => {
        expect(parseExpression(tokenizeReader("connect(host, port: 8080)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "connect" },
            args: [
                { kind: NodeKind.Identifier, name: "host" },
                {
                    kind: NodeKind.NamedArgument,
                    name: { kind: NodeKind.Identifier, name: "port" },
                    value: { kind: NodeKind.IntLiteral, value: 8080 }
                }
            ]
        });
    });

    it("does not treat a ternary argument as a named argument", () => {
        expect(parseExpression(tokenizeReader("fn(cond ? a : b)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "fn" },
            args: [
                {
                    kind: NodeKind.ConditionalExpression,
                    test: { kind: NodeKind.Identifier, name: "cond" },
                    consequent: { kind: NodeKind.Identifier, name: "a" },
                    alternate: { kind: NodeKind.Identifier, name: "b" }
                }
            ]
        });
    });

    it("builds an AST for optional call, optional element access, spread expressions, and rest parameters", () => {
        expect(parseExpression(tokenizeReader("fn?.(...args)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "fn" },
            args: [
                {
                    kind: NodeKind.SpreadExpression,
                    argument: { kind: NodeKind.Identifier, name: "args" }
                }
            ],
            optional: true
        });
        expect(parseExpression(tokenizeReader("obj?.[key]"))).toEqual({
            kind: NodeKind.MemberExpression,
            object: { kind: NodeKind.Identifier, name: "obj" },
            property: { kind: NodeKind.Identifier, name: "key" },
            computed: true,
            optional: true
        });

        const program = parseFile(tokenizeReader("fun collect(first: int, ...rest: int[]) { return rest }"));
        expect(program.body[0]).toMatchObject({
            kind: NodeKind.FunctionStatement,
            parameters: [
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "first" } },
                { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "rest" }, rest: true }
            ]
        });
    });

    it("builds an AST for addition expression", () => {
        expect(parseExpression(tokenizeReader("1+2"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "+",
            left: { kind: NodeKind.IntLiteral, value: 1 },
            right: { kind: NodeKind.IntLiteral, value: 2 }
        });
    });

    it("builds an AST for identifier plus integer", () => {
        expect(parseExpression(tokenizeReader("a + 1"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "+",
            left: { kind: NodeKind.Identifier, name: "a" },
            right: { kind: NodeKind.IntLiteral, value: 1 }
        });
    });

    it("builds an AST for inclusive range expressions", () => {
        expect(parseExpression(tokenizeReader("0 ... 10"))).toEqual({
            kind: NodeKind.RangeExpression,
            start: { kind: NodeKind.IntLiteral, value: 0 },
            end: { kind: NodeKind.IntLiteral, value: 10 },
            exclusive: false
        });
    });

    it("builds an AST for exclusive range expressions", () => {
        expect(parseExpression(tokenizeReader("0 ..< 10"))).toEqual({
            kind: NodeKind.RangeExpression,
            start: { kind: NodeKind.IntLiteral, value: 0 },
            end: { kind: NodeKind.IntLiteral, value: 10 },
            exclusive: true
        });
    });

    it("builds an AST for chain expressions", () => {
        expect(parseExpression(tokenizeReader("badge ..point = target ..beginFill(1)"))).toEqual({
            kind: NodeKind.ChainExpression,
            receiver: { kind: NodeKind.Identifier, name: "badge" },
            operations: [
                {
                    kind: NodeKind.AssignmentExpression,
                    operator: "=",
                    left: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "badge" },
                        property: { kind: NodeKind.Identifier, name: "point" },
                        computed: false
                    },
                    right: { kind: NodeKind.Identifier, name: "target" }
                },
                {
                    kind: NodeKind.CallExpression,
                    callee: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "badge" },
                        property: { kind: NodeKind.Identifier, name: "beginFill" },
                        computed: false
                    },
                    args: [{ kind: NodeKind.IntLiteral, value: 1 }]
                }
            ]
        });
    });

    it("builds an AST for TypeScript as assertions", () => {
        expect(parseExpression(tokenizeReader("value as string"))).toEqual({
            kind: NodeKind.AsExpression,
            expression: { kind: NodeKind.Identifier, name: "value" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
        });
        expect(parseExpression(tokenizeReader("a + b as number"))).toEqual({
            kind: NodeKind.AsExpression,
            expression: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.Identifier, name: "b" }
            },
            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
        });
    });

    it("builds an AST for TypeScript satisfies expressions", () => {
        expect(parseExpression(tokenizeReader("value satisfies string"))).toEqual({
            kind: NodeKind.SatisfiesExpression,
            expression: { kind: NodeKind.Identifier, name: "value" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
        });
        expect(parseExpression(tokenizeReader("a + b satisfies number"))).toEqual({
            kind: NodeKind.SatisfiesExpression,
            expression: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.Identifier, name: "b" }
            },
            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
        });
    });

    it("builds an AST for TypeScript non-null assertions", () => {
        expect(parseExpression(tokenizeReader("value!"))).toEqual({
            kind: NodeKind.NonNullExpression,
            expression: { kind: NodeKind.Identifier, name: "value" }
        });
        expect(parseExpression(tokenizeReader("maybe!.name!"))).toEqual({
            kind: NodeKind.NonNullExpression,
            expression: {
                kind: NodeKind.MemberExpression,
                object: { kind: NodeKind.Identifier, name: "maybe" },
                property: { kind: NodeKind.Identifier, name: "name" },
                computed: false,
                nonNullAsserted: true
            }
        });
    });

    it("builds an AST for TypeScript angle-bracket assertions", () => {
        expect(parseExpression(tokenizeReader("<string>value"), { language: "typescript" })).toEqual({
            kind: NodeKind.AsExpression,
            expression: { kind: NodeKind.Identifier, name: "value" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "string" }
        });
        expect(parseExpression(tokenizeReader("<string[]>value"), { language: "typescript" })).toEqual({
            kind: NodeKind.AsExpression,
            expression: { kind: NodeKind.Identifier, name: "value" },
            typeAnnotation: { kind: NodeKind.Identifier, name: "string[]" }
        });
    });

    it("builds an AST for unary plus", () => {
        expect(parseExpression(tokenizeReader("+1"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "+",
            argument: { kind: NodeKind.IntLiteral, value: 1 }
        });
    });

    it("builds an AST for unary minus with parenthesized expression", () => {
        expect(parseExpression(tokenizeReader("-(1 + 2)"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "-",
            argument: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.IntLiteral, value: 1 },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("builds an AST for additional unary operators", () => {
        expect(parseExpression(tokenizeReader("!a"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "!",
            argument: { kind: NodeKind.Identifier, name: "a" }
        });
        expect(parseExpression(tokenizeReader("~a"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "~",
            argument: { kind: NodeKind.Identifier, name: "a" }
        });
        expect(parseExpression(tokenizeReader("typeof a"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "typeof",
            argument: { kind: NodeKind.Identifier, name: "a" }
        });
        expect(parseExpression(tokenizeReader("void a"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "void",
            argument: { kind: NodeKind.Identifier, name: "a" }
        });
        expect(parseExpression(tokenizeReader("delete a.b"))).toEqual({
            kind: NodeKind.UnaryExpression,
            operator: "delete",
            argument: {
                kind: NodeKind.MemberExpression,
                object: { kind: NodeKind.Identifier, name: "a" },
                property: { kind: NodeKind.Identifier, name: "b" },
                computed: false
            }
        });
    });

    it("builds an AST for prefix increment and decrement", () => {
        expect(parseExpression(tokenizeReader("++a"))).toEqual({
            kind: NodeKind.UpdateExpression,
            operator: "++",
            argument: { kind: NodeKind.Identifier, name: "a" },
            prefix: true
        });
        expect(parseExpression(tokenizeReader("--b"))).toEqual({
            kind: NodeKind.UpdateExpression,
            operator: "--",
            argument: { kind: NodeKind.Identifier, name: "b" },
            prefix: true
        });
    });

    it("builds an AST for postfix increment and decrement", () => {
        expect(parseExpression(tokenizeReader("a++"))).toEqual({
            kind: NodeKind.UpdateExpression,
            operator: "++",
            argument: { kind: NodeKind.Identifier, name: "a" },
            prefix: false
        });
        expect(parseExpression(tokenizeReader("b--"))).toEqual({
            kind: NodeKind.UpdateExpression,
            operator: "--",
            argument: { kind: NodeKind.Identifier, name: "b" },
            prefix: false
        });
    });

    it("does not treat prefix ++/-- on next line as postfix continuation", () => {
        expect(parseProgram(tokenizeReader("var a: int = 10\n++a\n--a\n"))).toEqual({
            kind: NodeKind.Program,
            body: [
                {
                    kind: NodeKind.VarStatement,
                    declarationKind: "var",
                    name: { kind: NodeKind.Identifier, name: "a" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "int" },
                    initializer: { kind: NodeKind.IntLiteral, value: 10 }
                },
                {
                    kind: NodeKind.ExprStatement,
                    expression: {
                        kind: NodeKind.UpdateExpression,
                        operator: "++",
                        argument: { kind: NodeKind.Identifier, name: "a" },
                        prefix: true
                    }
                },
                {
                    kind: NodeKind.ExprStatement,
                    expression: {
                        kind: NodeKind.UpdateExpression,
                        operator: "--",
                        argument: { kind: NodeKind.Identifier, name: "a" },
                        prefix: true
                    }
                }
            ]
        });
    });

    it("builds an AST for nested array literals", () => {
        expect(parseExpression(tokenizeReader("[1, 2, [3, 4]]"))).toEqual({
            kind: NodeKind.ArrayLiteral,
            elements: [
                { kind: NodeKind.IntLiteral, value: 1 },
                { kind: NodeKind.IntLiteral, value: 2 },
                {
                    kind: NodeKind.ArrayLiteral,
                    elements: [
                        { kind: NodeKind.IntLiteral, value: 3 },
                        { kind: NodeKind.IntLiteral, value: 4 }
                    ]
                }
            ]
        });
    });

    it("builds an AST for array comprehensions", () => {
        expect(parseExpression(tokenizeReader("[for (item of items) item * 2]"))).toEqual({
            kind: NodeKind.ArrayComprehension,
            iterationKind: "of",
            iterator: { kind: NodeKind.Identifier, name: "item" },
            iterable: { kind: NodeKind.Identifier, name: "items" },
            body: {
                kind: NodeKind.BinaryExpression,
                operator: "*",
                left: { kind: NodeKind.Identifier, name: "item" },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("mixes array comprehensions with values and spreads", () => {
        const expression = parseExpression(tokenizeReader(
            "[1, for (n in 0 ... 2) n, ...items, for (n in 0 ... 2) n * 2, 0]"
        ));

        expect(expression).toMatchObject({
            kind: NodeKind.ArrayLiteral,
            elements: [
                { kind: NodeKind.IntLiteral, value: 1 },
                {
                    kind: NodeKind.SpreadExpression,
                    comprehensionElement: true,
                    argument: {
                        kind: NodeKind.ArrayComprehension,
                        iterationKind: "in",
                        iterator: { kind: NodeKind.Identifier, name: "n" },
                        body: { kind: NodeKind.Identifier, name: "n" }
                    }
                },
                {
                    kind: NodeKind.SpreadExpression,
                    argument: { kind: NodeKind.Identifier, name: "items" }
                },
                {
                    kind: NodeKind.SpreadExpression,
                    comprehensionElement: true,
                    argument: {
                        kind: NodeKind.ArrayComprehension,
                        body: {
                            kind: NodeKind.BinaryExpression,
                            operator: "*"
                        }
                    }
                },
                { kind: NodeKind.IntLiteral, value: 0 }
            ]
        });
    });

    it("parses if expressions as array comprehension bodies", () => {
        expect(parseExpression(tokenizeReader(
            "[for (n in 0 ... 9) if (n % 2 == 0) n else n * 3]"
        ))).toMatchObject({
            kind: NodeKind.ArrayComprehension,
            body: {
                kind: NodeKind.IfStatement,
                thenBranch: {
                    kind: NodeKind.ExprStatement,
                    expression: { kind: NodeKind.Identifier, name: "n" }
                },
                elseBranch: {
                    kind: NodeKind.ExprStatement,
                    expression: { kind: NodeKind.BinaryExpression, operator: "*" }
                }
            }
        });

        expect(parseExpression(tokenizeReader(
            "[for (n in 0 ... 9) if (n % 2 == 0) n]"
        ))).toMatchObject({
            kind: NodeKind.ArrayComprehension,
            body: {
                kind: NodeKind.IfStatement,
                thenBranch: {
                    kind: NodeKind.ExprStatement,
                    expression: { kind: NodeKind.Identifier, name: "n" }
                }
            }
        });
    });

    it("parses trailing and consecutive conditional comprehensions", () => {
        expect(parseExpression(tokenizeReader(
            "[for (n in 0 ... 9) n,]"
        ))).toMatchObject({
            kind: NodeKind.ArrayLiteral,
            elements: [{
                kind: NodeKind.SpreadExpression,
                comprehensionElement: true,
                argument: { kind: NodeKind.ArrayComprehension }
            }]
        });

        expect(parseExpression(tokenizeReader(`[
            for (n in 0 ... 9) if (n % 2 == 0) n else n * 3,
            for (n in 0 ... 9) if (n % 2 == 0) n,
        ]`))).toMatchObject({
            kind: NodeKind.ArrayLiteral,
            elements: [
                {
                    kind: NodeKind.SpreadExpression,
                    comprehensionElement: true,
                    argument: {
                        kind: NodeKind.ArrayComprehension,
                        body: { kind: NodeKind.IfStatement, elseBranch: { kind: NodeKind.ExprStatement } }
                    }
                },
                {
                    kind: NodeKind.SpreadExpression,
                    comprehensionElement: true,
                    argument: {
                        kind: NodeKind.ArrayComprehension,
                        body: { kind: NodeKind.IfStatement }
                    }
                }
            ]
        });
    });

    it("builds an AST for object literals", () => {
        expect(parseExpression(tokenizeReader("{a: 1, b: 2}"))).toEqual({
            kind: NodeKind.ObjectLiteral,
            properties: [
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "a" },
                    value: { kind: NodeKind.IntLiteral, value: 1 }
                },
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "b" },
                    value: { kind: NodeKind.IntLiteral, value: 2 }
                }
            ]
        });
    });

    it("builds an AST for object method literals", () => {
        const expr = parseExpression(tokenizeReader("{add(a: number, b: number): number { return a + b }, [name]() { return 1 }}"));
        expect(expr).toMatchObject({
            kind: NodeKind.ObjectLiteral,
            properties: [
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "add" },
                    method: true,
                    value: {
                        kind: NodeKind.FunctionExpression,
                        name: { kind: NodeKind.Identifier, name: "add" },
                        parameters: [
                            { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "a" }, typeAnnotation: { kind: NodeKind.Identifier, name: "number" } },
                            { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "b" }, typeAnnotation: { kind: NodeKind.Identifier, name: "number" } }
                        ],
                        returnType: { kind: NodeKind.Identifier, name: "number" }
                    }
                },
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "name" },
                    computed: true,
                    method: true,
                    value: { kind: NodeKind.FunctionExpression }
                }
            ]
        });
    });

    it("builds an AST for object accessors and generic methods", () => {
        const expr = parseExpression(
            tokenizeReader("{ get value() { return current }, set value(next: number) { current = next }, async load() { return current }, spyOn<T>(obj: T) { return obj } }", { jsx: false }),
            { language: "typescript" }
        );
        expect(expr).toMatchObject({
            kind: NodeKind.ObjectLiteral,
            properties: [
                { kind: NodeKind.ObjectProperty, method: true },
                { kind: NodeKind.ObjectProperty, method: true },
                {
                    kind: NodeKind.ObjectProperty,
                    method: true,
                    value: { kind: NodeKind.FunctionExpression, async: true }
                },
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "spyOn" },
                    method: true,
                    value: {
                        kind: NodeKind.FunctionExpression,
                        parameters: [{ kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "obj" } }]
                    }
                }
            ]
        });
    });

    it("builds an AST for shorthand, spread, computed, and trailing-comma object literals", () => {
        expect(parseExpression(tokenizeReader('{a, ...base, [key]: value, "display name": name, 1: one,}'))).toEqual({
            kind: NodeKind.ObjectLiteral,
            trailingComma: true,
            properties: [
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "a" },
                    value: { kind: NodeKind.Identifier, name: "a" },
                    shorthand: true
                },
                {
                    kind: NodeKind.ObjectSpreadProperty,
                    argument: { kind: NodeKind.Identifier, name: "base" }
                },
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.Identifier, name: "key" },
                    value: { kind: NodeKind.Identifier, name: "value" },
                    computed: true
                },
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.StringLiteral, value: "display name" },
                    value: { kind: NodeKind.Identifier, name: "name" }
                },
                {
                    kind: NodeKind.ObjectProperty,
                    key: { kind: NodeKind.IntLiteral, value: 1 },
                    value: { kind: NodeKind.Identifier, name: "one" }
                }
            ]
        });
    });

    it("builds an AST for chained member/index access", () => {
        expect(parseExpression(tokenizeReader("a.b[1].c"))).toEqual({
            kind: NodeKind.MemberExpression,
            object: {
                kind: NodeKind.MemberExpression,
                object: {
                    kind: NodeKind.MemberExpression,
                    object: { kind: NodeKind.Identifier, name: "a" },
                    property: { kind: NodeKind.Identifier, name: "b" },
                    computed: false
                },
                property: { kind: NodeKind.IntLiteral, value: 1 },
                computed: true
            },
            property: { kind: NodeKind.Identifier, name: "c" },
            computed: false
        });
    });

    it("builds an AST for property reference expressions", () => {
        expect(parseExpression(tokenizeReader("view::x[0, 100]"))).toEqual({
            kind: NodeKind.MemberExpression,
            object: {
                kind: NodeKind.PropertyReferenceExpression,
                object: { kind: NodeKind.Identifier, name: "view" },
                property: { kind: NodeKind.Identifier, name: "x" }
            },
            property: {
                kind: NodeKind.CommaExpression,
                expressions: [
                    { kind: NodeKind.IntLiteral, value: 0 },
                    { kind: NodeKind.IntLiteral, value: 100 }
                ]
            },
            computed: true
        });
    });

    it("parses private member access", () => {
        expect(parseExpression(tokenizeReader("this.#value"), { language: "typescript" })).toEqual({
            kind: NodeKind.MemberExpression,
            object: { kind: NodeKind.Identifier, name: "this" },
            property: { kind: NodeKind.Identifier, name: "#value" },
            computed: false
        });
    });

    it("builds an AST for safe and non-null member access", () => {
        expect(parseExpression(tokenizeReader("a?.b!.c"))).toEqual({
            kind: NodeKind.MemberExpression,
            object: {
                kind: NodeKind.MemberExpression,
                object: { kind: NodeKind.Identifier, name: "a" },
                property: { kind: NodeKind.Identifier, name: "b" },
                computed: false,
                optional: true
            },
            property: { kind: NodeKind.Identifier, name: "c" },
            computed: false,
            nonNullAsserted: true
        });
    });

    it("parses receiver blocks after direct non-null assertions", () => {
        expect(parseExpression(tokenizeReader('canvas.getContext("2d")!. { fillStyle = "#f4f8fc" }'))).toMatchObject({
            kind: NodeKind.CallExpression,
            receiverBlockShorthand: true,
            callee: {
                kind: NodeKind.NonNullExpression,
                expression: { kind: NodeKind.CallExpression }
            },
            args: [{ kind: NodeKind.ArrowFunctionExpression, body: { kind: NodeKind.AssignmentExpression } }]
        });
    });

    it("parses optional receiver blocks", () => {
        expect(parseExpression(tokenizeReader('canvas.getContext("2d")?. { fillStyle = "#f4f8fc" }'))).toMatchObject({
            kind: NodeKind.CallExpression,
            optional: true,
            receiverBlockShorthand: true,
            callee: { kind: NodeKind.CallExpression },
            args: [{ kind: NodeKind.ArrowFunctionExpression, body: { kind: NodeKind.AssignmentExpression } }]
        });
    });

    it("builds an AST for mixed safe access and computed member access", () => {
        expect(parseExpression(tokenizeReader("b?.c[\"d\"]"))).toEqual({
            kind: NodeKind.MemberExpression,
            object: {
                kind: NodeKind.MemberExpression,
                object: { kind: NodeKind.Identifier, name: "b" },
                property: { kind: NodeKind.Identifier, name: "c" },
                computed: false,
                optional: true
            },
            property: { kind: NodeKind.StringLiteral, value: "d" },
            computed: true
        });
    });

    it("builds an AST for chained member access with function call", () => {
        expect(parseExpression(tokenizeReader("hello.world[0].test(arg1, arg2)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: {
                kind: NodeKind.MemberExpression,
                object: {
                    kind: NodeKind.MemberExpression,
                    object: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "hello" },
                        property: { kind: NodeKind.Identifier, name: "world" },
                        computed: false
                    },
                    property: { kind: NodeKind.IntLiteral, value: 0 },
                    computed: true
                },
                property: { kind: NodeKind.Identifier, name: "test" },
                computed: false
            },
            args: [
                { kind: NodeKind.Identifier, name: "arg1" },
                { kind: NodeKind.Identifier, name: "arg2" }
            ]
        });
    });

    it("builds an AST for generic call expressions", () => {
        expect(parseExpression(tokenizeReader("factory<string, number>(arg1)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "factory" },
            args: [{ kind: NodeKind.Identifier, name: "arg1" }],
            typeArguments: [
                { kind: NodeKind.Identifier, name: "string" },
                { kind: NodeKind.Identifier, name: "number" }
            ]
        });
    });

    it("parses nullable generic call type arguments", () => {
        expect(parseExpression(tokenizeReader("createContext<CounterContextValue?>(undefined)"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "createContext" },
            args: [{ kind: NodeKind.UndefinedLiteral }],
            typeArguments: [
                { kind: NodeKind.Identifier, name: "CounterContextValue?" }
            ]
        });
        expect(parseExpression(tokenizeReader("createContext<Array<CounterContextValue?>>(undefined)"))).toMatchObject({
            kind: NodeKind.CallExpression,
            typeArguments: [
                { kind: NodeKind.Identifier, name: "Array<CounterContextValue?>" }
            ]
        });
    });

    it("builds an AST for TypeScript-style arrow functions in call arguments", () => {
        expect(parseExpression(tokenizeReader("[1,2,3,4].map(a => 10)"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "a" }
                        }
                    ],
                    body: { kind: NodeKind.IntLiteral, value: 10 }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map((it) => 10)"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "it" }
                        }
                    ],
                    body: { kind: NodeKind.IntLiteral, value: 10 }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map((a, b, c) => a + b + c)"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "a" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "b" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "c" } }
                    ],
                    body: {
                        kind: NodeKind.BinaryExpression,
                        operator: "+",
                        left: {
                            kind: NodeKind.BinaryExpression,
                            operator: "+",
                            left: { kind: NodeKind.Identifier, name: "a" },
                            right: { kind: NodeKind.Identifier, name: "b" }
                        },
                        right: { kind: NodeKind.Identifier, name: "c" }
                    }
                }
            ]
        });
    });

    it("builds an AST for TypeScript-style function expressions in call arguments", () => {
        expect(parseExpression(tokenizeReader("[1,2,3,4].map(function(it: number) { return 10 })"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.FunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "it" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        }
                    ],
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: { kind: NodeKind.IntLiteral, value: 10 }
                            }
                        ]
                    }
                }
            ]
        });

        expect(
            parseExpression(tokenizeReader("[1,2,3,4].map(function(a: number, b: number, c: number) { return 10 })"))
        ).toEqual({
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
            args: [
                {
                    kind: NodeKind.FunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "a" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "b" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "c" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        }
                    ],
                    body: {
                        kind: NodeKind.BlockStatement,
                        body: [
                            {
                                kind: NodeKind.ReturnStatement,
                                expression: { kind: NodeKind.IntLiteral, value: 10 }
                            }
                        ]
                    }
                }
            ]
        });
    });

    it("parses arrow functions with an explicit return type", () => {
        expect(parseExpression(tokenizeReader("(node: Node): void => node", { jsx: false }), { language: "typescript" })).toEqual({
            kind: NodeKind.ArrowFunctionExpression,
            parameters: [
                {
                    kind: NodeKind.FunctionParameter,
                    name: { kind: NodeKind.Identifier, name: "node" },
                    typeAnnotation: { kind: NodeKind.Identifier, name: "Node" }
                }
            ],
            returnType: { kind: NodeKind.Identifier, name: "void" },
            body: { kind: NodeKind.Identifier, name: "node" }
        });
    });

    it("parses tagged template expressions as call-like expressions", () => {
        expect(parseExpression(tokenizeReader("dedent`hello`"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: { kind: NodeKind.Identifier, name: "dedent" },
            args: [{ kind: NodeKind.StringLiteral, value: "hello" }]
        });
    });

    it("builds an AST for Kotlin/Swift-style tail lambdas", () => {
        expect(parseExpression(tokenizeReader("[1,2,3,4].map { it }"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "it" }
                        }
                    ],
                    body: { kind: NodeKind.Identifier, name: "it" }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map() { it }"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "it" }
                        }
                    ],
                    body: { kind: NodeKind.Identifier, name: "it" }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map { a, b, c -> a + b + c }"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "a" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "b" } },
                        { kind: NodeKind.FunctionParameter, name: { kind: NodeKind.Identifier, name: "c" } }
                    ],
                    body: {
                        kind: NodeKind.BinaryExpression,
                        operator: "+",
                        left: {
                            kind: NodeKind.BinaryExpression,
                            operator: "+",
                            left: { kind: NodeKind.Identifier, name: "a" },
                            right: { kind: NodeKind.Identifier, name: "b" }
                        },
                        right: { kind: NodeKind.Identifier, name: "c" }
                    }
                }
            ]
        });

        expect(parseExpression(tokenizeReader("[1,2,3,4].map { a: number, b: number, c: number -> a + b + c }"))).toEqual({
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
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "a" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "b" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "c" },
                            typeAnnotation: { kind: NodeKind.Identifier, name: "number" }
                        }
                    ],
                    body: {
                        kind: NodeKind.BinaryExpression,
                        operator: "+",
                        left: {
                            kind: NodeKind.BinaryExpression,
                            operator: "+",
                            left: { kind: NodeKind.Identifier, name: "a" },
                            right: { kind: NodeKind.Identifier, name: "b" }
                        },
                        right: { kind: NodeKind.Identifier, name: "c" }
                    }
                }
            ]
        });

        const multiStatement = parseExpression(
            tokenizeReader("new Promise({ resolve, reject ->\n  setTimeout(resolve, 1)\n  setTimeout(reject, 2)\n})")
        ) as any;
        const lambda = multiStatement.args[0];
        expect(lambda.kind).toBe(NodeKind.ArrowFunctionExpression);
        expect(lambda.parameters.map((parameter: any) => parameter.name.name)).toEqual([
            "resolve",
            "reject"
        ]);
        expect(lambda.body.kind).toBe(NodeKind.BlockStatement);
        expect(lambda.body.body.length).toBe(2);
        expect(lambda.body.body[0].kind).toBe(NodeKind.ExprStatement);
        expect(lambda.body.body[1].kind).toBe(NodeKind.ReturnStatement);
        expect(lambda.body.body[1].expression.kind).toBe(NodeKind.CallExpression);

        const implicitItBlock = parseExpression(
            tokenizeReader("[1,2,3].map {\n  const doubled = it * 2\n  doubled + 1\n}")
        ) as any;
        const implicitItLambda = implicitItBlock.args[0];
        expect(implicitItLambda.parameters.map((parameter: any) => parameter.name.name)).toEqual(["it"]);
        expect(implicitItLambda.body.kind).toBe(NodeKind.BlockStatement);
        expect(implicitItLambda.body.body.map((statement: any) => statement.kind)).toEqual([
            NodeKind.VarStatement,
            NodeKind.ReturnStatement
        ]);
        expect(implicitItLambda.body.body[1].expression.kind).toBe(NodeKind.BinaryExpression);

        const braceLambdaInExpressionPosition = parseExpression(
            tokenizeReader("useEffect({ val timeout = schedule({ count++ }, 1000)\nreturn { clearTimeout(timeout) }\n}, [count])")
        ) as any;
        const effectLambda = braceLambdaInExpressionPosition.args[0];
        expect(effectLambda.kind).toBe(NodeKind.ArrowFunctionExpression);
        expect(effectLambda.body.kind).toBe(NodeKind.BlockStatement);
        expect(effectLambda.body.body.map((statement: any) => statement.kind)).toEqual([
            NodeKind.VarStatement,
            NodeKind.ReturnStatement
        ]);
        expect(effectLambda.body.body[0].initializer.args[0].kind).toBe(NodeKind.ArrowFunctionExpression);
        expect(effectLambda.body.body[1].expression.kind).toBe(NodeKind.ArrowFunctionExpression);
    });

    it("parses receiver-block shorthand and labeled this expressions", () => {
        const expression = parseExpression(tokenizeReader(
            "Point(10, 20). { demo { this@demo.x = 20; this@apply.y = 30 } }"
        )) as any;

        expect(expression).toMatchObject({
            kind: NodeKind.CallExpression,
            receiverBlockShorthand: true,
            callee: { kind: NodeKind.CallExpression }
        });
        const outerLambda = expression.args[0];
        const nestedCall = outerLambda.body.kind === NodeKind.BlockStatement
            ? outerLambda.body.body[0].expression
            : outerLambda.body;
        expect(nestedCall.args[0].body.body[0].expression.left.object).toMatchObject({
            kind: NodeKind.Identifier,
            name: "this",
            receiverLabel: "demo"
        });
        expect(nestedCall.args[0].body.body[1].expression.left.object).toMatchObject({
            kind: NodeKind.Identifier,
            name: "this",
            receiverLabel: "apply"
        });
    });

    it("builds an AST for new expression variants", () => {
        expect(parseExpression(tokenizeReader("new instance()"))).toEqual({
            kind: NodeKind.NewExpression,
            callee: { kind: NodeKind.Identifier, name: "instance" },
            args: []
        });

        expect(parseExpression(tokenizeReader("new instance"))).toEqual({
            kind: NodeKind.NewExpression,
            callee: { kind: NodeKind.Identifier, name: "instance" }
        });

        expect(parseExpression(tokenizeReader("new hello.world[0].test(arg1, arg2)"))).toEqual({
            kind: NodeKind.NewExpression,
            callee: {
                kind: NodeKind.MemberExpression,
                object: {
                    kind: NodeKind.MemberExpression,
                    object: {
                        kind: NodeKind.MemberExpression,
                        object: { kind: NodeKind.Identifier, name: "hello" },
                        property: { kind: NodeKind.Identifier, name: "world" },
                        computed: false
                    },
                    property: { kind: NodeKind.IntLiteral, value: 0 },
                    computed: true
                },
                property: { kind: NodeKind.Identifier, name: "test" },
                computed: false
            },
            args: [
                { kind: NodeKind.Identifier, name: "arg1" },
                { kind: NodeKind.Identifier, name: "arg2" }
            ]
        });

        expect(parseExpression(tokenizeReader("new Map<string, string>()"))).toEqual({
            kind: NodeKind.NewExpression,
            callee: { kind: NodeKind.Identifier, name: "Map" },
            args: [],
            typeArguments: [
                { kind: NodeKind.Identifier, name: "string" },
                { kind: NodeKind.Identifier, name: "string" }
            ]
        });

        expect(parseExpression(tokenizeReader("new Date(value).toLocaleTimeString()"))).toEqual({
            kind: NodeKind.CallExpression,
            callee: {
                kind: NodeKind.MemberExpression,
                object: {
                    kind: NodeKind.NewExpression,
                    callee: { kind: NodeKind.Identifier, name: "Date" },
                    args: [{ kind: NodeKind.Identifier, name: "value" }]
                },
                property: { kind: NodeKind.Identifier, name: "toLocaleTimeString" },
                computed: false
            },
            args: []
        });

        expect(parseExpression(tokenizeReader("new Promise { resolve, reject -> resolve(123) }"))).toEqual({
            kind: NodeKind.NewExpression,
            callee: { kind: NodeKind.Identifier, name: "Promise" },
            args: [
                {
                    kind: NodeKind.ArrowFunctionExpression,
                    parameters: [
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "resolve" }
                        },
                        {
                            kind: NodeKind.FunctionParameter,
                            name: { kind: NodeKind.Identifier, name: "reject" }
                        }
                    ],
                    body: {
                        kind: NodeKind.CallExpression,
                        callee: { kind: NodeKind.Identifier, name: "resolve" },
                        args: [{ kind: NodeKind.IntLiteral, value: 123 }]
                    }
                }
            ]
        });
    });

    it("treats a trailing comma after shorthand object members as an object literal, not a brace lambda", () => {
        expect(parseExpression(tokenizeReader("new Text({ width, })"))).toEqual({
            kind: NodeKind.NewExpression,
            callee: { kind: NodeKind.Identifier, name: "Text" },
            args: [
                {
                    kind: NodeKind.ObjectLiteral,
                    trailingComma: true,
                    properties: [
                        {
                            kind: NodeKind.ObjectProperty,
                            key: { kind: NodeKind.Identifier, name: "width" },
                            value: { kind: NodeKind.Identifier, name: "width" },
                            shorthand: true
                        }
                    ]
                }
            ]
        });
    });

    it("keeps singleton shorthand braces as object literals in TypeScript mode", () => {
        expect(parseExpression(tokenizeReader("condition ? { value } : {}"), { language: "typescript" })).toMatchObject({
            kind: NodeKind.ConditionalExpression,
            consequent: {
                kind: NodeKind.ObjectLiteral,
                properties: [{ kind: NodeKind.ObjectProperty, shorthand: true }]
            }
        });
    });

    it("builds an AST for multiplication with parenthesized addition", () => {
        expect(parseExpression(tokenizeReader("1*(2+3)"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "*",
            left: { kind: NodeKind.IntLiteral, value: 1 },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.IntLiteral, value: 2 },
                right: { kind: NodeKind.IntLiteral, value: 3 }
            }
        });
    });

    it("applies precedence for subtraction, division, and modulo", () => {
        expect(parseExpression(tokenizeReader("10-6/3%2"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "-",
            left: { kind: NodeKind.IntLiteral, value: 10 },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "%",
                left: {
                    kind: NodeKind.BinaryExpression,
                    operator: "/",
                    left: { kind: NodeKind.IntLiteral, value: 6 },
                    right: { kind: NodeKind.IntLiteral, value: 3 }
                },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("parses exponentiation as right-associative", () => {
        expect(parseExpression(tokenizeReader("2**3**2"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "**",
            left: { kind: NodeKind.IntLiteral, value: 2 },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "**",
                left: { kind: NodeKind.IntLiteral, value: 3 },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            }
        });
    });

    it("applies precedence for bitwise operators", () => {
        expect(parseExpression(tokenizeReader("1|2^3&4"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "|",
            left: { kind: NodeKind.IntLiteral, value: 1 },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "^",
                left: { kind: NodeKind.IntLiteral, value: 2 },
                right: {
                    kind: NodeKind.BinaryExpression,
                    operator: "&",
                    left: { kind: NodeKind.IntLiteral, value: 3 },
                    right: { kind: NodeKind.IntLiteral, value: 4 }
                }
            }
        });
    });

    it("applies precedence for logical and bitwise operators", () => {
        expect(parseExpression(tokenizeReader("1||2&&3|4"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "||",
            left: { kind: NodeKind.IntLiteral, value: 1 },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "&&",
                left: { kind: NodeKind.IntLiteral, value: 2 },
                right: {
                    kind: NodeKind.BinaryExpression,
                    operator: "|",
                    left: { kind: NodeKind.IntLiteral, value: 3 },
                    right: { kind: NodeKind.IntLiteral, value: 4 }
                }
            }
        });
    });

    it("parses nullish coalescing with logical precedence", () => {
        expect(parseExpression(tokenizeReader("a ?? b || c && d"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "||",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "??",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.Identifier, name: "b" }
            },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "&&",
                left: { kind: NodeKind.Identifier, name: "c" },
                right: { kind: NodeKind.Identifier, name: "d" }
            }
        });
    });

    it("applies precedence for shift and relational operators", () => {
        expect(parseExpression(tokenizeReader("1 + 2 << 3 < 4"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "<",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "<<",
                left: {
                    kind: NodeKind.BinaryExpression,
                    operator: "+",
                    left: { kind: NodeKind.IntLiteral, value: 1 },
                    right: { kind: NodeKind.IntLiteral, value: 2 }
                },
                right: { kind: NodeKind.IntLiteral, value: 3 }
            },
            right: { kind: NodeKind.IntLiteral, value: 4 }
        });

        expect(parseExpression(tokenizeReader("1 < 2 <= 3"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "<=",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "<",
                left: { kind: NodeKind.IntLiteral, value: 1 },
                right: { kind: NodeKind.IntLiteral, value: 2 }
            },
            right: { kind: NodeKind.IntLiteral, value: 3 }
        });

        expect(parseExpression(tokenizeReader("a in b instanceof c"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "instanceof",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "in",
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.Identifier, name: "b" }
            },
            right: { kind: NodeKind.Identifier, name: "c" }
        });
    });

    it("applies precedence for equality over bitwise and under relational", () => {
        expect(parseExpression(tokenizeReader("1 < 2 == 3 != 4 === 5 !== 6 & 7"))).toEqual({
            kind: NodeKind.BinaryExpression,
            operator: "&",
            left: {
                kind: NodeKind.BinaryExpression,
                operator: "!==",
                left: {
                    kind: NodeKind.BinaryExpression,
                    operator: "===",
                    left: {
                        kind: NodeKind.BinaryExpression,
                        operator: "!=",
                        left: {
                            kind: NodeKind.BinaryExpression,
                            operator: "==",
                            left: {
                                kind: NodeKind.BinaryExpression,
                                operator: "<",
                                left: { kind: NodeKind.IntLiteral, value: 1 },
                                right: { kind: NodeKind.IntLiteral, value: 2 }
                            },
                            right: { kind: NodeKind.IntLiteral, value: 3 }
                        },
                        right: { kind: NodeKind.IntLiteral, value: 4 }
                    },
                    right: { kind: NodeKind.IntLiteral, value: 5 }
                },
                right: { kind: NodeKind.IntLiteral, value: 6 }
            },
            right: { kind: NodeKind.IntLiteral, value: 7 }
        });
    });

    it("parses all requested compound assignment operators", () => {
        const operators = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "^=", "&&=", "||=", "??=", "<<=", ">>=", ">>>="] as const;

        for (const operator of operators) {
            expect(parseExpression(tokenizeReader(`a ${operator} 1
`))).toEqual({
                kind: NodeKind.AssignmentExpression,
                operator,
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            });
        }
    });

    it("parses all requested shift operators", () => {
        const operators = ["<<", ">>", ">>>"] as const;

        for (const operator of operators) {
            expect(parseExpression(tokenizeReader(`a ${operator} 1
`))).toEqual({
                kind: NodeKind.BinaryExpression,
                operator,
                left: { kind: NodeKind.Identifier, name: "a" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            });
        }
    });

    it("parses '=' assignment expression", () => {
        expect(parseExpression(tokenizeReader("a = b + 1"))).toEqual({
            kind: NodeKind.AssignmentExpression,
            operator: "=",
            left: { kind: NodeKind.Identifier, name: "a" },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "+",
                left: { kind: NodeKind.Identifier, name: "b" },
                right: { kind: NodeKind.IntLiteral, value: 1 }
            }
        });
    });

    it("parses compound assignment as right-associative", () => {
        expect(parseExpression(tokenizeReader("a += b *= c"))).toEqual({
            kind: NodeKind.AssignmentExpression,
            operator: "+=",
            left: { kind: NodeKind.Identifier, name: "a" },
            right: {
                kind: NodeKind.AssignmentExpression,
                operator: "*=",
                left: { kind: NodeKind.Identifier, name: "b" },
                right: { kind: NodeKind.Identifier, name: "c" }
            }
        });
    });

    it("parses logical expressions on the right side of assignment", () => {
        expect(parseExpression(tokenizeReader("a ||= b && c"))).toEqual({
            kind: NodeKind.AssignmentExpression,
            operator: "||=",
            left: { kind: NodeKind.Identifier, name: "a" },
            right: {
                kind: NodeKind.BinaryExpression,
                operator: "&&",
                left: { kind: NodeKind.Identifier, name: "b" },
                right: { kind: NodeKind.Identifier, name: "c" }
            }
        });
    });

    it("parses ternary conditional expressions as right-associative", () => {
        expect(parseExpression(tokenizeReader("a ? b : c ? d : e"))).toEqual({
            kind: NodeKind.ConditionalExpression,
            test: { kind: NodeKind.Identifier, name: "a" },
            consequent: { kind: NodeKind.Identifier, name: "b" },
            alternate: {
                kind: NodeKind.ConditionalExpression,
                test: { kind: NodeKind.Identifier, name: "c" },
                consequent: { kind: NodeKind.Identifier, name: "d" },
                alternate: { kind: NodeKind.Identifier, name: "e" }
            }
        });
    });

    it("keeps commas after an array if element as array separators", () => {
        expect(parseExpression(tokenizeReader("[1, if (false) 2, 3]"))).toMatchObject({
            kind: NodeKind.ArrayLiteral,
            elements: [
                { kind: NodeKind.IntLiteral, value: 1 },
                {
                    kind: NodeKind.IfStatement,
                    condition: { kind: NodeKind.BooleanLiteral, value: false },
                    thenBranch: {
                        kind: NodeKind.ExprStatement,
                        expression: { kind: NodeKind.IntLiteral, value: 2 }
                    },
                    elseBranch: undefined
                },
                { kind: NodeKind.IntLiteral, value: 3 }
            ]
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
