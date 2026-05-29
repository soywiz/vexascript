
export interface Node {
    kind: string
}

export interface Expr extends Node {
}

export interface IntLiteral extends Node {
    kind: "IntLiteral"
    value: number
}

export interface Identifier extends Node {
    kind: "Identifier"
    name: string
}

export interface BinaryExpression extends Node {
    kind: "BinaryExpression"
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "||" | "&&"
    left: Expr
    right: Expr
}

export interface AssignmentExpression extends Node {
    kind: "AssignmentExpression"
    operator: "+=" | "-=" | "%=" | "*=" | "/=" | "&=" | "|=" | "&&=" | "||="
    left: Expr
    right: Expr
}

export interface MemberExpression extends Node {
    kind: "MemberExpression"
    object: Expr
    property: Expr
    computed: boolean
}
