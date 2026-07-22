import type { Token } from "compiler/parser/tokenizer"

/** Numeric discriminators shared by every concrete AST node. */
export const enum NodeKind {
    IntLiteral,
    FloatLiteral,
    BigIntLiteral,
    LongLiteral,
    BooleanLiteral,
    NullLiteral,
    UndefinedLiteral,
    MissingExpression,
    Identifier,
    TypeReference,
    ArrayTypeAnnotation,
    TypeParameter,
    StringLiteral,
    RegExpLiteral,
    CommaExpression,
    BinaryExpression,
    RangeExpression,
    ChainExpression,
    AssignmentExpression,
    ConditionalExpression,
    AsExpression,
    SatisfiesExpression,
    NonNullExpression,
    MemberExpression,
    PropertyReferenceExpression,
    CallExpression,
    ArrowFunctionExpression,
    FunctionExpression,
    ClassExpression,
    NewExpression,
    SpreadExpression,
    NamedArgument,
    UnaryExpression,
    UpdateExpression,
    ArrayHole,
    ArrayLiteral,
    ObjectProperty,
    ObjectSpreadProperty,
    ObjectLiteral,
    ImportSpecifier,
    ExportSpecifier,
    ExportStatement,
    ImportStatement,
    FunctionParameter,
    BindingElement,
    BindingHole,
    ObjectBindingPattern,
    ArrayBindingPattern,
    VarStatement,
    VarDeclarator,
    FunctionStatement,
    AnnotationStatement,
    AnnotationApplication,
    ClassFieldMember,
    ClassMethodMember,
    ClassPrimaryConstructorParameter,
    ClassDelegate,
    ClassStatement,
    InterfacePropertyMember,
    InterfaceMethodMember,
    InterfaceStatement,
    TypeAliasStatement,
    NamespaceStatement,
    EnumMember,
    EnumStatement,
    ExprStatement,
    EmptyStatement,
    DebuggerStatement,
    BlockStatement,
    WhileStatement,
    WithStatement,
    LabeledStatement,
    DoWhileStatement,
    ForStatement,
    IfStatement,
    SwitchCase,
    SwitchStatement,
    ReturnStatement,
    ThrowStatement,
    DeferStatement,
    ContinueStatement,
    BreakStatement,
    CatchClause,
    TryStatement,
    JsxElement,
    JsxFragment,
    JsxAttribute,
    JsxSpreadAttribute,
    JsxExpressionContainer,
    JsxText,
    Program,
}

const NODE_KIND_NAMES = [
    "IntLiteral",
    "FloatLiteral",
    "BigIntLiteral",
    "LongLiteral",
    "BooleanLiteral",
    "NullLiteral",
    "UndefinedLiteral",
    "MissingExpression",
    "Identifier",
    "TypeReference",
    "ArrayTypeAnnotation",
    "TypeParameter",
    "StringLiteral",
    "RegExpLiteral",
    "CommaExpression",
    "BinaryExpression",
    "RangeExpression",
    "ChainExpression",
    "AssignmentExpression",
    "ConditionalExpression",
    "AsExpression",
    "SatisfiesExpression",
    "NonNullExpression",
    "MemberExpression",
    "PropertyReferenceExpression",
    "CallExpression",
    "ArrowFunctionExpression",
    "FunctionExpression",
    "ClassExpression",
    "NewExpression",
    "SpreadExpression",
    "NamedArgument",
    "UnaryExpression",
    "UpdateExpression",
    "ArrayHole",
    "ArrayLiteral",
    "ObjectProperty",
    "ObjectSpreadProperty",
    "ObjectLiteral",
    "ImportSpecifier",
    "ExportSpecifier",
    "ExportStatement",
    "ImportStatement",
    "FunctionParameter",
    "BindingElement",
    "BindingHole",
    "ObjectBindingPattern",
    "ArrayBindingPattern",
    "VarStatement",
    "VarDeclarator",
    "FunctionStatement",
    "AnnotationStatement",
    "AnnotationApplication",
    "ClassFieldMember",
    "ClassMethodMember",
    "ClassPrimaryConstructorParameter",
    "ClassDelegate",
    "ClassStatement",
    "InterfacePropertyMember",
    "InterfaceMethodMember",
    "InterfaceStatement",
    "TypeAliasStatement",
    "NamespaceStatement",
    "EnumMember",
    "EnumStatement",
    "ExprStatement",
    "EmptyStatement",
    "DebuggerStatement",
    "BlockStatement",
    "WhileStatement",
    "WithStatement",
    "LabeledStatement",
    "DoWhileStatement",
    "ForStatement",
    "IfStatement",
    "SwitchCase",
    "SwitchStatement",
    "ReturnStatement",
    "ThrowStatement",
    "DeferStatement",
    "ContinueStatement",
    "BreakStatement",
    "CatchClause",
    "TryStatement",
    "JsxElement",
    "JsxFragment",
    "JsxAttribute",
    "JsxSpreadAttribute",
    "JsxExpressionContainer",
    "JsxText",
    "Program",
] as const satisfies { readonly [Kind in NodeKind]: string }

export function nodeKindName(kind: NodeKind): string {
    return NODE_KIND_NAMES[kind]
}

export function isNodeKind(value: unknown): value is NodeKind {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= NodeKind.IntLiteral
        && value <= NodeKind.Program
}

export abstract class Node {
    firstToken?: Token = undefined
    lastToken?: Token = undefined
    /** Internal source path retained while modules are merged for native emission. */
    __vexaNativeSourcePath?: string = undefined

    protected constructor(public kind: NodeKind) {
    }
}

export function nodeStartOffset(node: Node): number | undefined {
    const token = node.firstToken
    return token ? token.range.start.offset : undefined
}

export abstract class Expr extends Node {
    protected constructor(kind: NodeKind) {
        super(kind)
    }
}
export abstract class Statement extends Node {
    // Final JavaScript name supplied via the `@JsName("...")` annotation.
    protected constructor(kind: NodeKind, public annotations?: AnnotationApplication[], public jsName?: string) {
        super(kind)
    }
}

export type VariableDeclarationKind = "let" | "var" | "val" | "const";
export class IntLiteral extends Expr {
    declare kind: NodeKind.IntLiteral

    constructor(public value: number) {
        super(NodeKind.IntLiteral)
    }
}
export class FloatLiteral extends Expr {
    declare kind: NodeKind.FloatLiteral

    constructor(public value: number) {
        super(NodeKind.FloatLiteral)
    }
}
export class BigIntLiteral extends Expr {
    declare kind: NodeKind.BigIntLiteral

    constructor(public value: bigint) {
        super(NodeKind.BigIntLiteral)
    }
}
export class LongLiteral extends Expr {
    declare kind: NodeKind.LongLiteral

    constructor(public value: bigint) {
        super(NodeKind.LongLiteral)
    }
}
export class BooleanLiteral extends Expr {
    declare kind: NodeKind.BooleanLiteral

    constructor(public value: boolean) {
        super(NodeKind.BooleanLiteral)
    }
}
export class NullLiteral extends Expr {
    declare kind: NodeKind.NullLiteral
    constructor() {
        super(NodeKind.NullLiteral)
    }
}
export class UndefinedLiteral extends Expr {
    declare kind: NodeKind.UndefinedLiteral
    constructor() {
        super(NodeKind.UndefinedLiteral)
    }
}
export class MissingExpression extends Expr {
    declare kind: NodeKind.MissingExpression
    constructor() {
        super(NodeKind.MissingExpression)
    }
}
export class Identifier extends Expr {
    declare kind: NodeKind.Identifier

    constructor(
        public name: string,
        /** Original module-local name retained while native symbols are isolated. */ public __vexaNativeOriginalName?: string,
        /** Receiver-lambda label written as `this@label`. */ public receiverLabel?: string
    ) {
        super(NodeKind.Identifier)
    }
}
export class TypeReference extends Node {
    declare kind: NodeKind.TypeReference

    constructor(public name: Identifier, public typeArguments?: TypeAnnotation[]) {
        super(NodeKind.TypeReference)
    }
}
export class ArrayTypeAnnotation extends Node {
    declare kind: NodeKind.ArrayTypeAnnotation

    constructor(public elementType: TypeAnnotation) {
        super(NodeKind.ArrayTypeAnnotation)
    }
}

export type TypeAnnotation = Identifier | TypeReference | ArrayTypeAnnotation;
export class TypeParameter extends Node {
    declare kind: NodeKind.TypeParameter

    constructor(public name: Identifier, public constraint?: Identifier, public defaultType?: Identifier) {
        super(NodeKind.TypeParameter)
    }
}
export class StringLiteral extends Expr {
    declare kind: NodeKind.StringLiteral

    constructor(public value: string) {
        super(NodeKind.StringLiteral)
    }
}
export class RegExpLiteral extends Expr {
    declare kind: NodeKind.RegExpLiteral

    constructor(public pattern: string, public flags: string) {
        super(NodeKind.RegExpLiteral)
    }
}
export class CommaExpression extends Expr {
    declare kind: NodeKind.CommaExpression

    constructor(public expressions: Expr[]) {
        super(NodeKind.CommaExpression)
    }
}
export class BinaryExpression extends Expr {
    declare kind: NodeKind.BinaryExpression

    constructor(public operator: "+" | "-" | "*" | "/" | "%" | "**" | "<<" | ">>" | ">>>" | "<" | ">" | "<=" | ">=" | "<=>" | "in" | "is" | "instanceof" | "==" | "!=" | "===" | "!==" | "&" | "|" | "^" | "||" | "&&" | "??", public left: Expr, public right: Expr, public operatorToken?: Token) {
        super(NodeKind.BinaryExpression)
    }
}

export type OverloadableOperator = BinaryExpression["operator"] | "[]" | "[]=";
export class RangeExpression extends Expr {
    declare kind: NodeKind.RangeExpression

    constructor(public start: Expr, public end: Expr, public exclusive: boolean) {
        super(NodeKind.RangeExpression)
    }
}
export class ChainExpression extends Expr {
    declare kind: NodeKind.ChainExpression

    constructor(public receiver: Expr, public operations: Expr[]) {
        super(NodeKind.ChainExpression)
    }
}
export class AssignmentExpression extends Expr {
    declare kind: NodeKind.AssignmentExpression

    constructor(public operator: "=" | "+=" | "-=" | "%=" | "*=" | "/=" | "&=" | "|=" | "^=" | "&&=" | "||=" | "??=" | "<<=" | ">>=" | ">>>=", public left: Expr, public right: Expr) {
        super(NodeKind.AssignmentExpression)
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
    declare kind: NodeKind.ConditionalExpression

    constructor(public test: Expr, public consequent: Expr, public alternate: Expr) {
        super(NodeKind.ConditionalExpression)
    }
}
export class AsExpression extends Expr {
    declare kind: NodeKind.AsExpression

    constructor(public expression: Expr, public typeAnnotation: Identifier) {
        super(NodeKind.AsExpression)
    }
}
export class SatisfiesExpression extends Expr {
    declare kind: NodeKind.SatisfiesExpression

    constructor(public expression: Expr, public typeAnnotation: Identifier) {
        super(NodeKind.SatisfiesExpression)
    }
}
export class NonNullExpression extends Expr {
    declare kind: NodeKind.NonNullExpression

    constructor(public expression: Expr) {
        super(NodeKind.NonNullExpression)
    }
}
export class MemberExpression extends Expr {
    declare kind: NodeKind.MemberExpression

    constructor(public object: Expr, public property: Expr, public computed: boolean, public optional?: boolean, public nonNullAsserted?: boolean) {
        super(NodeKind.MemberExpression)
    }
}
export class PropertyReferenceExpression extends Expr {
    declare kind: NodeKind.PropertyReferenceExpression

    constructor(public object: Expr, public property: Identifier) {
        super(NodeKind.PropertyReferenceExpression)
    }
}

export function memberExpressionFromPropertyReference(propertyReference: PropertyReferenceExpression): MemberExpression {
    const member = new MemberExpression(propertyReference.object, propertyReference.property, false);
    if (propertyReference.firstToken) member.firstToken = propertyReference.firstToken;
    if (propertyReference.lastToken) member.lastToken = propertyReference.lastToken;
    return member;
}
export class CallExpression extends Expr {
    declare kind: NodeKind.CallExpression

    /** `receiver. { ... }`, represented as a marked call-shaped node for shared traversal. */
    receiverBlockShorthand?: boolean

    constructor(public callee: Expr, public args: Expr[], public typeArguments?: Identifier[], public optional?: boolean) {
        super(NodeKind.CallExpression)
    }
}
export abstract class CallableExpression extends Expr {

    protected constructor(kind: NodeKind, public parameters: FunctionParameter[], public async?: boolean, public sync?: boolean, public returnType?: Identifier) {
        super(kind)
    }
}
export class ArrowFunctionExpression extends CallableExpression {
    declare kind: NodeKind.ArrowFunctionExpression

    constructor(public body: Expr | BlockStatement, parameters: FunctionParameter[], public contextualObjectLiteral?: ObjectLiteral, async?: boolean, sync?: boolean, returnType?: Identifier) {
        super(NodeKind.ArrowFunctionExpression, parameters, async, sync, returnType)
    }
}
export class FunctionExpression extends CallableExpression {
    declare kind: NodeKind.FunctionExpression

    constructor(public body: BlockStatement, parameters: FunctionParameter[], public generator?: boolean, public name?: Identifier, public typeParameters?: TypeParameter[], public parametersCloseParen?: Token, async?: boolean, sync?: boolean, returnType?: Identifier) {
        super(NodeKind.FunctionExpression, parameters, async, sync, returnType)
    }
}
export class ClassExpression extends Expr {
    declare kind: NodeKind.ClassExpression

    // Surplus heritage clauses are retained so semantic analysis can report them.
    constructor(public members: ClassMember[], public abstract?: boolean, public name?: Identifier, public typeParameters?: TypeParameter[], public extendsType?: Identifier, public implementsTypes?: Identifier[], public extraExtendsTypes?: Identifier[], public extraImplementsTypes?: Identifier[], public classDelegates?: ClassDelegate[], public primaryConstructorParameters?: ClassPrimaryConstructorParameter[]) {
        super(NodeKind.ClassExpression)
    }
}
export class NewExpression extends Expr {
    declare kind: NodeKind.NewExpression

    constructor(public callee: Expr, public args?: Expr[], public typeArguments?: Identifier[]) {
        super(NodeKind.NewExpression)
    }
}
export class SpreadExpression extends Expr {
    declare kind: NodeKind.SpreadExpression

    constructor(public argument: Expr) {
        super(NodeKind.SpreadExpression)
    }
}
export class NamedArgument extends Expr {
    declare kind: NodeKind.NamedArgument

    constructor(public name: Identifier, public value: Expr) {
        super(NodeKind.NamedArgument)
    }
}
export class UnaryExpression extends Expr {
    declare kind: NodeKind.UnaryExpression

    constructor(public operator: "+" | "-" | "!" | "~" | "typeof" | "void" | "delete" | "await" | "yield" | "yield*" | "go", public argument: Expr) {
        super(NodeKind.UnaryExpression)
    }
}
export class UpdateExpression extends Expr {
    declare kind: NodeKind.UpdateExpression

    constructor(public operator: "++" | "--", public argument: Expr, public prefix: boolean) {
        super(NodeKind.UpdateExpression)
    }
}
export class ArrayHole extends Expr {
    declare kind: NodeKind.ArrayHole
    constructor() {
        super(NodeKind.ArrayHole)
    }
}

export type ArrayLiteralElement = Expr | ArrayHole;
export class ArrayLiteral extends Expr {
    declare kind: NodeKind.ArrayLiteral

    constructor(public elements: ArrayLiteralElement[], /** Internal marker for an omitted native rest argument. */ public __vexaEmptyRest?: boolean) {
        super(NodeKind.ArrayLiteral)
    }
}
export class ObjectProperty extends Node {
    declare kind: NodeKind.ObjectProperty

    constructor(public key: Expr, public value: Expr, public computed?: boolean, public shorthand?: boolean, public method?: boolean) {
        super(NodeKind.ObjectProperty)
    }
}
export class ObjectSpreadProperty extends Node {
    declare kind: NodeKind.ObjectSpreadProperty

    constructor(public argument: Expr) {
        super(NodeKind.ObjectSpreadProperty)
    }
}

export type ObjectLiteralProperty = ObjectProperty | ObjectSpreadProperty;
export class ObjectLiteral extends Expr {
    declare kind: NodeKind.ObjectLiteral

    constructor(public properties: ObjectLiteralProperty[], public trailingComma?: boolean) {
        super(NodeKind.ObjectLiteral)
    }
}
export class ImportSpecifier extends Node {
    declare kind: NodeKind.ImportSpecifier

    constructor(public imported: Identifier, public local?: Identifier, public typeOnly?: boolean) {
        super(NodeKind.ImportSpecifier)
    }
}
export class ExportSpecifier extends Node {
    declare kind: NodeKind.ExportSpecifier

    constructor(public exported: Identifier, public local?: Identifier, public typeOnly?: boolean) {
        super(NodeKind.ExportSpecifier)
    }
}
export class ExportStatement extends Statement {
    declare kind: NodeKind.ExportStatement

    constructor(public declaration?: Statement, public namespaceExport?: Identifier, public specifiers?: ExportSpecifier[], public from?: StringLiteral, public exportAll?: boolean, public isDefault?: boolean, public typeOnly?: boolean, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ExportStatement, annotations, jsName)
    }
}
export class ImportStatement extends Statement {
    declare kind: NodeKind.ImportStatement

    constructor(public specifiers: ImportSpecifier[], public from: StringLiteral, public defaultImport?: Identifier, public namespaceImport?: Identifier, public typeOnly?: boolean, public sideEffectOnly?: boolean, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ImportStatement, annotations, jsName)
    }
}

export type FunctionDeclarationKind = "fun" | "function";
export abstract class CallableParameterNode extends Node {
    protected constructor(kind: NodeKind, public typeAnnotation?: Identifier, public defaultValue?: Expr) {
        super(kind)
    }
}
export class FunctionParameter extends CallableParameterNode {
    declare kind: NodeKind.FunctionParameter

    constructor(public name: BindingName, public accessModifier?: ClassMemberAccessModifier, public isReadonly?: boolean, public thisParameter?: boolean, public rest?: boolean, public optional?: boolean, typeAnnotation?: Identifier, defaultValue?: Expr) {
        super(NodeKind.FunctionParameter, typeAnnotation, defaultValue)
    }
}
export class BindingElement extends Node {
    declare kind: NodeKind.BindingElement

    constructor(public name: BindingName, public propertyName?: Identifier | StringLiteral, public typeAnnotation?: Identifier, public shorthand?: boolean, public rest?: boolean, public initializer?: Expr) {
        super(NodeKind.BindingElement)
    }
}
export class BindingHole extends Node {
    declare kind: NodeKind.BindingHole
    constructor() {
        super(NodeKind.BindingHole)
    }
}
export class ObjectBindingPattern extends Node {
    declare kind: NodeKind.ObjectBindingPattern

    constructor(public elements: BindingElement[]) {
        super(NodeKind.ObjectBindingPattern)
    }
}
export class ArrayBindingPattern extends Node {
    declare kind: NodeKind.ArrayBindingPattern

    constructor(public elements: (BindingElement | BindingHole)[]) {
        super(NodeKind.ArrayBindingPattern)
    }
}

export type BindingName = Identifier | ObjectBindingPattern | ArrayBindingPattern;
export class VarStatement extends Statement {
    declare kind: NodeKind.VarStatement

    constructor(public declarationKind: VariableDeclarationKind, public name: BindingName, public declared?: boolean, public delegate?: Expr, public receiverType?: Identifier, public receiverTypeArguments?: Identifier[], public typeParameters?: TypeParameter[], public typeAnnotation?: Identifier, public initializer?: Expr, public accessors?: ClassMethodMember[], public declarations?: VarDeclarator[], annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.VarStatement, annotations, jsName)
    }
}
export class VarDeclarator extends Node {
    declare kind: NodeKind.VarDeclarator

    constructor(public name: BindingName, public typeAnnotation?: Identifier, public initializer?: Expr, public delegate?: Expr) {
        super(NodeKind.VarDeclarator)
    }
}
export class FunctionStatement extends Statement {
    declare kind: NodeKind.FunctionStatement

    constructor(public declarationKind: FunctionDeclarationKind, public name: Identifier, public parameters: FunctionParameter[], public body: BlockStatement, public declared?: boolean, public async?: boolean, public sync?: boolean, public generator?: boolean, public missingBody?: boolean, public jsInline?: string, public receiverType?: Identifier, public receiverTypeArguments?: Identifier[], public operator?: OverloadableOperator, public typeParameters?: TypeParameter[], public parametersCloseParen?: Token, public returnType?: Identifier, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.FunctionStatement, annotations, jsName)
    }
}
export class AnnotationStatement extends Statement {
    declare kind: NodeKind.AnnotationStatement

    constructor(public name: Identifier, public parameters: FunctionParameter[], public declared?: boolean, public parametersCloseParen?: Token, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.AnnotationStatement, annotations, jsName)
    }
}
export class AnnotationApplication extends Node {
    declare kind: NodeKind.AnnotationApplication

    constructor(public name: Identifier, public args: Expr[]) {
        super(NodeKind.AnnotationApplication)
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
export abstract class NamedNode extends Node {
    protected constructor(kind: NodeKind, public name: Identifier) {
        super(kind)
    }
}
export abstract class CallableMember extends NamedNode {

    protected constructor(kind: NodeKind, name: Identifier, public parameters: FunctionParameter[], public returnType?: Identifier, public typeParameters?: TypeParameter[], public optional?: boolean) {
        super(kind, name)
    }
}
export class ClassFieldMember extends NamedNode {
    declare kind: NodeKind.ClassFieldMember

    constructor(name: Identifier, public declarationKind?: VariableDeclarationKind, public readonlyToken?: Token, public computed?: boolean, public computedKey?: Expr, public override?: boolean, public optional?: boolean, public definiteAssignment?: boolean, public typeAnnotation?: Identifier, public initializer?: Expr, public accessModifier?: ClassMemberAccessModifier, public isReadonly?: boolean, public isStatic?: boolean, public abstract?: boolean, /** TypeScript `declare` member: participates in typing but emits no runtime storage. */ public declared?: boolean, public annotations?: AnnotationApplication[]) {
        super(NodeKind.ClassFieldMember, name)
    }
}
export class ClassMethodMember extends CallableMember {
    declare kind: NodeKind.ClassMethodMember

    constructor(public body: BlockStatement, name: Identifier, parameters: FunctionParameter[], public declarationKind?: FunctionDeclarationKind, public accessorKind?: "get" | "set", public accessorToken?: Token, public declarationKeywordToken?: Token, public readonlyToken?: Token, public async?: boolean, public sync?: boolean, public generator?: boolean, public getterShorthand?: boolean, public computed?: boolean, public computedKey?: Expr, public operator?: OverloadableOperator, public override?: boolean, public missingBody?: boolean, public parametersCloseParen?: Token, public accessModifier?: ClassMemberAccessModifier, public isReadonly?: boolean, public isStatic?: boolean, public abstract?: boolean, public annotations?: AnnotationApplication[], returnType?: Identifier, typeParameters?: TypeParameter[], optional?: boolean) {
        super(NodeKind.ClassMethodMember, name, parameters, returnType, typeParameters, optional)
    }
}

export type ClassMember = ClassFieldMember | ClassMethodMember;
export class ClassPrimaryConstructorParameter extends CallableParameterNode {
    declare kind: NodeKind.ClassPrimaryConstructorParameter

    constructor(public declarationKind: VariableDeclarationKind, public name: Identifier, typeAnnotation?: Identifier, defaultValue?: Expr, public annotations?: AnnotationApplication[]) {
        super(NodeKind.ClassPrimaryConstructorParameter, typeAnnotation, defaultValue)
    }
}
export class ClassDelegate extends Node {
    declare kind: NodeKind.ClassDelegate

    constructor(public typeAnnotation: Identifier, public expression: Expr) {
        super(NodeKind.ClassDelegate)
    }
}
export class ClassStatement extends Statement {
    declare kind: NodeKind.ClassStatement

    // Surplus heritage clauses are retained so semantic analysis can report them.
    constructor(public name: Identifier, public members: ClassMember[], public declared?: boolean, public abstract?: boolean, public typeParameters?: TypeParameter[], public extendsType?: Identifier, public implementsTypes?: Identifier[], public extraExtendsTypes?: Identifier[], public extraImplementsTypes?: Identifier[], public classDelegates?: ClassDelegate[], public primaryConstructorParameters?: ClassPrimaryConstructorParameter[], annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ClassStatement, annotations, jsName)
    }
}
export class InterfacePropertyMember extends NamedNode {
    declare kind: NodeKind.InterfacePropertyMember

    constructor(name: Identifier, public typeAnnotation: Identifier, public declarationKind?: VariableDeclarationKind, public optional?: boolean) {
        super(NodeKind.InterfacePropertyMember, name)
    }
}
export class InterfaceMethodMember extends CallableMember {
    declare kind: NodeKind.InterfaceMethodMember

    constructor(name: Identifier, parameters: FunctionParameter[], public declarationKind?: FunctionDeclarationKind, public computed?: boolean, public computedKey?: Expr, public accessorKind?: "get" | "set", public declarationKeywordToken?: Token, returnType?: Identifier, typeParameters?: TypeParameter[], optional?: boolean) {
        super(NodeKind.InterfaceMethodMember, name, parameters, returnType, typeParameters, optional)
    }
}

export type InterfaceMember = InterfacePropertyMember | InterfaceMethodMember;
export class InterfaceStatement extends Statement {
    declare kind: NodeKind.InterfaceStatement

    constructor(public name: Identifier, public members: InterfaceMember[], public declared?: boolean, public typeParameters?: TypeParameter[], public extendsTypes?: Identifier[], annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.InterfaceStatement, annotations, jsName)
    }
}
export class TypeAliasStatement extends Statement {
    declare kind: NodeKind.TypeAliasStatement

    constructor(public name: Identifier, public targetType: Identifier, public declared?: boolean, public typeParameters?: TypeParameter[], annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.TypeAliasStatement, annotations, jsName)
    }
}
export class NamespaceStatement extends Statement {
    declare kind: NodeKind.NamespaceStatement

    constructor(public declarationKind: "namespace" | "module", public body: BlockStatement, public declared?: boolean, public globalAugmentation?: boolean, public names?: Identifier[], public externalModuleName?: StringLiteral, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.NamespaceStatement, annotations, jsName)
    }
}
export class EnumMember extends Node {
    declare kind: NodeKind.EnumMember

    constructor(public name: Identifier, public initializer?: Expr) {
        super(NodeKind.EnumMember)
    }
}
export class EnumStatement extends Statement {
    declare kind: NodeKind.EnumStatement

    constructor(public name: Identifier, public members: EnumMember[], public declared?: boolean, public isConst?: boolean, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.EnumStatement, annotations, jsName)
    }
}
export class ExprStatement extends Statement {
    declare kind: NodeKind.ExprStatement

    constructor(public expression: Expr, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ExprStatement, annotations, jsName)
    }
}
export class EmptyStatement extends Statement {
    declare kind: NodeKind.EmptyStatement
    constructor(annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.EmptyStatement, annotations, jsName)
    }
}
export class DebuggerStatement extends Statement {
    declare kind: NodeKind.DebuggerStatement
    constructor(annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.DebuggerStatement, annotations, jsName)
    }
}
export class BlockStatement extends Statement {
    declare kind: NodeKind.BlockStatement

    constructor(public body: Statement[], annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.BlockStatement, annotations, jsName)
    }
}
export class WhileStatement extends Statement {
    declare kind: NodeKind.WhileStatement

    constructor(public condition: Expr, public body: Statement, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.WhileStatement, annotations, jsName)
    }
}
export class WithStatement extends Statement {
    declare kind: NodeKind.WithStatement

    constructor(public object: Expr, public body: Statement, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.WithStatement, annotations, jsName)
    }
}
export class LabeledStatement extends Statement {
    declare kind: NodeKind.LabeledStatement

    constructor(public label: Identifier, public body: Statement, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.LabeledStatement, annotations, jsName)
    }
}
export class DoWhileStatement extends Statement {
    declare kind: NodeKind.DoWhileStatement

    constructor(public body: Statement, public condition: Expr, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.DoWhileStatement, annotations, jsName)
    }
}
export class ForStatement extends Statement {
    declare kind: NodeKind.ForStatement
    constructor(public body: Statement, public isAwait?: boolean, public iterationKind?: "in" | "of", public iterator?: VarStatement | Expr, public iterable?: Expr, public initializer?: VarStatement | Expr, public condition?: Expr, public update?: Expr, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ForStatement, annotations, jsName)
    }
}
export class IfStatement extends Statement {
    declare kind: NodeKind.IfStatement

    constructor(public condition: Expr, public thenBranch: Statement, public elseBranch?: Statement, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.IfStatement, annotations, jsName)
    }
}
export class SwitchCase extends Node {
    declare kind: NodeKind.SwitchCase

    constructor(public consequent: Statement[], public test?: Expr) {
        super(NodeKind.SwitchCase)
    }
}
export class SwitchStatement extends Statement {
    declare kind: NodeKind.SwitchStatement

    constructor(public discriminant: Expr, public cases: SwitchCase[], annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.SwitchStatement, annotations, jsName)
    }
}
export class ReturnStatement extends Statement {
    declare kind: NodeKind.ReturnStatement

    constructor(public expression?: Expr, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ReturnStatement, annotations, jsName)
    }
}
export class ThrowStatement extends Statement {
    declare kind: NodeKind.ThrowStatement

    constructor(public expression: Expr, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ThrowStatement, annotations, jsName)
    }
}
export class DeferStatement extends Statement {
    declare kind: NodeKind.DeferStatement

    constructor(public expression: Expr, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.DeferStatement, annotations, jsName)
    }
}
export class ContinueStatement extends Statement {
    declare kind: NodeKind.ContinueStatement

    constructor(public label?: Identifier, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.ContinueStatement, annotations, jsName)
    }
}
export class BreakStatement extends Statement {
    declare kind: NodeKind.BreakStatement

    constructor(public label?: Identifier, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.BreakStatement, annotations, jsName)
    }
}
export class CatchClause extends Node {
    declare kind: NodeKind.CatchClause

    constructor(public body: BlockStatement, public parameter?: Identifier) {
        super(NodeKind.CatchClause)
    }
}
export class TryStatement extends Statement {
    declare kind: NodeKind.TryStatement

    constructor(public tryBlock: BlockStatement, public catchClause?: CatchClause, public finallyBlock?: BlockStatement, annotations?: AnnotationApplication[], jsName?: string) {
        super(NodeKind.TryStatement, annotations, jsName)
    }
}
export class JsxElement extends Expr {
    declare kind: NodeKind.JsxElement

    constructor(/** Raw tag-name text, e.g. `div` or `Foo.Bar`. */ public tagName: string, public attributes: JsxAttributeLike[], public children: JsxChild[], public selfClosing: boolean, /**
     * Reference expression for component tags (uppercase first letter or a
     * dotted name). Intrinsic lowercase tags (`div`, `span`) leave this
     * undefined so they are emitted as string literals and never resolved as
     * identifiers during semantic analysis.
     */ public reference?: Expr) {
        super(NodeKind.JsxElement)
    }
}
export class JsxFragment extends Expr {
    declare kind: NodeKind.JsxFragment

    constructor(public children: JsxChild[]) {
        super(NodeKind.JsxFragment)
    }
}
export class JsxAttribute extends Node {
    declare kind: NodeKind.JsxAttribute

    constructor(public name: string, public value?: StringLiteral | JsxExpressionContainer) {
        super(NodeKind.JsxAttribute)
    }
}
export class JsxSpreadAttribute extends Node {
    declare kind: NodeKind.JsxSpreadAttribute

    constructor(public expression: Expr) {
        super(NodeKind.JsxSpreadAttribute)
    }
}

export type JsxAttributeLike = JsxAttribute | JsxSpreadAttribute;
export class JsxExpressionContainer extends Node {
    declare kind: NodeKind.JsxExpressionContainer

    constructor(public expression: Expr) {
        super(NodeKind.JsxExpressionContainer)
    }
}
export class JsxText extends Node {
    declare kind: NodeKind.JsxText

    constructor(public value: string) {
        super(NodeKind.JsxText)
    }
}

export type JsxChild = JsxElement | JsxFragment | JsxExpressionContainer | JsxText;
export class Program extends Node {
    declare kind: NodeKind.Program

    constructor(public body: Statement[], /** Parser recovery metadata. Structural AST traversal deliberately ignores it. */ public __vexaRecoveryMarkers?: unknown) {
        super(NodeKind.Program)
    }
}
