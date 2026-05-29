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
