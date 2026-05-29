import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import { BinaryExpression, Expr, IntLiteral } from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"]

function buildBinary(operator: BinaryOperator, left: Expr, right: Expr): BinaryExpression {
    return {
        kind: "BinaryExpression",
        operator,
        left,
        right
    }
}

function parseLeftAssociative(
    r: ListReader<Token>,
    operators: readonly BinaryOperator[],
    parseNext: (reader: ListReader<Token>) => Expr
): Expr {
    let left = parseNext(r)

    while (r.hasMore) {
        const token = r.peek()
        if (token?.type !== "symbol" || !operators.includes(token.value as BinaryOperator)) {
            break
        }

        r.skip()
        const right = parseNext(r)
        left = buildBinary(token.value as BinaryOperator, left, right)
    }

    return left
}

function parsePrimary(r: ListReader<Token>): Expr {
    const token = r.read();

    if (token?.type === "symbol" && token.value === "(") {
        const expr = parseExpression(r);
        const close = r.read();
        if (close?.type !== "symbol" || close.value !== ")") {
            throw new Error("Expected ')' after parenthesized expression");
        }
        return expr;
    }

    if (token?.type === "number") {
        return { kind: "IntLiteral", value: parseInt(token.value, 10) } as IntLiteral;
    }

    throw new Error("Expected a number literal or '('");
}

function parseExponentiation(r: ListReader<Token>): Expr {
    const left = parsePrimary(r)
    if (r.peek()?.type === "symbol" && r.peek()?.value === "**") {
        r.skip()
        const right = parseExponentiation(r)
        return buildBinary("**", left, right)
    }
    return left
}

function parseMultiplicative(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["*", "/", "%"], parseExponentiation)
}

function parseAdditive(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["+", "-"], parseMultiplicative)
}

function parseBitwiseAnd(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["&"], parseAdditive)
}

function parseBitwiseXor(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["^"], parseBitwiseAnd)
}

function parseBitwiseOr(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["|"], parseBitwiseXor)
}

function parseLogicalAnd(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["&&"], parseBitwiseOr)
}

function parseLogicalOr(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["||"], parseLogicalAnd)
}

export function parseExpression(r: ListReader<Token>): Expr {
    return parseLogicalOr(r)
}
