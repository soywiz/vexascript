
export interface Node {
    kind: string
}

export interface Expr extends Node {
}

export interface Statement extends Node {
}

export interface IntLiteral extends Node {
    kind: "IntLiteral"
    value: number
}

export interface Identifier extends Node {
    kind: "Identifier"
    name: string
}

export interface StringLiteral extends Node {
    kind: "StringLiteral"
    value: string
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

export interface UnaryExpression extends Node {
    kind: "UnaryExpression"
    operator: "+" | "-"
    argument: Expr
}

export interface ArrayLiteral extends Node {
    kind: "ArrayLiteral"
    elements: Expr[]
}

export interface ObjectProperty extends Node {
    kind: "ObjectProperty"
    key: Identifier
    value: Expr
}

export interface ObjectLiteral extends Node {
    kind: "ObjectLiteral"
    properties: ObjectProperty[]
}

export interface LetStatement extends Statement {
    kind: "LetStatement"
    name: Identifier
    initializer: Expr
}

export interface BlockStatement extends Statement {
    kind: "BlockStatement"
    body: Statement[]
}

export interface WhileStatement extends Statement {
    kind: "WhileStatement"
    condition: Expr
    body: Statement
}

export interface Program extends Node {
    kind: "Program"
    body: Statement[]
}
