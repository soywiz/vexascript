import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";

export interface Node {
    kind: string
}

export interface Expr extends Node {
}

export interface IntLiteral extends Node {
    kind: "IntLiteral"
    value: number
}

export interface BinaryExpression extends Node {
    kind: "BinaryExpression"
    operator: "+"
    left: Expr
    right: Expr
}

function parsePrimary(r: ListReader<Token>): Expr {
    const token = r.read()
    if (token?.type === "number") {
        return { kind: "IntLiteral", value: parseInt(token.value, 10) } as IntLiteral
    }

    throw new Error("Expected a number literal")
}

export function parseExpression(r: ListReader<Token>): Expr {
    let left = parsePrimary(r)

    while (r.hasMore && r.peek()?.type === "symbol" && r.peek()?.value === "+") {
        r.skip()
        const right = parsePrimary(r)
        left = {
            kind: "BinaryExpression",
            operator: "+",
            left,
            right
        } as BinaryExpression
    }

    return left
}
