
import type { Token } from "compiler/parser/tokenizer"

export interface Node {
    kind: string
    firstToken?: Token
    lastToken?: Token
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
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "<<" | ">>" | ">>>" | "<" | ">" | "<=" | ">=" | "==" | "!=" | "===" | "!==" | "&" | "|" | "^" | "||" | "&&"
    left: Expr
    right: Expr
}

export interface RangeExpression extends Node {
    kind: "RangeExpression"
    start: Expr
    end: Expr
}

export interface AssignmentExpression extends Node {
    kind: "AssignmentExpression"
    operator: "=" | "+=" | "-=" | "%=" | "*=" | "/=" | "&=" | "|=" | "&&=" | "||=" | "<<=" | ">>=" | ">>>="
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

export interface CallExpression extends Node {
    kind: "CallExpression"
    callee: Expr
    arguments: Expr[]
}

export interface NewExpression extends Node {
    kind: "NewExpression"
    callee: Expr
    arguments?: Expr[]
}

export interface UnaryExpression extends Node {
    kind: "UnaryExpression"
    operator: "+" | "-"
    argument: Expr
}

export interface UpdateExpression extends Node {
    kind: "UpdateExpression"
    operator: "++" | "--"
    argument: Expr
    prefix: boolean
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
    declared?: boolean
    declarationKind: VariableDeclarationKind
    name: Identifier
    typeAnnotation?: Identifier
    initializer?: Expr
    declarations?: VarDeclarator[]
}

export interface VarDeclarator extends Node {
    kind: "VarDeclarator"
    name: Identifier
    typeAnnotation?: Identifier
    initializer?: Expr
}

export interface FunctionStatement extends Statement {
    kind: "FunctionStatement"
    declarationKind: FunctionDeclarationKind
    declared?: boolean
    name: Identifier
    parameters: FunctionParameter[]
    returnType?: Identifier
    body: BlockStatement
}

export interface ClassFieldMember extends Node {
    kind: "ClassFieldMember"
    name: Identifier
    typeAnnotation?: Identifier
    initializer?: Expr
}

export interface ClassMethodMember extends Node {
    kind: "ClassMethodMember"
    name: Identifier
    parameters: FunctionParameter[]
    returnType?: Identifier
    body: BlockStatement
}

export type ClassMember = ClassFieldMember | ClassMethodMember;

export interface ClassPrimaryConstructorParameter extends Node {
    kind: "ClassPrimaryConstructorParameter"
    declarationKind: VariableDeclarationKind
    name: Identifier
    typeAnnotation?: Identifier
    defaultValue?: Expr
}

export interface ClassStatement extends Statement {
    kind: "ClassStatement"
    declared?: boolean
    name: Identifier
    primaryConstructorParameters?: ClassPrimaryConstructorParameter[]
    members: ClassMember[]
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

export interface ForStatement extends Statement {
    kind: "ForStatement"
    iterationKind?: "in" | "of"
    iterator?: VarStatement | Expr
    iterable?: Expr
    initializer?: VarStatement | Expr
    condition?: Expr
    update?: Expr
    body: Statement
}

export interface IfStatement extends Statement {
    kind: "IfStatement"
    condition: Expr
    thenBranch: Statement
    elseBranch?: Statement
}

export interface SwitchCase extends Node {
    kind: "SwitchCase"
    test?: Expr
    consequent: Statement[]
}

export interface SwitchStatement extends Statement {
    kind: "SwitchStatement"
    discriminant: Expr
    cases: SwitchCase[]
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
