
export interface Node {
    kind: string
}

export interface Expr extends Node {
}

export interface Statement extends Node {
}

export type VariableDeclarationKind = "let" | "var" | "val" | "const";

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
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "<" | ">" | "<=" | ">=" | "===" | "!==" | "&" | "|" | "^" | "||" | "&&"
    left: Expr
    right: Expr
}

export interface AssignmentExpression extends Node {
    kind: "AssignmentExpression"
    operator: "=" | "+=" | "-=" | "%=" | "*=" | "/=" | "&=" | "|=" | "&&=" | "||="
    left: Expr
    right: Expr
}

export interface MemberExpression extends Node {
    kind: "MemberExpression"
    object: Expr
    property: Expr
    computed: boolean
    optional?: boolean
    nonNullAsserted?: boolean
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

export type FunctionDeclarationKind = "fun" | "function";

export interface FunctionParameter extends Node {
    kind: "FunctionParameter"
    name: Identifier
    optional?: boolean
    typeAnnotation?: Identifier
    defaultValue?: Expr
}

export interface VarStatement extends Statement {
    kind: "VarStatement"
    declarationKind: VariableDeclarationKind
    name: Identifier
    typeAnnotation?: Identifier
    initializer?: Expr
}

export interface FunctionStatement extends Statement {
    kind: "FunctionStatement"
    declarationKind: FunctionDeclarationKind
    name: Identifier
    parameters: FunctionParameter[]
    returnType?: Identifier
    body: BlockStatement
}

export interface ExprStatement extends Statement {
    kind: "ExprStatement"
    expression: Expr
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

export interface DoWhileStatement extends Statement {
    kind: "DoWhileStatement"
    body: Statement
    condition: Expr
}

export interface ReturnStatement extends Statement {
    kind: "ReturnStatement"
    expression?: Expr
}

export interface ContinueStatement extends Statement {
    kind: "ContinueStatement"
}

export interface BreakStatement extends Statement {
    kind: "BreakStatement"
}

export interface Program extends Node {
    kind: "Program"
    body: Statement[]
}
