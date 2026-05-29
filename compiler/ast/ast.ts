
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
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "||" | "&&"
    left: Expr
    right: Expr
}
