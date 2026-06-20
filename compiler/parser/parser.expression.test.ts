import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { ParseError, parseExpression, parseFile, parseProgram } from "./parser";
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
        expect(parseExpression(tokenizeReader("0."))).toEqual(
            { kind: "FloatLiteral", value: 0 }
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

    it("parses anonymous interface call signatures in TypeScript declarations", () => {
        const ast = parseFile(
            tokenizeReader("interface BigIntConstructor {\n  (value: bigint | boolean | number | string): bigint;\n}"),
            { language: "typescript" }
        );

        expect(ast.body[0]).toMatchObject({
            kind: "InterfaceStatement",
            name: { name: "BigIntConstructor" },
            members: [
                {
                    kind: "InterfaceMethodMember",
                    name: { name: "call" },
                    parameters: [
                        {
                            name: { kind: "Identifier", name: "value" },
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
            kind: "InterfaceStatement",
            name: { name: "Renderer" },
            members: [
                {
                    kind: "InterfaceMethodMember",
                    name: { name: "call" },
                    typeParameters: [
                        {
                            kind: "TypeParameter",
                            name: { kind: "Identifier", name: "P" }
                        }
                    ],
                    parameters: [
                        {
                            name: { kind: "Identifier", name: "element" },
                            typeAnnotation: { name: "ReactElement<P>" }
                        },
                        {
                            name: { kind: "Identifier", name: "container" },
                            typeAnnotation: { name: "Container | null" }
                        }
                    ],
                    returnType: { kind: "Identifier", name: "P | void" }
                }
            ]
        });
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

    it("parses named class expressions", () => {
        expect(parseExpression(tokenizeReader("class Widget extends Base {}"), { language: "typescript" })).toMatchObject({
            kind: "ClassExpression",
            name: { kind: "Identifier", name: "Widget" },
            extendsType: { kind: "Identifier", name: "Base" },
            members: []
        });
    });

    it("parses async single-parameter arrow functions without parentheses", () => {
        expect(parseExpression(tokenizeReader("async f => f + 1"), { language: "typescript" })).toMatchObject({
            kind: "ArrowFunctionExpression",
            async: true,
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "f" }
                }
            ],
            body: {
                kind: "BinaryExpression",
                operator: "+"
            }
        });
    });

    it("parses computed class fields in class expressions", () => {
        expect(parseExpression(tokenizeReader("class Browser { [PropertySymbol.exceptionObserver] = null; }"), { language: "typescript" })).toMatchObject({
            kind: "ClassExpression",
            members: [
                {
                    kind: "ClassFieldMember",
                    computed: true,
                    computedKey: {
                        kind: "MemberExpression"
                    },
                    initializer: { kind: "NullLiteral" }
                }
            ]
        });
    });

    it("parses anonymous export default function and class expressions in TypeScript mode", () => {
        const functionAst = parseFile(tokenizeReader("export default function () { return 7; }"), { language: "typescript" });
        expect(functionAst.body[0]).toMatchObject({
            kind: "ExportStatement",
            default: true,
            declaration: {
                kind: "ExprStatement",
                expression: {
                    kind: "FunctionExpression",
                    body: {
                        kind: "BlockStatement"
                    }
                }
            }
        });

        const classAst = parseFile(tokenizeReader("export default class extends Base {}"), { language: "typescript" });
        expect(classAst.body[0]).toMatchObject({
            kind: "ExportStatement",
            default: true,
            declaration: {
                kind: "ExprStatement",
                expression: {
                    kind: "ClassExpression",
                    extendsType: { kind: "Identifier", name: "Base" },
                    members: []
                }
            }
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

    it("builds an AST for empty template interpolation via a missing-expression placeholder", () => {
        expect(parseExpression(tokenizeReader("`${}`"))).toEqual({
            kind: "BinaryExpression",
            operator: "+",
            left: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "StringLiteral", value: "" },
                right: { kind: "MissingExpression" }
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

    it("accepts trailing commas in call argument lists", () => {
        expect(parseExpression(tokenizeReader("fn(a, b,)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "fn" },
            arguments: [
                { kind: "Identifier", name: "a" },
                { kind: "Identifier", name: "b" }
            ]
        });
    });

    it("keeps parsing call argument lists with empty slots between commas", () => {
        expect(parseExpression(tokenizeReader("fn(a,,b)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "fn" },
            arguments: [
                { kind: "Identifier", name: "a" },
                { kind: "MissingExpression" },
                { kind: "Identifier", name: "b" }
            ]
        });
    });

    it("parses named call arguments as NamedArgument nodes", () => {
        expect(parseExpression(tokenizeReader('fetch(url: "https://hello.world")'))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "fetch" },
            arguments: [
                {
                    kind: "NamedArgument",
                    name: { kind: "Identifier", name: "url" },
                    value: { kind: "StringLiteral", value: "https://hello.world" }
                }
            ]
        });
    });

    it("parses annotation declarations with parameter properties", () => {
        const program = parseFile(tokenizeReader("annotation JsName(val name: string)"));

        expect(program.body[0]).toMatchObject({
            kind: "AnnotationStatement",
            name: { kind: "Identifier", name: "JsName" },
            parameters: [
                {
                    kind: "FunctionParameter",
                    accessModifier: "public",
                    readonly: true,
                    name: { kind: "Identifier", name: "name" },
                    typeAnnotation: { kind: "Identifier", name: "string" }
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
            kind: "AnnotationStatement",
            name: { kind: "Identifier", name: "DemoAnnotation" },
            parameters: []
        });
        expect(program.body[1]).toMatchObject({
            kind: "FunctionStatement",
            name: { kind: "Identifier", name: "demo" },
            annotations: [
                {
                    kind: "AnnotationApplication",
                    name: { kind: "Identifier", name: "DemoAnnotation" },
                    arguments: []
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
            kind: "FunctionStatement",
            name: { kind: "Identifier", name: "color" },
            jsName: "rgba",
            annotations: [
                {
                    kind: "AnnotationApplication",
                    name: { kind: "Identifier", name: "JsName" },
                    arguments: [{ kind: "StringLiteral", value: "rgba" }]
                }
            ]
        });
    });

    it("parses a mix of positional and named call arguments", () => {
        expect(parseExpression(tokenizeReader("connect(host, port: 8080)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "connect" },
            arguments: [
                { kind: "Identifier", name: "host" },
                {
                    kind: "NamedArgument",
                    name: { kind: "Identifier", name: "port" },
                    value: { kind: "IntLiteral", value: 8080 }
                }
            ]
        });
    });

    it("does not treat a ternary argument as a named argument", () => {
        expect(parseExpression(tokenizeReader("fn(cond ? a : b)"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "fn" },
            arguments: [
                {
                    kind: "ConditionalExpression",
                    test: { kind: "Identifier", name: "cond" },
                    consequent: { kind: "Identifier", name: "a" },
                    alternate: { kind: "Identifier", name: "b" }
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

    it("builds an AST for inclusive range expressions", () => {
        expect(parseExpression(tokenizeReader("0 ... 10"))).toEqual({
            kind: "RangeExpression",
            start: { kind: "IntLiteral", value: 0 },
            end: { kind: "IntLiteral", value: 10 },
            exclusive: false
        });
    });

    it("builds an AST for exclusive range expressions", () => {
        expect(parseExpression(tokenizeReader("0 ..< 10"))).toEqual({
            kind: "RangeExpression",
            start: { kind: "IntLiteral", value: 0 },
            end: { kind: "IntLiteral", value: 10 },
            exclusive: true
        });
    });

    it("builds an AST for chain expressions", () => {
        expect(parseExpression(tokenizeReader("badge ..point = target ..beginFill(1)"))).toEqual({
            kind: "ChainExpression",
            receiver: { kind: "Identifier", name: "badge" },
            operations: [
                {
                    kind: "AssignmentExpression",
                    operator: "=",
                    left: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "badge" },
                        property: { kind: "Identifier", name: "point" },
                        computed: false
                    },
                    right: { kind: "Identifier", name: "target" }
                },
                {
                    kind: "CallExpression",
                    callee: {
                        kind: "MemberExpression",
                        object: { kind: "Identifier", name: "badge" },
                        property: { kind: "Identifier", name: "beginFill" },
                        computed: false
                    },
                    arguments: [{ kind: "IntLiteral", value: 1 }]
                }
            ]
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

    it("builds an AST for TypeScript satisfies expressions", () => {
        expect(parseExpression(tokenizeReader("value satisfies string"))).toEqual({
            kind: "SatisfiesExpression",
            expression: { kind: "Identifier", name: "value" },
            typeAnnotation: { kind: "Identifier", name: "string" }
        });
        expect(parseExpression(tokenizeReader("a + b satisfies number"))).toEqual({
            kind: "SatisfiesExpression",
            expression: {
                kind: "BinaryExpression",
                operator: "+",
                left: { kind: "Identifier", name: "a" },
                right: { kind: "Identifier", name: "b" }
            },
            typeAnnotation: { kind: "Identifier", name: "number" }
        });
    });

    it("builds an AST for TypeScript non-null assertions", () => {
        expect(parseExpression(tokenizeReader("value!"))).toEqual({
            kind: "NonNullExpression",
            expression: { kind: "Identifier", name: "value" }
        });
        expect(parseExpression(tokenizeReader("maybe!.name!"))).toEqual({
            kind: "NonNullExpression",
            expression: {
                kind: "MemberExpression",
                object: { kind: "Identifier", name: "maybe" },
                property: { kind: "Identifier", name: "name" },
                computed: false,
                nonNullAsserted: true
            }
        });
    });

    it("builds an AST for TypeScript angle-bracket assertions", () => {
        expect(parseExpression(tokenizeReader("<string>value"), { language: "typescript" })).toEqual({
            kind: "AsExpression",
            expression: { kind: "Identifier", name: "value" },
            typeAnnotation: { kind: "Identifier", name: "string" }
        });
        expect(parseExpression(tokenizeReader("<string[]>value"), { language: "typescript" })).toEqual({
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

    it("builds an AST for object accessors and generic methods", () => {
        const expr = parseExpression(
            tokenizeReader("{ get value() { return current }, set value(next: number) { current = next }, async load() { return current }, spyOn<T>(obj: T) { return obj } }", { jsx: false }),
            { language: "typescript" }
        );
        expect(expr).toMatchObject({
            kind: "ObjectLiteral",
            properties: [
                { kind: "ObjectProperty", method: true },
                { kind: "ObjectProperty", method: true },
                {
                    kind: "ObjectProperty",
                    method: true,
                    value: { kind: "FunctionExpression", async: true }
                },
                {
                    kind: "ObjectProperty",
                    key: { kind: "Identifier", name: "spyOn" },
                    method: true,
                    value: {
                        kind: "FunctionExpression",
                        parameters: [{ kind: "FunctionParameter", name: { kind: "Identifier", name: "obj" } }]
                    }
                }
            ]
        });
    });

    it("builds an AST for shorthand, spread, computed, and trailing-comma object literals", () => {
        expect(parseExpression(tokenizeReader('{a, ...base, [key]: value, "display name": name, 1: one,}'))).toEqual({
            kind: "ObjectLiteral",
            trailingComma: true,
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

    it("parses private member access", () => {
        expect(parseExpression(tokenizeReader("this.#value"), { language: "typescript" })).toEqual({
            kind: "MemberExpression",
            object: { kind: "Identifier", name: "this" },
            property: { kind: "Identifier", name: "#value" },
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

    it("parses arrow functions with an explicit return type", () => {
        expect(parseExpression(tokenizeReader("(node: Node): void => node", { jsx: false }), { language: "typescript" })).toEqual({
            kind: "ArrowFunctionExpression",
            parameters: [
                {
                    kind: "FunctionParameter",
                    name: { kind: "Identifier", name: "node" },
                    typeAnnotation: { kind: "Identifier", name: "Node" }
                }
            ],
            returnType: { kind: "Identifier", name: "void" },
            body: { kind: "Identifier", name: "node" }
        });
    });

    it("parses tagged template expressions as call-like expressions", () => {
        expect(parseExpression(tokenizeReader("dedent`hello`"))).toEqual({
            kind: "CallExpression",
            callee: { kind: "Identifier", name: "dedent" },
            arguments: [{ kind: "StringLiteral", value: "hello" }]
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

        const multiStatement = parseExpression(
            tokenizeReader("new Promise({ resolve, reject ->\n  setTimeout(resolve, 1)\n  setTimeout(reject, 2)\n})")
        ) as any;
        const lambda = multiStatement.arguments[0];
        expect(lambda.kind).toBe("ArrowFunctionExpression");
        expect(lambda.parameters.map((parameter: any) => parameter.name.name)).toEqual([
            "resolve",
            "reject"
        ]);
        expect(lambda.body.kind).toBe("BlockStatement");
        expect(lambda.body.body.length).toBe(2);
        expect(lambda.body.body[0].kind).toBe("ExprStatement");
        expect(lambda.body.body[1].kind).toBe("ReturnStatement");
        expect(lambda.body.body[1].expression.kind).toBe("CallExpression");

        const implicitItBlock = parseExpression(
            tokenizeReader("[1,2,3].map {\n  const doubled = it * 2\n  doubled + 1\n}")
        ) as any;
        const implicitItLambda = implicitItBlock.arguments[0];
        expect(implicitItLambda.parameters.map((parameter: any) => parameter.name.name)).toEqual(["it"]);
        expect(implicitItLambda.body.kind).toBe("BlockStatement");
        expect(implicitItLambda.body.body.map((statement: any) => statement.kind)).toEqual([
            "VarStatement",
            "ReturnStatement"
        ]);
        expect(implicitItLambda.body.body[1].expression.kind).toBe("BinaryExpression");

        const braceLambdaInExpressionPosition = parseExpression(
            tokenizeReader("useEffect({ val timeout = schedule({ count++ }, 1000)\nreturn { clearTimeout(timeout) }\n}, [count])")
        ) as any;
        const effectLambda = braceLambdaInExpressionPosition.arguments[0];
        expect(effectLambda.kind).toBe("ArrowFunctionExpression");
        expect(effectLambda.body.kind).toBe("BlockStatement");
        expect(effectLambda.body.body.map((statement: any) => statement.kind)).toEqual([
            "VarStatement",
            "ReturnStatement"
        ]);
        expect(effectLambda.body.body[0].initializer.arguments[0].kind).toBe("ArrowFunctionExpression");
        expect(effectLambda.body.body[1].expression.kind).toBe("ArrowFunctionExpression");
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

        expect(parseExpression(tokenizeReader("new Date(value).toLocaleTimeString()"))).toEqual({
            kind: "CallExpression",
            callee: {
                kind: "MemberExpression",
                object: {
                    kind: "NewExpression",
                    callee: { kind: "Identifier", name: "Date" },
                    arguments: [{ kind: "Identifier", name: "value" }]
                },
                property: { kind: "Identifier", name: "toLocaleTimeString" },
                computed: false
            },
            arguments: []
        });

        expect(parseExpression(tokenizeReader("new Promise { resolve, reject -> resolve(123) }"))).toEqual({
            kind: "NewExpression",
            callee: { kind: "Identifier", name: "Promise" },
            arguments: [
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "resolve" }
                        },
                        {
                            kind: "FunctionParameter",
                            name: { kind: "Identifier", name: "reject" }
                        }
                    ],
                    body: {
                        kind: "CallExpression",
                        callee: { kind: "Identifier", name: "resolve" },
                        arguments: [{ kind: "IntLiteral", value: 123 }]
                    }
                }
            ]
        });
    });

    it("treats a trailing comma after shorthand object members as an object literal, not a brace lambda", () => {
        expect(parseExpression(tokenizeReader("new Text({ width, })"))).toEqual({
            kind: "NewExpression",
            callee: { kind: "Identifier", name: "Text" },
            arguments: [
                {
                    kind: "ObjectLiteral",
                    trailingComma: true,
                    properties: [
                        {
                            kind: "ObjectProperty",
                            key: { kind: "Identifier", name: "width" },
                            value: { kind: "Identifier", name: "width" },
                            shorthand: true
                        }
                    ]
                }
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
        const operators = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "^=", "&&=", "||=", "??=", "<<=", ">>=", ">>>="] as const;

        for (const operator of operators) {
            expect(parseExpression(tokenizeReader(`a ${operator} 1
`))).toEqual({
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
            expect(parseExpression(tokenizeReader(`a ${operator} 1
`))).toEqual({
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
