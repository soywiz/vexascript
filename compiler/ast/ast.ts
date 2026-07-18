
import type { Token } from "compiler/parser/tokenizer"
export abstract class Node {
    kind: string
    declare firstToken?: Token
    declare lastToken?: Token
    /** Internal source path retained while modules are merged for native emission. */
    declare __vexaNativeSourcePath?: string

    protected constructor(kind: string, init: any = {}) {
        this.kind = kind
        if ("firstToken" in init) this.firstToken = init.firstToken
        if ("lastToken" in init) this.lastToken = init.lastToken
        if ("__vexaNativeSourcePath" in init) this.__vexaNativeSourcePath = init.__vexaNativeSourcePath
    }
}
export abstract class Expr extends Node {
    protected constructor(kind: string, init: any = {}) {
        super(kind, init)
    }
}
export abstract class Statement extends Node {
    declare annotations?: AnnotationApplication[]
    // Final JavaScript name supplied via the `@JsName("...")` annotation. When
    // present, JavaScript emission uses this name for the declaration and every
    // reference to it instead of the source name.
    declare jsName?: string

    protected constructor(kind: string, init: any = {}) {
        super(kind, init)
        if ("annotations" in init) this.annotations = init.annotations
        if ("jsName" in init) this.jsName = init.jsName
    }
}

export type VariableDeclarationKind = "let" | "var" | "val" | "const";
export class IntLiteral extends Expr {
    declare kind: "IntLiteral"
    value: number

    constructor(init: any = {}) {
        super("IntLiteral", init)
        this.value = init.value
    }
}
export class FloatLiteral extends Expr {
    declare kind: "FloatLiteral"
    value: number

    constructor(init: any = {}) {
        super("FloatLiteral", init)
        this.value = init.value
    }
}
export class BigIntLiteral extends Expr {
    declare kind: "BigIntLiteral"
    value: bigint

    constructor(init: any = {}) {
        super("BigIntLiteral", init)
        this.value = init.value
    }
}
export class LongLiteral extends Expr {
    declare kind: "LongLiteral"
    value: bigint

    constructor(init: any = {}) {
        super("LongLiteral", init)
        this.value = init.value
    }
}
export class BooleanLiteral extends Expr {
    declare kind: "BooleanLiteral"
    value: boolean

    constructor(init: any = {}) {
        super("BooleanLiteral", init)
        this.value = init.value
    }
}
export class NullLiteral extends Expr {
    declare kind: "NullLiteral"
    constructor(init: any = {}) {
        super("NullLiteral", init)
    }
}
export class UndefinedLiteral extends Expr {
    declare kind: "UndefinedLiteral"
    constructor(init: any = {}) {
        super("UndefinedLiteral", init)
    }
}
export class MissingExpression extends Expr {
    declare kind: "MissingExpression"
    constructor(init: any = {}) {
        super("MissingExpression", init)
    }
}
export class Identifier extends Expr {
    declare kind: "Identifier"
    name: string
    /** Original module-local name retained while native symbols are isolated. */
    declare __vexaNativeOriginalName?: string

    constructor(init: any = {}) {
        super("Identifier", init)
        this.name = init.name
        if ("__vexaNativeOriginalName" in init) this.__vexaNativeOriginalName = init.__vexaNativeOriginalName
    }
}
export class TypeReference extends Node {
    declare kind: "TypeReference"
    name: Identifier
    declare typeArguments?: TypeAnnotation[]

    constructor(init: any = {}) {
        super("TypeReference", init)
        this.name = init.name
        if ("typeArguments" in init) this.typeArguments = init.typeArguments
    }
}
export class ArrayTypeAnnotation extends Node {
    declare kind: "ArrayTypeAnnotation"
    elementType: TypeAnnotation

    constructor(init: any = {}) {
        super("ArrayTypeAnnotation", init)
        this.elementType = init.elementType
    }
}

export type TypeAnnotation = Identifier | TypeReference | ArrayTypeAnnotation;
export class TypeParameter extends Node {
    declare kind: "TypeParameter"
    name: Identifier
    declare constraint?: Identifier
    declare defaultType?: Identifier

    constructor(init: any = {}) {
        super("TypeParameter", init)
        this.name = init.name
        if ("constraint" in init) this.constraint = init.constraint
        if ("defaultType" in init) this.defaultType = init.defaultType
    }
}
export class StringLiteral extends Expr {
    declare kind: "StringLiteral"
    value: string

    constructor(init: any = {}) {
        super("StringLiteral", init)
        this.value = init.value
    }
}
export class RegExpLiteral extends Expr {
    declare kind: "RegExpLiteral"
    pattern: string
    flags: string

    constructor(init: any = {}) {
        super("RegExpLiteral", init)
        this.pattern = init.pattern
        this.flags = init.flags
    }
}
export class CommaExpression extends Expr {
    declare kind: "CommaExpression"
    expressions: Expr[]

    constructor(init: any = {}) {
        super("CommaExpression", init)
        this.expressions = init.expressions
    }
}
export class BinaryExpression extends Expr {
    declare kind: "BinaryExpression"
    operator: "+" | "-" | "*" | "/" | "%" | "**" | "<<" | ">>" | ">>>" | "<" | ">" | "<=" | ">=" | "<=>" | "in" | "is" | "instanceof" | "==" | "!=" | "===" | "!==" | "&" | "|" | "^" | "||" | "&&" | "??"
    declare operatorToken?: Token
    left: Expr
    right: Expr

    constructor(init: any = {}) {
        super("BinaryExpression", init)
        this.operator = init.operator
        if ("operatorToken" in init) this.operatorToken = init.operatorToken
        this.left = init.left
        this.right = init.right
    }
}

export type OverloadableOperator = BinaryExpression["operator"] | "[]" | "[]=";
export class RangeExpression extends Expr {
    declare kind: "RangeExpression"
    start: Expr
    end: Expr
    exclusive: boolean

    constructor(init: any = {}) {
        super("RangeExpression", init)
        this.start = init.start
        this.end = init.end
        this.exclusive = init.exclusive
    }
}
export class ChainExpression extends Expr {
    declare kind: "ChainExpression"
    receiver: Expr
    operations: Expr[]

    constructor(init: any = {}) {
        super("ChainExpression", init)
        this.receiver = init.receiver
        this.operations = init.operations
    }
}
export class AssignmentExpression extends Expr {
    declare kind: "AssignmentExpression"
    operator: "=" | "+=" | "-=" | "%=" | "*=" | "/=" | "&=" | "|=" | "^=" | "&&=" | "||=" | "??=" | "<<=" | ">>=" | ">>>="
    left: Expr
    right: Expr

    constructor(init: any = {}) {
        super("AssignmentExpression", init)
        this.operator = init.operator
        this.left = init.left
        this.right = init.right
    }
}

export function compoundAssignmentBinaryOperator(
    operator: AssignmentExpression["operator"]
): BinaryExpression["operator"] | null {
    switch (operator) {
        case "+=": return "+"
        case "-=": return "-"
        case "*=": return "*"
        case "/=": return "/"
        case "%=": return "%"
        case "&=": return "&"
        case "|=": return "|"
        case "^=": return "^"
        case "&&=": return "&&"
        case "||=": return "||"
        case "??=": return "??"
        case "<<=": return "<<"
        case ">>=": return ">>"
        case ">>>=": return ">>>"
        default: return null
    }
}
export class ConditionalExpression extends Expr {
    declare kind: "ConditionalExpression"
    test: Expr
    consequent: Expr
    alternate: Expr

    constructor(init: any = {}) {
        super("ConditionalExpression", init)
        this.test = init.test
        this.consequent = init.consequent
        this.alternate = init.alternate
    }
}
export class AsExpression extends Expr {
    declare kind: "AsExpression"
    expression: Expr
    typeAnnotation: Identifier

    constructor(init: any = {}) {
        super("AsExpression", init)
        this.expression = init.expression
        this.typeAnnotation = init.typeAnnotation
    }
}
export class SatisfiesExpression extends Expr {
    declare kind: "SatisfiesExpression"
    expression: Expr
    typeAnnotation: Identifier

    constructor(init: any = {}) {
        super("SatisfiesExpression", init)
        this.expression = init.expression
        this.typeAnnotation = init.typeAnnotation
    }
}
export class NonNullExpression extends Expr {
    declare kind: "NonNullExpression"
    expression: Expr

    constructor(init: any = {}) {
        super("NonNullExpression", init)
        this.expression = init.expression
    }
}
export class MemberExpression extends Expr {
    declare kind: "MemberExpression"
    object: Expr
    property: Expr
    computed: boolean
    declare optional?: boolean
    declare nonNullAsserted?: boolean

    constructor(init: any = {}) {
        super("MemberExpression", init)
        this.object = init.object
        this.property = init.property
        this.computed = init.computed
        if ("optional" in init) this.optional = init.optional
        if ("nonNullAsserted" in init) this.nonNullAsserted = init.nonNullAsserted
    }
}
export class PropertyReferenceExpression extends Expr {
    declare kind: "PropertyReferenceExpression"
    object: Expr
    property: Identifier

    constructor(init: any = {}) {
        super("PropertyReferenceExpression", init)
        this.object = init.object
        this.property = init.property
    }
}

export function memberExpressionFromPropertyReference(propertyReference: PropertyReferenceExpression): MemberExpression {
    return new MemberExpression({
        kind: "MemberExpression",
        object: propertyReference.object,
        property: propertyReference.property,
        computed: false,
        firstToken: propertyReference.firstToken,
        lastToken: propertyReference.lastToken
    });
}
export class CallExpression extends Expr {
    declare kind: "CallExpression"
    callee: Expr
    arguments: Expr[]
    declare typeArguments?: Identifier[]
    declare optional?: boolean

    constructor(init: any = {}) {
        super("CallExpression", init)
        this.callee = init.callee
        this.arguments = init.arguments
        if ("typeArguments" in init) this.typeArguments = init.typeArguments
        if ("optional" in init) this.optional = init.optional
    }
}
export abstract class CallableExpression extends Expr {
    declare async?: boolean
    declare sync?: boolean
    parameters: FunctionParameter[]
    declare returnType?: Identifier

    protected constructor(kind: string, init: any = {}) {
        super(kind, init)
        if ("async" in init) this.async = init.async
        if ("sync" in init) this.sync = init.sync
        this.parameters = init.parameters
        if ("returnType" in init) this.returnType = init.returnType
    }
}
export class ArrowFunctionExpression extends CallableExpression {
    declare kind: "ArrowFunctionExpression"
    body: Expr | BlockStatement
    declare contextualObjectLiteral?: ObjectLiteral

    constructor(init: any = {}) {
        super("ArrowFunctionExpression", init)
        this.body = init.body
        if ("contextualObjectLiteral" in init) this.contextualObjectLiteral = init.contextualObjectLiteral
    }
}
export class FunctionExpression extends CallableExpression {
    declare kind: "FunctionExpression"
    declare generator?: boolean
    declare name?: Identifier
    declare typeParameters?: TypeParameter[]
    declare parametersCloseParen?: Token
    body: BlockStatement

    constructor(init: any = {}) {
        super("FunctionExpression", init)
        if ("generator" in init) this.generator = init.generator
        if ("name" in init) this.name = init.name
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        if ("parametersCloseParen" in init) this.parametersCloseParen = init.parametersCloseParen
        this.body = init.body
    }
}
export class ClassExpression extends Expr {
    declare kind: "ClassExpression"
    declare abstract?: boolean
    declare name?: Identifier
    declare typeParameters?: TypeParameter[]
    declare extendsType?: Identifier
    declare implementsTypes?: Identifier[]
    // Surplus `extends`/`implements` clauses beyond the single allowed one of
    // each. Parsed so the input stays well-formed, then flagged semantically.
    declare extraExtendsTypes?: Identifier[]
    declare extraImplementsTypes?: Identifier[]
    declare classDelegates?: ClassDelegate[]
    declare primaryConstructorParameters?: ClassPrimaryConstructorParameter[]
    members: ClassMember[]

    constructor(init: any = {}) {
        super("ClassExpression", init)
        if ("abstract" in init) this.abstract = init.abstract
        if ("name" in init) this.name = init.name
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        if ("extendsType" in init) this.extendsType = init.extendsType
        if ("implementsTypes" in init) this.implementsTypes = init.implementsTypes
        if ("extraExtendsTypes" in init) this.extraExtendsTypes = init.extraExtendsTypes
        if ("extraImplementsTypes" in init) this.extraImplementsTypes = init.extraImplementsTypes
        if ("classDelegates" in init) this.classDelegates = init.classDelegates
        if ("primaryConstructorParameters" in init) this.primaryConstructorParameters = init.primaryConstructorParameters
        this.members = init.members
    }
}
export class NewExpression extends Expr {
    declare kind: "NewExpression"
    callee: Expr
    declare arguments?: Expr[]
    declare typeArguments?: Identifier[]

    constructor(init: any = {}) {
        super("NewExpression", init)
        this.callee = init.callee
        if ("arguments" in init) this.arguments = init.arguments
        if ("typeArguments" in init) this.typeArguments = init.typeArguments
    }
}
export class SpreadExpression extends Expr {
    declare kind: "SpreadExpression"
    argument: Expr

    constructor(init: any = {}) {
        super("SpreadExpression", init)
        this.argument = init.argument
    }
}
export class NamedArgument extends Expr {
    declare kind: "NamedArgument"
    name: Identifier
    value: Expr

    constructor(init: any = {}) {
        super("NamedArgument", init)
        this.name = init.name
        this.value = init.value
    }
}
export class UnaryExpression extends Expr {
    declare kind: "UnaryExpression"
    operator: "+" | "-" | "!" | "~" | "typeof" | "void" | "delete" | "await" | "yield" | "yield*" | "go"
    argument: Expr

    constructor(init: any = {}) {
        super("UnaryExpression", init)
        this.operator = init.operator
        this.argument = init.argument
    }
}
export class UpdateExpression extends Expr {
    declare kind: "UpdateExpression"
    operator: "++" | "--"
    argument: Expr
    prefix: boolean

    constructor(init: any = {}) {
        super("UpdateExpression", init)
        this.operator = init.operator
        this.argument = init.argument
        this.prefix = init.prefix
    }
}
export class ArrayHole extends Expr {
    declare kind: "ArrayHole"
    constructor(init: any = {}) {
        super("ArrayHole", init)
    }
}

export type ArrayLiteralElement = Expr | ArrayHole;
export class ArrayLiteral extends Expr {
    declare kind: "ArrayLiteral"
    elements: ArrayLiteralElement[]

    constructor(init: any = {}) {
        super("ArrayLiteral", init)
        this.elements = init.elements
    }
}
export class ObjectProperty extends Node {
    declare kind: "ObjectProperty"
    key: Expr
    value: Expr
    declare computed?: boolean
    declare shorthand?: boolean
    declare method?: boolean

    constructor(init: any = {}) {
        super("ObjectProperty", init)
        this.key = init.key
        this.value = init.value
        if ("computed" in init) this.computed = init.computed
        if ("shorthand" in init) this.shorthand = init.shorthand
        if ("method" in init) this.method = init.method
    }
}
export class ObjectSpreadProperty extends Node {
    declare kind: "ObjectSpreadProperty"
    argument: Expr

    constructor(init: any = {}) {
        super("ObjectSpreadProperty", init)
        this.argument = init.argument
    }
}

export type ObjectLiteralProperty = ObjectProperty | ObjectSpreadProperty;
export class ObjectLiteral extends Expr {
    declare kind: "ObjectLiteral"
    properties: ObjectLiteralProperty[]
    declare trailingComma?: boolean

    constructor(init: any = {}) {
        super("ObjectLiteral", init)
        this.properties = init.properties
        if ("trailingComma" in init) this.trailingComma = init.trailingComma
    }
}
export class ImportSpecifier extends Node {
    declare kind: "ImportSpecifier"
    imported: Identifier
    declare local?: Identifier
    declare typeOnly?: boolean

    constructor(init: any = {}) {
        super("ImportSpecifier", init)
        this.imported = init.imported
        if ("local" in init) this.local = init.local
        if ("typeOnly" in init) this.typeOnly = init.typeOnly
    }
}
export class ExportSpecifier extends Node {
    declare kind: "ExportSpecifier"
    exported: Identifier
    declare local?: Identifier
    declare typeOnly?: boolean

    constructor(init: any = {}) {
        super("ExportSpecifier", init)
        this.exported = init.exported
        if ("local" in init) this.local = init.local
        if ("typeOnly" in init) this.typeOnly = init.typeOnly
    }
}
export class ExportStatement extends Statement {
    declare kind: "ExportStatement"
    declare declaration?: Statement
    declare namespaceExport?: Identifier
    declare specifiers?: ExportSpecifier[]
    declare from?: StringLiteral
    declare exportAll?: boolean
    declare default?: boolean
    declare typeOnly?: boolean

    constructor(init: any = {}) {
        super("ExportStatement", init)
        if ("declaration" in init) this.declaration = init.declaration
        if ("namespaceExport" in init) this.namespaceExport = init.namespaceExport
        if ("specifiers" in init) this.specifiers = init.specifiers
        if ("from" in init) this.from = init.from
        if ("exportAll" in init) this.exportAll = init.exportAll
        if ("default" in init) this.default = init.default
        if ("typeOnly" in init) this.typeOnly = init.typeOnly
    }
}
export class ImportStatement extends Statement {
    declare kind: "ImportStatement"
    specifiers: ImportSpecifier[]
    from: StringLiteral
    declare defaultImport?: Identifier
    declare namespaceImport?: Identifier
    declare typeOnly?: boolean
    declare sideEffectOnly?: boolean

    constructor(init: any = {}) {
        super("ImportStatement", init)
        this.specifiers = init.specifiers
        this.from = init.from
        if ("defaultImport" in init) this.defaultImport = init.defaultImport
        if ("namespaceImport" in init) this.namespaceImport = init.namespaceImport
        if ("typeOnly" in init) this.typeOnly = init.typeOnly
        if ("sideEffectOnly" in init) this.sideEffectOnly = init.sideEffectOnly
    }
}

export type FunctionDeclarationKind = "fun" | "function";
export class FunctionParameter extends Node {
    declare kind: "FunctionParameter"
    declare accessModifier?: ClassMemberAccessModifier
    declare readonly?: boolean
    name: BindingName
    declare thisParameter?: boolean
    declare rest?: boolean
    declare optional?: boolean
    declare typeAnnotation?: Identifier
    declare defaultValue?: Expr

    constructor(init: any = {}) {
        super("FunctionParameter", init)
        if ("accessModifier" in init) this.accessModifier = init.accessModifier
        if ("readonly" in init) this.readonly = init.readonly
        this.name = init.name
        if ("thisParameter" in init) this.thisParameter = init.thisParameter
        if ("rest" in init) this.rest = init.rest
        if ("optional" in init) this.optional = init.optional
        if ("typeAnnotation" in init) this.typeAnnotation = init.typeAnnotation
        if ("defaultValue" in init) this.defaultValue = init.defaultValue
    }
}
export class BindingElement extends Node {
    declare kind: "BindingElement"
    name: BindingName
    declare propertyName?: Identifier | StringLiteral
    declare typeAnnotation?: Identifier
    declare shorthand?: boolean
    declare rest?: boolean
    declare initializer?: Expr

    constructor(init: any = {}) {
        super("BindingElement", init)
        this.name = init.name
        if ("propertyName" in init) this.propertyName = init.propertyName
        if ("typeAnnotation" in init) this.typeAnnotation = init.typeAnnotation
        if ("shorthand" in init) this.shorthand = init.shorthand
        if ("rest" in init) this.rest = init.rest
        if ("initializer" in init) this.initializer = init.initializer
    }
}
export class BindingHole extends Node {
    declare kind: "BindingHole"
    constructor(init: any = {}) {
        super("BindingHole", init)
    }
}
export class ObjectBindingPattern extends Node {
    declare kind: "ObjectBindingPattern"
    elements: BindingElement[]

    constructor(init: any = {}) {
        super("ObjectBindingPattern", init)
        this.elements = init.elements
    }
}
export class ArrayBindingPattern extends Node {
    declare kind: "ArrayBindingPattern"
    elements: (BindingElement | BindingHole)[]

    constructor(init: any = {}) {
        super("ArrayBindingPattern", init)
        this.elements = init.elements
    }
}

export type BindingName = Identifier | ObjectBindingPattern | ArrayBindingPattern;
export class VarStatement extends Statement {
    declare kind: "VarStatement"
    declare declared?: boolean
    declarationKind: VariableDeclarationKind
    declare delegate?: Expr
    name: BindingName
    declare receiverType?: Identifier
    declare receiverTypeArguments?: Identifier[]
    declare typeParameters?: TypeParameter[]
    declare typeAnnotation?: Identifier
    declare initializer?: Expr
    declare accessors?: ClassMethodMember[]
    declare declarations?: VarDeclarator[]

    constructor(init: any = {}) {
        super("VarStatement", init)
        if ("declared" in init) this.declared = init.declared
        this.declarationKind = init.declarationKind
        if ("delegate" in init) this.delegate = init.delegate
        this.name = init.name
        if ("receiverType" in init) this.receiverType = init.receiverType
        if ("receiverTypeArguments" in init) this.receiverTypeArguments = init.receiverTypeArguments
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        if ("typeAnnotation" in init) this.typeAnnotation = init.typeAnnotation
        if ("initializer" in init) this.initializer = init.initializer
        if ("accessors" in init) this.accessors = init.accessors
        if ("declarations" in init) this.declarations = init.declarations
    }
}
export class VarDeclarator extends Node {
    declare kind: "VarDeclarator"
    name: BindingName
    declare typeAnnotation?: Identifier
    declare initializer?: Expr
    declare delegate?: Expr

    constructor(init: any = {}) {
        super("VarDeclarator", init)
        this.name = init.name
        if ("typeAnnotation" in init) this.typeAnnotation = init.typeAnnotation
        if ("initializer" in init) this.initializer = init.initializer
        if ("delegate" in init) this.delegate = init.delegate
    }
}
export class FunctionStatement extends Statement {
    declare kind: "FunctionStatement"
    declarationKind: FunctionDeclarationKind
    declare declared?: boolean
    declare async?: boolean
    declare sync?: boolean
    declare generator?: boolean
    declare missingBody?: boolean
    declare jsInline?: string
    name: Identifier
    declare receiverType?: Identifier
    declare receiverTypeArguments?: Identifier[]
    declare operator?: OverloadableOperator
    declare typeParameters?: TypeParameter[]
    parameters: FunctionParameter[]
    declare parametersCloseParen?: Token
    declare returnType?: Identifier
    body: BlockStatement

    constructor(init: any = {}) {
        super("FunctionStatement", init)
        this.declarationKind = init.declarationKind
        if ("declared" in init) this.declared = init.declared
        if ("async" in init) this.async = init.async
        if ("sync" in init) this.sync = init.sync
        if ("generator" in init) this.generator = init.generator
        if ("missingBody" in init) this.missingBody = init.missingBody
        if ("jsInline" in init) this.jsInline = init.jsInline
        this.name = init.name
        if ("receiverType" in init) this.receiverType = init.receiverType
        if ("receiverTypeArguments" in init) this.receiverTypeArguments = init.receiverTypeArguments
        if ("operator" in init) this.operator = init.operator
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        this.parameters = init.parameters
        if ("parametersCloseParen" in init) this.parametersCloseParen = init.parametersCloseParen
        if ("returnType" in init) this.returnType = init.returnType
        this.body = init.body
    }
}
export class AnnotationStatement extends Statement {
    declare kind: "AnnotationStatement"
    declare declared?: boolean
    name: Identifier
    parameters: FunctionParameter[]
    declare parametersCloseParen?: Token

    constructor(init: any = {}) {
        super("AnnotationStatement", init)
        if ("declared" in init) this.declared = init.declared
        this.name = init.name
        this.parameters = init.parameters
        if ("parametersCloseParen" in init) this.parametersCloseParen = init.parametersCloseParen
    }
}
export class AnnotationApplication extends Node {
    declare kind: "AnnotationApplication"
    name: Identifier
    arguments: Expr[]

    constructor(init: any = {}) {
        super("AnnotationApplication", init)
        this.name = init.name
        this.arguments = init.arguments
    }
}

export type ClassMemberAccessModifier = "public" | "private" | "protected";

export interface ClassMemberModifiers {
    accessModifier?: ClassMemberAccessModifier
    readonly?: boolean
    static?: boolean
    abstract?: boolean
    /** TypeScript `declare` member: participates in typing but emits no runtime storage. */
    declared?: boolean
    // `@Annotation(...)` applications written immediately before the member.
    annotations?: AnnotationApplication[]
}
export abstract class CallableMember extends Node {
    name: Identifier
    parameters: FunctionParameter[]
    declare returnType?: Identifier
    declare typeParameters?: TypeParameter[]
    declare optional?: boolean

    protected constructor(kind: string, init: any = {}) {
        super(kind, init)
        this.name = init.name
        this.parameters = init.parameters
        if ("returnType" in init) this.returnType = init.returnType
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        if ("optional" in init) this.optional = init.optional
    }
}
export class ClassFieldMember extends Node {
    declare kind: "ClassFieldMember"
    declare declarationKind?: VariableDeclarationKind
    declare readonlyToken?: Token
    name: Identifier
    declare computed?: boolean
    declare computedKey?: Expr
    declare override?: boolean
    declare optional?: boolean
    declare definiteAssignment?: boolean
    declare typeAnnotation?: Identifier
    declare initializer?: Expr
    declare accessModifier?: ClassMemberAccessModifier
    declare readonly?: boolean
    declare static?: boolean
    declare abstract?: boolean
    /** TypeScript `declare` member: participates in typing but emits no runtime storage. */
    declare declared?: boolean
    // `@Annotation(...)` applications written immediately before the member.
    declare annotations?: AnnotationApplication[]

    constructor(init: any = {}) {
        super("ClassFieldMember", init)
        if ("declarationKind" in init) this.declarationKind = init.declarationKind
        if ("readonlyToken" in init) this.readonlyToken = init.readonlyToken
        this.name = init.name
        if ("computed" in init) this.computed = init.computed
        if ("computedKey" in init) this.computedKey = init.computedKey
        if ("override" in init) this.override = init.override
        if ("optional" in init) this.optional = init.optional
        if ("definiteAssignment" in init) this.definiteAssignment = init.definiteAssignment
        if ("typeAnnotation" in init) this.typeAnnotation = init.typeAnnotation
        if ("initializer" in init) this.initializer = init.initializer
        if ("accessModifier" in init) this.accessModifier = init.accessModifier
        if ("readonly" in init) this.readonly = init.readonly
        if ("static" in init) this.static = init.static
        if ("abstract" in init) this.abstract = init.abstract
        if ("declared" in init) this.declared = init.declared
        if ("annotations" in init) this.annotations = init.annotations
    }
}
export class ClassMethodMember extends CallableMember {
    declare kind: "ClassMethodMember"
    declare declarationKind?: FunctionDeclarationKind
    declare accessorKind?: "get" | "set"
    declare accessorToken?: Token
    declare declarationKeywordToken?: Token
    declare readonlyToken?: Token
    declare async?: boolean
    declare sync?: boolean
    declare generator?: boolean
    declare getterShorthand?: boolean
    declare computed?: boolean
    declare computedKey?: Expr
    declare operator?: OverloadableOperator
    declare override?: boolean
    declare missingBody?: boolean
    declare parametersCloseParen?: Token
    body: BlockStatement
    declare accessModifier?: ClassMemberAccessModifier
    declare readonly?: boolean
    declare static?: boolean
    declare abstract?: boolean
    // `@Annotation(...)` applications written immediately before the member.
    declare annotations?: AnnotationApplication[]

    constructor(init: any = {}) {
        super("ClassMethodMember", init)
        if ("declarationKind" in init) this.declarationKind = init.declarationKind
        if ("accessorKind" in init) this.accessorKind = init.accessorKind
        if ("accessorToken" in init) this.accessorToken = init.accessorToken
        if ("declarationKeywordToken" in init) this.declarationKeywordToken = init.declarationKeywordToken
        if ("readonlyToken" in init) this.readonlyToken = init.readonlyToken
        if ("async" in init) this.async = init.async
        if ("sync" in init) this.sync = init.sync
        if ("generator" in init) this.generator = init.generator
        if ("getterShorthand" in init) this.getterShorthand = init.getterShorthand
        if ("computed" in init) this.computed = init.computed
        if ("computedKey" in init) this.computedKey = init.computedKey
        if ("operator" in init) this.operator = init.operator
        if ("override" in init) this.override = init.override
        if ("missingBody" in init) this.missingBody = init.missingBody
        if ("parametersCloseParen" in init) this.parametersCloseParen = init.parametersCloseParen
        this.body = init.body
        if ("accessModifier" in init) this.accessModifier = init.accessModifier
        if ("readonly" in init) this.readonly = init.readonly
        if ("static" in init) this.static = init.static
        if ("abstract" in init) this.abstract = init.abstract
        if ("annotations" in init) this.annotations = init.annotations
    }
}

export type ClassMember = ClassFieldMember | ClassMethodMember;
export class ClassPrimaryConstructorParameter extends Node {
    declare kind: "ClassPrimaryConstructorParameter"
    declarationKind: VariableDeclarationKind
    name: Identifier
    declare typeAnnotation?: Identifier
    declare defaultValue?: Expr

    constructor(init: any = {}) {
        super("ClassPrimaryConstructorParameter", init)
        this.declarationKind = init.declarationKind
        this.name = init.name
        if ("typeAnnotation" in init) this.typeAnnotation = init.typeAnnotation
        if ("defaultValue" in init) this.defaultValue = init.defaultValue
    }
}
export class ClassDelegate extends Node {
    declare kind: "ClassDelegate"
    typeAnnotation: Identifier
    expression: Expr

    constructor(init: any = {}) {
        super("ClassDelegate", init)
        this.typeAnnotation = init.typeAnnotation
        this.expression = init.expression
    }
}
export class ClassStatement extends Statement {
    declare kind: "ClassStatement"
    declare declared?: boolean
    declare abstract?: boolean
    name: Identifier
    declare typeParameters?: TypeParameter[]
    declare extendsType?: Identifier
    declare implementsTypes?: Identifier[]
    // Surplus `extends`/`implements` clauses beyond the single allowed one of
    // each. Parsed so the input stays well-formed, then flagged semantically.
    declare extraExtendsTypes?: Identifier[]
    declare extraImplementsTypes?: Identifier[]
    declare classDelegates?: ClassDelegate[]
    declare primaryConstructorParameters?: ClassPrimaryConstructorParameter[]
    members: ClassMember[]

    constructor(init: any = {}) {
        super("ClassStatement", init)
        if ("declared" in init) this.declared = init.declared
        if ("abstract" in init) this.abstract = init.abstract
        this.name = init.name
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        if ("extendsType" in init) this.extendsType = init.extendsType
        if ("implementsTypes" in init) this.implementsTypes = init.implementsTypes
        if ("extraExtendsTypes" in init) this.extraExtendsTypes = init.extraExtendsTypes
        if ("extraImplementsTypes" in init) this.extraImplementsTypes = init.extraImplementsTypes
        if ("classDelegates" in init) this.classDelegates = init.classDelegates
        if ("primaryConstructorParameters" in init) this.primaryConstructorParameters = init.primaryConstructorParameters
        this.members = init.members
    }
}
export class InterfacePropertyMember extends Node {
    declare kind: "InterfacePropertyMember"
    declare declarationKind?: VariableDeclarationKind
    name: Identifier
    typeAnnotation: Identifier
    declare optional?: boolean

    constructor(init: any = {}) {
        super("InterfacePropertyMember", init)
        if ("declarationKind" in init) this.declarationKind = init.declarationKind
        this.name = init.name
        this.typeAnnotation = init.typeAnnotation
        if ("optional" in init) this.optional = init.optional
    }
}
export class InterfaceMethodMember extends CallableMember {
    declare kind: "InterfaceMethodMember"
    declare declarationKind?: FunctionDeclarationKind
    declare computed?: boolean
    declare computedKey?: Expr
    declare accessorKind?: "get" | "set"
    declare declarationKeywordToken?: Token

    constructor(init: any = {}) {
        super("InterfaceMethodMember", init)
        if ("declarationKind" in init) this.declarationKind = init.declarationKind
        if ("computed" in init) this.computed = init.computed
        if ("computedKey" in init) this.computedKey = init.computedKey
        if ("accessorKind" in init) this.accessorKind = init.accessorKind
        if ("declarationKeywordToken" in init) this.declarationKeywordToken = init.declarationKeywordToken
    }
}

export type InterfaceMember = InterfacePropertyMember | InterfaceMethodMember;
export class InterfaceStatement extends Statement {
    declare kind: "InterfaceStatement"
    declare declared?: boolean
    name: Identifier
    declare typeParameters?: TypeParameter[]
    declare extendsTypes?: Identifier[]
    members: InterfaceMember[]

    constructor(init: any = {}) {
        super("InterfaceStatement", init)
        if ("declared" in init) this.declared = init.declared
        this.name = init.name
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        if ("extendsTypes" in init) this.extendsTypes = init.extendsTypes
        this.members = init.members
    }
}
export class TypeAliasStatement extends Statement {
    declare kind: "TypeAliasStatement"
    declare declared?: boolean
    name: Identifier
    declare typeParameters?: TypeParameter[]
    targetType: Identifier

    constructor(init: any = {}) {
        super("TypeAliasStatement", init)
        if ("declared" in init) this.declared = init.declared
        this.name = init.name
        if ("typeParameters" in init) this.typeParameters = init.typeParameters
        this.targetType = init.targetType
    }
}
export class NamespaceStatement extends Statement {
    declare kind: "NamespaceStatement"
    declare declared?: boolean
    declare globalAugmentation?: boolean
    declarationKind: "namespace" | "module"
    declare names?: Identifier[]
    declare externalModuleName?: StringLiteral
    body: BlockStatement

    constructor(init: any = {}) {
        super("NamespaceStatement", init)
        if ("declared" in init) this.declared = init.declared
        if ("globalAugmentation" in init) this.globalAugmentation = init.globalAugmentation
        this.declarationKind = init.declarationKind
        if ("names" in init) this.names = init.names
        if ("externalModuleName" in init) this.externalModuleName = init.externalModuleName
        this.body = init.body
    }
}
export class EnumMember extends Node {
    declare kind: "EnumMember"
    name: Identifier
    declare initializer?: Expr

    constructor(init: any = {}) {
        super("EnumMember", init)
        this.name = init.name
        if ("initializer" in init) this.initializer = init.initializer
    }
}
export class EnumStatement extends Statement {
    declare kind: "EnumStatement"
    declare declared?: boolean
    declare const?: boolean
    name: Identifier
    members: EnumMember[]

    constructor(init: any = {}) {
        super("EnumStatement", init)
        if ("declared" in init) this.declared = init.declared
        if ("const" in init) this.const = init.const
        this.name = init.name
        this.members = init.members
    }
}
export class ExprStatement extends Statement {
    declare kind: "ExprStatement"
    expression: Expr

    constructor(init: any = {}) {
        super("ExprStatement", init)
        this.expression = init.expression
    }
}
export class EmptyStatement extends Statement {
    declare kind: "EmptyStatement"
    constructor(init: any = {}) {
        super("EmptyStatement", init)
    }
}
export class DebuggerStatement extends Statement {
    declare kind: "DebuggerStatement"
    constructor(init: any = {}) {
        super("DebuggerStatement", init)
    }
}
export class BlockStatement extends Statement {
    declare kind: "BlockStatement"
    body: Statement[]

    constructor(init: any = {}) {
        super("BlockStatement", init)
        this.body = init.body
    }
}
export class WhileStatement extends Statement {
    declare kind: "WhileStatement"
    condition: Expr
    body: Statement

    constructor(init: any = {}) {
        super("WhileStatement", init)
        this.condition = init.condition
        this.body = init.body
    }
}
export class WithStatement extends Statement {
    declare kind: "WithStatement"
    object: Expr
    body: Statement

    constructor(init: any = {}) {
        super("WithStatement", init)
        this.object = init.object
        this.body = init.body
    }
}
export class LabeledStatement extends Statement {
    declare kind: "LabeledStatement"
    label: Identifier
    body: Statement

    constructor(init: any = {}) {
        super("LabeledStatement", init)
        this.label = init.label
        this.body = init.body
    }
}
export class DoWhileStatement extends Statement {
    declare kind: "DoWhileStatement"
    body: Statement
    condition: Expr

    constructor(init: any = {}) {
        super("DoWhileStatement", init)
        this.body = init.body
        this.condition = init.condition
    }
}
export class ForStatement extends Statement {
    declare kind: "ForStatement"
    declare await?: boolean
    declare iterationKind?: "in" | "of"
    declare iterator?: VarStatement | Expr
    declare iterable?: Expr
    declare initializer?: VarStatement | Expr
    declare condition?: Expr
    declare update?: Expr
    body: Statement

    constructor(init: any = {}) {
        super("ForStatement", init)
        if ("await" in init) this.await = init.await
        if ("iterationKind" in init) this.iterationKind = init.iterationKind
        if ("iterator" in init) this.iterator = init.iterator
        if ("iterable" in init) this.iterable = init.iterable
        if ("initializer" in init) this.initializer = init.initializer
        if ("condition" in init) this.condition = init.condition
        if ("update" in init) this.update = init.update
        this.body = init.body
    }
}
export class IfStatement extends Statement {
    declare kind: "IfStatement"
    condition: Expr
    thenBranch: Statement
    declare elseBranch?: Statement

    constructor(init: any = {}) {
        super("IfStatement", init)
        this.condition = init.condition
        this.thenBranch = init.thenBranch
        if ("elseBranch" in init) this.elseBranch = init.elseBranch
    }
}
export class SwitchCase extends Node {
    declare kind: "SwitchCase"
    declare test?: Expr
    consequent: Statement[]

    constructor(init: any = {}) {
        super("SwitchCase", init)
        if ("test" in init) this.test = init.test
        this.consequent = init.consequent
    }
}
export class SwitchStatement extends Statement {
    declare kind: "SwitchStatement"
    discriminant: Expr
    cases: SwitchCase[]

    constructor(init: any = {}) {
        super("SwitchStatement", init)
        this.discriminant = init.discriminant
        this.cases = init.cases
    }
}
export class ReturnStatement extends Statement {
    declare kind: "ReturnStatement"
    declare expression?: Expr

    constructor(init: any = {}) {
        super("ReturnStatement", init)
        if ("expression" in init) this.expression = init.expression
    }
}
export class ThrowStatement extends Statement {
    declare kind: "ThrowStatement"
    expression: Expr

    constructor(init: any = {}) {
        super("ThrowStatement", init)
        this.expression = init.expression
    }
}
export class DeferStatement extends Statement {
    declare kind: "DeferStatement"
    expression: Expr

    constructor(init: any = {}) {
        super("DeferStatement", init)
        this.expression = init.expression
    }
}
export class ContinueStatement extends Statement {
    declare kind: "ContinueStatement"
    declare label?: Identifier

    constructor(init: any = {}) {
        super("ContinueStatement", init)
        if ("label" in init) this.label = init.label
    }
}
export class BreakStatement extends Statement {
    declare kind: "BreakStatement"
    declare label?: Identifier

    constructor(init: any = {}) {
        super("BreakStatement", init)
        if ("label" in init) this.label = init.label
    }
}
export class CatchClause extends Node {
    declare kind: "CatchClause"
    declare parameter?: Identifier
    body: BlockStatement

    constructor(init: any = {}) {
        super("CatchClause", init)
        if ("parameter" in init) this.parameter = init.parameter
        this.body = init.body
    }
}
export class TryStatement extends Statement {
    declare kind: "TryStatement"
    tryBlock: BlockStatement
    declare catchClause?: CatchClause
    declare finallyBlock?: BlockStatement

    constructor(init: any = {}) {
        super("TryStatement", init)
        this.tryBlock = init.tryBlock
        if ("catchClause" in init) this.catchClause = init.catchClause
        if ("finallyBlock" in init) this.finallyBlock = init.finallyBlock
    }
}
export class JsxElement extends Expr {
    declare kind: "JsxElement"
    /** Raw tag-name text, e.g. `div` or `Foo.Bar`. */
    tagName: string
    /**
     * Reference expression for component tags (uppercase first letter or a
     * dotted name). Intrinsic lowercase tags (`div`, `span`) leave this
     * undefined so they are emitted as string literals and never resolved as
     * identifiers during semantic analysis.
     */
    declare reference?: Expr
    attributes: JsxAttributeLike[]
    children: JsxChild[]
    selfClosing: boolean

    constructor(init: any = {}) {
        super("JsxElement", init)
        this.tagName = init.tagName
        if ("reference" in init) this.reference = init.reference
        this.attributes = init.attributes
        this.children = init.children
        this.selfClosing = init.selfClosing
    }
}
export class JsxFragment extends Expr {
    declare kind: "JsxFragment"
    children: JsxChild[]

    constructor(init: any = {}) {
        super("JsxFragment", init)
        this.children = init.children
    }
}
export class JsxAttribute extends Node {
    declare kind: "JsxAttribute"
    name: string
    declare value?: StringLiteral | JsxExpressionContainer

    constructor(init: any = {}) {
        super("JsxAttribute", init)
        this.name = init.name
        if ("value" in init) this.value = init.value
    }
}
export class JsxSpreadAttribute extends Node {
    declare kind: "JsxSpreadAttribute"
    expression: Expr

    constructor(init: any = {}) {
        super("JsxSpreadAttribute", init)
        this.expression = init.expression
    }
}

export type JsxAttributeLike = JsxAttribute | JsxSpreadAttribute;
export class JsxExpressionContainer extends Node {
    declare kind: "JsxExpressionContainer"
    expression: Expr

    constructor(init: any = {}) {
        super("JsxExpressionContainer", init)
        this.expression = init.expression
    }
}
export class JsxText extends Node {
    declare kind: "JsxText"
    value: string

    constructor(init: any = {}) {
        super("JsxText", init)
        this.value = init.value
    }
}

export type JsxChild = JsxElement | JsxFragment | JsxExpressionContainer | JsxText;
export class Program extends Node {
    declare kind: "Program"
    body: Statement[]
    /** Parser recovery metadata. Structural AST traversal deliberately ignores it. */
    declare __vexaRecoveryMarkers?: unknown

    constructor(init: any = {}) {
        super("Program", init)
        this.body = init.body
        if ("__vexaRecoveryMarkers" in init) this.__vexaRecoveryMarkers = init.__vexaRecoveryMarkers
    }
}
