import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import { BinaryExpression, Expr, IntLiteral } from "compiler/ast/ast";

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

function parseMultiplicative(r: ListReader<Token>): Expr {
    let left = parsePrimary(r)

    while (r.hasMore && r.peek()?.type === "symbol" && r.peek()?.value === "*") {
        r.skip()
        const right = parsePrimary(r)
        left = {
            kind: "BinaryExpression",
            operator: "*",
            left,
            right
        } as BinaryExpression
    }

    return left
}

function parseAdditive(r: ListReader<Token>): Expr {
    let left = parseMultiplicative(r)

    while (r.hasMore && r.peek()?.type === "symbol" && r.peek()?.value === "+") {
        r.skip()
        const right = parseMultiplicative(r)
        left = {
            kind: "BinaryExpression",
            operator: "+",
            left,
            right
        } as BinaryExpression
    }

    return left
}

export function parseExpression(r: ListReader<Token>): Expr {
    return parseAdditive(r)
}
