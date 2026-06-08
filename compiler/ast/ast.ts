
import type { Token } from "compiler/parser/tokenizer"

export interface Node {
    kind: string
    firstToken?: Token
    lastToken?: Token
}

export interface Expr extends Node {
}

export interface Statement extends Node {
    // Final JavaScript name supplied via the `@JsName("...")` annotation. When
    // present, JavaScript emission uses this name for the declaration and every
    // reference to it instead of the source name.
    jsName?: string
}

export type VariableDeclarationKind = "let" | "var" | "val" | "const";

export interface IntLiteral extends Node {
    kind: "IntLiteral"
    value: number
}

export interface FloatLiteral extends Node {
    kind: "FloatLiteral"
    value: number
}

export interface BigIntLiteral extends Node {
    kind: "BigIntLiteral"
    value: bigint
}

export interface LongLiteral extends Node {
    kind: "LongLiteral"
    value: bigint
}

export interface BooleanLiteral extends Node {
    kind: "BooleanLiteral"
    value: boolean
}

export interface NullLiteral extends Node {
    kind: "NullLiteral"
}

export interface UndefinedLiteral extends Node {
    kind: "UndefinedLiteral"
}

export interface MissingExpression extends Node {
    kind: "MissingExpression"
}

export interface Identifier extends Node {
    kind: "Identifier"
    name: string
}

export interface TypeReference extends Node {
    kind: "TypeReference"
    name: Identifier
    typeArguments?: TypeAnnotation[]
}

export interface ArrayTypeAnnotation extends Node {
    kind: "ArrayTypeAnnotation"
    elementType: TypeAnnotation
}

export type TypeAnnotation = Identifier | TypeReference | ArrayTypeAnnotation;

export interface TypeParameter extends Node {
    kind: "TypeParameter"
    name: Identifier
    constraint?: Identifier
    defaultType?: Identifier
}

export interface StringLiteral extends Node {
    kind: "StringLiteral"
    value: string
}

export interface RegExpLiteral extends Node {
    kind: "RegExpLiteral"
    pattern: string
    flags: string
}

export interface CommaExpression extends Node {
    kind: "CommaExpression"
    expressions: Expr[]
}

export interface BinaryExpression extends Node {
    kind: "BinaryExpression"
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "<<" | ">>" | ">>>" | "<" | ">" | "<=" | ">=" | "in" | "is" | "instanceof" | "==" | "!=" | "===" | "!==" | "&" | "|" | "^" | "||" | "&&" | "??"
    operatorToken?: Token
    left: Expr
    right: Expr
}

export interface RangeExpression extends Node {
    kind: "RangeExpression"
    start: Expr
    end: Expr
    exclusive: boolean
}

export interface AssignmentExpression extends Node {
    kind: "AssignmentExpression"
    operator: "=" | "+=" | "-=" | "%=" | "*=" | "/=" | "&=" | "|=" | "&&=" | "||=" | "??=" | "<<=" | ">>=" | ">>>="
    left: Expr
    right: Expr
}

export interface ConditionalExpression extends Node {
    kind: "ConditionalExpression"
    test: Expr
    consequent: Expr
    alternate: Expr
}

export interface AsExpression extends Node {
    kind: "AsExpression"
    expression: Expr
    typeAnnotation: Identifier
}

export interface NonNullExpression extends Node {
    kind: "NonNullExpression"
    expression: Expr
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
    typeArguments?: Identifier[]
    optional?: boolean
}

export interface ArrowFunctionExpression extends Node {
    kind: "ArrowFunctionExpression"
    async?: boolean
    sync?: boolean
    parameters: FunctionParameter[]
    body: Expr | BlockStatement
    contextualObjectLiteral?: ObjectLiteral
}

export interface FunctionExpression extends Node {
    kind: "FunctionExpression"
    async?: boolean
    sync?: boolean
    generator?: boolean
    name?: Identifier
    parameters: FunctionParameter[]
    parametersCloseParen?: Token
    returnType?: Identifier
    body: BlockStatement
}

export interface NewExpression extends Node {
    kind: "NewExpression"
    callee: Expr
    arguments?: Expr[]
    typeArguments?: Identifier[]
}

export interface SpreadExpression extends Node {
    kind: "SpreadExpression"
    argument: Expr
}

/**
 * A named call argument such as `url` in `fetch(url: "https://example.com")`.
 * It wraps the argument value together with the parameter name it targets so
 * the type checker can validate it against the matching parameter and the
 * emitter can reorder it into the callee's positional parameter order.
 */
export interface NamedArgument extends Node {
    kind: "NamedArgument"
    name: Identifier
    value: Expr
}

export interface UnaryExpression extends Node {
    kind: "UnaryExpression"
    operator: "+" | "-" | "!" | "~" | "typeof" | "void" | "delete" | "await" | "yield" | "yield*" | "go"
    argument: Expr
}

export interface UpdateExpression extends Node {
    kind: "UpdateExpression"
    operator: "++" | "--"
    argument: Expr
    prefix: boolean
}

export interface ArrayHole extends Expr {
    kind: "ArrayHole"
}

export type ArrayLiteralElement = Expr | ArrayHole;

export interface ArrayLiteral extends Node {
    kind: "ArrayLiteral"
    elements: ArrayLiteralElement[]
}

export interface ObjectProperty extends Node {
    kind: "ObjectProperty"
    key: Expr
    value: Expr
    computed?: boolean
    shorthand?: boolean
    method?: boolean
}

export interface ObjectSpreadProperty extends Node {
    kind: "ObjectSpreadProperty"
    argument: Expr
}

export type ObjectLiteralProperty = ObjectProperty | ObjectSpreadProperty;

export interface ObjectLiteral extends Node {
    kind: "ObjectLiteral"
    properties: ObjectLiteralProperty[]
}

export interface ImportSpecifier extends Node {
    kind: "ImportSpecifier"
    imported: Identifier
    local?: Identifier
}

export interface ExportSpecifier extends Node {
    kind: "ExportSpecifier"
    exported: Identifier
    local?: Identifier
}

export interface ExportStatement extends Statement {
    kind: "ExportStatement"
    declaration?: Statement
    namespaceExport?: Identifier
    specifiers?: ExportSpecifier[]
    from?: StringLiteral
    exportAll?: boolean
    default?: boolean
    typeOnly?: boolean
}

export interface ImportStatement extends Statement {
    kind: "ImportStatement"
    specifiers: ImportSpecifier[]
    from: StringLiteral
    defaultImport?: Identifier
    namespaceImport?: Identifier
    typeOnly?: boolean
    sideEffectOnly?: boolean
}

export type FunctionDeclarationKind = "fun" | "function";

export interface FunctionParameter extends Node {
    kind: "FunctionParameter"
    accessModifier?: ClassMemberAccessModifier
    readonly?: boolean
    name: BindingName
    thisParameter?: boolean
    rest?: boolean
    optional?: boolean
    typeAnnotation?: Identifier
    defaultValue?: Expr
}

export interface BindingElement extends Node {
    kind: "BindingElement"
    name: BindingName
    propertyName?: Identifier
    shorthand?: boolean
    rest?: boolean
    initializer?: Expr
}

export interface BindingHole extends Node {
    kind: "BindingHole"
}

export interface ObjectBindingPattern extends Node {
    kind: "ObjectBindingPattern"
    elements: BindingElement[]
}

export interface ArrayBindingPattern extends Node {
    kind: "ArrayBindingPattern"
    elements: (BindingElement | BindingHole)[]
}

export type BindingName = Identifier | ObjectBindingPattern | ArrayBindingPattern;

export interface VarStatement extends Statement {
    kind: "VarStatement"
    declared?: boolean
    declarationKind: VariableDeclarationKind
    name: BindingName
    receiverType?: Identifier
    receiverTypeArguments?: Identifier[]
    typeParameters?: TypeParameter[]
    typeAnnotation?: Identifier
    initializer?: Expr
    declarations?: VarDeclarator[]
}

export interface VarDeclarator extends Node {
    kind: "VarDeclarator"
    name: BindingName
    typeAnnotation?: Identifier
    initializer?: Expr
}

export interface FunctionStatement extends Statement {
    kind: "FunctionStatement"
    declarationKind: FunctionDeclarationKind
    declared?: boolean
    async?: boolean
    sync?: boolean
    generator?: boolean
    missingBody?: boolean
    jsInline?: string
    name: Identifier
    receiverType?: Identifier
    receiverTypeArguments?: Identifier[]
    operator?: BinaryExpression["operator"]
    typeParameters?: TypeParameter[]
    parameters: FunctionParameter[]
    parametersCloseParen?: Token
    returnType?: Identifier
    body: BlockStatement
}

export type ClassMemberAccessModifier = "public" | "private" | "protected";

export interface ClassMemberModifiers {
    accessModifier?: ClassMemberAccessModifier
    readonly?: boolean
    static?: boolean
    abstract?: boolean
}

export interface ClassFieldMember extends Node, ClassMemberModifiers {
    kind: "ClassFieldMember"
    name: Identifier
    override?: boolean
    optional?: boolean
    definiteAssignment?: boolean
    typeAnnotation?: Identifier
    initializer?: Expr
}

export interface ClassMethodMember extends Node, ClassMemberModifiers {
    kind: "ClassMethodMember"
    accessorKind?: "get" | "set"
    accessorToken?: Token
    async?: boolean
    sync?: boolean
    generator?: boolean
    getterShorthand?: boolean
    name: Identifier
    operator?: BinaryExpression["operator"]
    override?: boolean
    missingBody?: boolean
    typeParameters?: TypeParameter[]
    parameters: FunctionParameter[]
    parametersCloseParen?: Token
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
    abstract?: boolean
    name: Identifier
    typeParameters?: TypeParameter[]
    extendsType?: Identifier
    implementsTypes?: Identifier[]
    primaryConstructorParameters?: ClassPrimaryConstructorParameter[]
    members: ClassMember[]
}

export interface InterfacePropertyMember extends Node {
    kind: "InterfacePropertyMember"
    name: Identifier
    typeAnnotation: Identifier
}

export interface InterfaceMethodMember extends Node {
    kind: "InterfaceMethodMember"
    name: Identifier
    typeParameters?: TypeParameter[]
    parameters: FunctionParameter[]
    returnType?: Identifier
}

export type InterfaceMember = InterfacePropertyMember | InterfaceMethodMember;

export interface InterfaceStatement extends Statement {
    kind: "InterfaceStatement"
    declared?: boolean
    name: Identifier
    typeParameters?: TypeParameter[]
    extendsTypes?: Identifier[]
    members: InterfaceMember[]
}

export interface TypeAliasStatement extends Statement {
    kind: "TypeAliasStatement"
    declared?: boolean
    name: Identifier
    typeParameters?: TypeParameter[]
    targetType: Identifier
}

export interface NamespaceStatement extends Statement {
    kind: "NamespaceStatement"
    declared?: boolean
    globalAugmentation?: boolean
    declarationKind: "namespace" | "module"
    names?: Identifier[]
    externalModuleName?: StringLiteral
    body: BlockStatement
}

export interface EnumMember extends Node {
    kind: "EnumMember"
    name: Identifier
    initializer?: Expr
}

export interface EnumStatement extends Statement {
    kind: "EnumStatement"
    declared?: boolean
    const?: boolean
    name: Identifier
    members: EnumMember[]
}

export interface ExprStatement extends Statement {
    kind: "ExprStatement"
    expression: Expr
}

export interface EmptyStatement extends Statement {
    kind: "EmptyStatement"
}

export interface DebuggerStatement extends Statement {
    kind: "DebuggerStatement"
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

export interface WithStatement extends Statement {
    kind: "WithStatement"
    object: Expr
    body: Statement
}

export interface LabeledStatement extends Statement {
    kind: "LabeledStatement"
    label: Identifier
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

export interface ThrowStatement extends Statement {
    kind: "ThrowStatement"
    expression: Expr
}

export interface ContinueStatement extends Statement {
    kind: "ContinueStatement"
    label?: Identifier
}

export interface BreakStatement extends Statement {
    kind: "BreakStatement"
    label?: Identifier
}

export interface CatchClause extends Node {
    kind: "CatchClause"
    parameter?: Identifier
    body: BlockStatement
}

export interface TryStatement extends Statement {
    kind: "TryStatement"
    tryBlock: BlockStatement
    catchClause?: CatchClause
    finallyBlock?: BlockStatement
}

/**
 * Embedded XML/JSX support. MyLang always enables it; TypeScript enables it via
 * the `jsx` parser option. An element such as `<div class="x">{value}</div>`
 * parses into a `JsxElement`, a fragment `<>...</>` into a `JsxFragment`.
 */
export interface JsxElement extends Node {
    kind: "JsxElement"
    /** Raw tag-name text, e.g. `div` or `Foo.Bar`. */
    tagName: string
    /**
     * Reference expression for component tags (uppercase first letter or a
     * dotted name). Intrinsic lowercase tags (`div`, `span`) leave this
     * undefined so they are emitted as string literals and never resolved as
     * identifiers during semantic analysis.
     */
    reference?: Expr
    attributes: JsxAttributeLike[]
    children: JsxChild[]
    selfClosing: boolean
}

export interface JsxFragment extends Node {
    kind: "JsxFragment"
    children: JsxChild[]
}

export interface JsxAttribute extends Node {
    kind: "JsxAttribute"
    name: string
    value?: StringLiteral | JsxExpressionContainer
}

export interface JsxSpreadAttribute extends Node {
    kind: "JsxSpreadAttribute"
    expression: Expr
}

export type JsxAttributeLike = JsxAttribute | JsxSpreadAttribute;

export interface JsxExpressionContainer extends Node {
    kind: "JsxExpressionContainer"
    expression: Expr
}

export interface JsxText extends Node {
    kind: "JsxText"
    value: string
}

export type JsxChild = JsxElement | JsxFragment | JsxExpressionContainer | JsxText;

export interface Program extends Node {
    kind: "Program"
    body: Statement[]
}
