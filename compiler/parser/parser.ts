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

export function parseExpression(r: ListReader<Token>): Expr {
    const token = r.read()
    if (token?.type == 'number') {
        return { kind: "IntLiteral", value: parseInt(token.value) } as IntLiteral
    }
    throw new Error("Not an IntLiteral")
}
