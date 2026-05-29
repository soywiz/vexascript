import { describe, expect, it } from "vitest";
import { parseExpression } from "./parser";
import { tokenizeReader } from "./tokenizer";

describe("parseExpression", () => {
    it("builds an AST for a single literal", () => {
        expect(parseExpression(tokenizeReader("10"))).toEqual(
            { kind: "IntLiteral", value: 10 }
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
})
