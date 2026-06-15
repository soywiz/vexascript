import type {
  ArrowFunctionExpression,
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BigIntLiteral,
  BinaryExpression,
  BooleanLiteral,
  BlockStatement,
  CallExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassPrimaryConstructorParameter,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  EnumStatement,
  ExportStatement,
  ForStatement,
  FloatLiteral,
  FunctionParameter,
  FunctionExpression,
  FunctionStatement,
  Identifier,
  IfStatement,
  InterfaceStatement,
  JsxElement,
  JsxFragment,
  JsxAttribute,
  JsxAttributeLike,
  JsxSpreadAttribute,
  JsxExpressionContainer,
  JsxChild,
  JsxText,
  LabeledStatement,
  ImportStatement,
  IntLiteral,
  LongLiteral,
  MemberExpression,
  NamedArgument,
  NewExpression,
  NamespaceStatement,
  NonNullExpression,
  ObjectLiteral,
  ObjectProperty,
  ObjectSpreadProperty,
  Program,
  RangeExpression,
  RegExpLiteral,
  ReturnStatement,
  Statement,
  StringLiteral,
  SpreadExpression,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type { AnalysisType } from "compiler/analysis/types";
import { typeToString } from "compiler/analysis/types";
import type { BindingElement, BindingName } from "compiler/ast/ast";
import { unwrapExportedDeclaration, walkAst } from "compiler/ast/traversal";

type Assoc = "left" | "right";

// Rewrite source-language import paths so the emitted JS resolves correctly:
// .vx → .js, .ts/.tsx → .js, .mts → .mjs (only for relative paths).
// Only applied when activeState.rewriteImportExtensions is true (vexa build).
function rewriteImportPath(path: string): string {
  if (!activeState.rewriteImportExtensions) return path;
  if (!path.startsWith("./") && !path.startsWith("../")) return path;
  return path.replace(/\.(vx|ts|tsx)$/, ".js").replace(/\.mts$/, ".mjs");
}

const OPERATOR_METHOD_NAMES: Partial<Record<BinaryExpression["operator"], string>> = {
  "+": "operator$plus",
  "-": "operator$minus",
  "*": "operator$star",
  "/": "operator$slash",
  "%": "operator$percent",
  "**": "operator$power",
  "<<": "operator$shiftLeft",
  ">>": "operator$shiftRight",
  ">>>": "operator$unsignedShiftRight",
  "<": "operator$less",
  ">": "operator$greater",
  "<=": "operator$lessEqual",
  ">=": "operator$greaterEqual",
  "==": "operator$equals",
  "!=": "operator$notEquals",
  "===": "operator$strictEquals",
  "!==": "operator$strictNotEquals",
  "&": "operator$bitAnd",
  "|": "operator$bitOr",
  "^": "operator$bitXor",
  "||": "operator$logicalOr",
  "&&": "operator$logicalAnd",
  "??": "operator$nullish"
};

interface RuntimeOverloadInfo {
  emittedName: string;
  parameterTypes: string[];
  hasBody: boolean;
}

interface RuntimeOperatorInfo extends RuntimeOverloadInfo {
  operator: BinaryExpression["operator"];
  // Extension operators (declared as `fun Receiver.operator+`) are emitted as
  // standalone receiver-mangled functions and called as `name(left, right)`,
  // while class operators stay prototype methods called as `left.name(right)`.
  extension: boolean;
}

interface RuntimeExtensionMethodInfo extends RuntimeOverloadInfo {
  name: string;
}

interface RuntimeEnumInfo {
  memberNames: Set<string>;
  rawValues: Array<string | number>;
}

interface JavaScriptImplementationInfo {
  template: string;
  parameters: FunctionParameter[];
}

interface RuntimeVariableDelegateInfo {
  backingName: string;
  kind: "function" | "tupleFunction" | "tupleValue" | "objectValue" | "unknownTuple";
}

// Configurable factories used to lower embedded XML/JSX. They default to the
// classic React runtime but can be overridden per emission (e.g. `h` /
// `Fragment` for Preact, or a custom `jsx`/`jsxFragmentFactory`).
export const DEFAULT_JSX_FACTORY = "React.createElement";
export const DEFAULT_JSX_FRAGMENT_FACTORY = "React.Fragment";

// activeExtensionThis / activeExtensionReceiverTypeName are saved/restored
// locally within each extension method emission and intentionally live
// outside ActiveEmitState (they are not a top-level call context).
let activeExtensionThis = false;
let activeExtensionReceiverTypeName: string | null = null;

// All other per-emission emitter state lives in this single state object:
// emitProgramStatementPairs swaps in a fresh object and restores the previous
// one with a single assignment, so a save/restore pair can never miss a field,
// and scoped overrides replace the whole object (`activeState = { ...activeState,
// field }`) instead of mutating it in place.
interface ActiveEmitState {
  programOverloads: Map<string, RuntimeOverloadInfo[]>;
  operators: Map<string, RuntimeOperatorInfo[]>;
  extensionMethods: Map<string, RuntimeExtensionMethodInfo[]>;
  extensionProperties: Map<string, string>;
  classNames: Set<string>;
  interfaceNames: Set<string>;
  interfaceMembers: Map<string, InterfaceStatement["members"]>;
  constructableOnlyNames: Set<string>;
  /**
   * Parameter names (in declaration order) keyed by callable name (top-level
   * functions and class constructors), used to reorder named call arguments
   * (`fetch(url: ...)`) into the callee's positional parameter order.
   */
  parameterNames: Map<string, string[]>;
  javaScriptImplementations: Map<string, JavaScriptImplementationInfo>;
  /** Source-name to final JavaScript-name overrides declared via `@JsName("...")`. */
  jsNames: Map<string, string>;
  variableDelegates: Map<string, RuntimeVariableDelegateInfo>;
  enumInfos: Map<string, RuntimeEnumInfo>;
  importedExtensionRuntimeNames: Map<string, string[]>;
  implicitReceiverIdentifiers: ReadonlySet<Node>;
  staticImplicitReceiverIdentifiers: ReadonlyMap<Node, string>;
  implicitReceiverExtensionIdentifiers: ReadonlyMap<Node, string>;
  expressionTypes: ReadonlyMap<Node, AnalysisType> | undefined;
  /**
   * Expressions flagged by the analyzer as receiving an implicit `await`
   * because they evaluate to a Promise inside a `sync` function body.
   * Auto-await placement (including which positions opt out) is decided
   * entirely by the analyzer; the emitter just inserts `await` for the
   * flagged nodes.
   */
  autoAwaitExpressions: ReadonlySet<Node>;
  asyncForStatements: ReadonlySet<Node>;
  rewriteImportExtensions: boolean;
  jsxFactory: string;
  jsxFragmentFactory: string;
}

function createEmptyEmitState(): ActiveEmitState {
  return {
    programOverloads: new Map(),
    operators: new Map(),
    extensionMethods: new Map(),
    extensionProperties: new Map(),
    classNames: new Set(),
    interfaceNames: new Set(),
    interfaceMembers: new Map(),
    constructableOnlyNames: new Set(),
    parameterNames: new Map(),
    javaScriptImplementations: new Map(),
    jsNames: new Map(),
    variableDelegates: new Map(),
    enumInfos: new Map(),
    importedExtensionRuntimeNames: new Map(),
    implicitReceiverIdentifiers: new Set(),
    staticImplicitReceiverIdentifiers: new Map(),
    implicitReceiverExtensionIdentifiers: new Map(),
    expressionTypes: undefined,
    autoAwaitExpressions: new Set(),
    asyncForStatements: new Set(),
    rewriteImportExtensions: false,
    jsxFactory: DEFAULT_JSX_FACTORY,
    jsxFragmentFactory: DEFAULT_JSX_FRAGMENT_FACTORY
  };
}

let activeState: ActiveEmitState = createEmptyEmitState();

const PREC_COMMA = 1;
const PREC_ASSIGNMENT = 2;
const PREC_CONDITIONAL = 3;
const PREC_LOGICAL_OR = 4;
const PREC_LOGICAL_AND = 5;
const PREC_BITWISE_OR = 6;
const PREC_BITWISE_XOR = 7;
const PREC_BITWISE_AND = 8;
const PREC_EQUALITY = 9;
const PREC_RELATIONAL = 10;
const PREC_SHIFT = 11;
const PREC_ADDITIVE = 12;
const PREC_MULTIPLICATIVE = 13;
const PREC_EXPONENT = 14;
const PREC_UNARY = 15;
const PREC_UPDATE = 16;
const PREC_MEMBER = 17;
const PREC_PRIMARY = 18;

export interface EmitOptions {
  /** Callee used for elements, e.g. `React.createElement` (default) or `h`. */
  jsxFactory?: string;
  /** Expression used for fragments, e.g. `React.Fragment` (default) or `Fragment`. */
  jsxFragmentFactory?: string;
  /**
   * When true, rewrite source-language extensions in import/export paths to .js
   * so the emitted file can be run directly (e.g. vexa build single-file output).
   * Leave false when bundling, where local imports are stripped anyway.
   */
  rewriteImportExtensions?: boolean;
}

function isAsyncEmittedFunction(node: { async?: boolean; sync?: boolean }): boolean {
  return node.async === true || node.sync === true;
}

function asyncEmitPrefix(node: { async?: boolean; sync?: boolean }): string {
  return isAsyncEmittedFunction(node) ? "async " : "";
}

function isAutoAwaited(expression: Expr): boolean {
  return activeState.autoAwaitExpressions.has(expression as unknown as Node);
}

function normalizeVarKind(kind: string): "let" | "var" | "const" {
  if (kind === "val") {
    return "const";
  }
  if (kind === "const" || kind === "var") {
    return kind;
  }
  return "let";
}

function binaryPrecedence(operator: BinaryExpression["operator"]): { precedence: number; assoc: Assoc } {
  switch (operator) {
    case "??":
    case "||":
      return { precedence: PREC_LOGICAL_OR, assoc: "left" };
    case "&&":
      return { precedence: PREC_LOGICAL_AND, assoc: "left" };
    case "|":
      return { precedence: PREC_BITWISE_OR, assoc: "left" };
    case "^":
      return { precedence: PREC_BITWISE_XOR, assoc: "left" };
    case "&":
      return { precedence: PREC_BITWISE_AND, assoc: "left" };
    case "==":
    case "!=":
    case "===":
    case "!==":
      return { precedence: PREC_EQUALITY, assoc: "left" };
    case "<":
    case ">":
    case "<=":
    case ">=":
    case "in":
    case "is":
    case "instanceof":
      return { precedence: PREC_RELATIONAL, assoc: "left" };
    case "<<":
    case ">>":
    case ">>>":
      return { precedence: PREC_SHIFT, assoc: "left" };
    case "+":
    case "-":
      return { precedence: PREC_ADDITIVE, assoc: "left" };
    case "*":
    case "/":
    case "%":
      return { precedence: PREC_MULTIPLICATIVE, assoc: "left" };
    case "**":
      return { precedence: PREC_EXPONENT, assoc: "right" };
    default:
      return { precedence: PREC_ASSIGNMENT, assoc: "left" };
  }
}

function expressionPrecedence(expression: Expr): number {
  switch (expression.kind) {
    case "CommaExpression":
      return PREC_COMMA;
    case "AssignmentExpression":
      return PREC_ASSIGNMENT;
    case "AsExpression":
      return PREC_RELATIONAL;
    case "NonNullExpression":
      return PREC_UPDATE;
    case "ConditionalExpression":
      return PREC_CONDITIONAL;
    case "BinaryExpression":
      return binaryPrecedence((expression as BinaryExpression).operator).precedence;
    case "UnaryExpression":
      return PREC_UNARY;
    case "UpdateExpression":
      return (expression as UpdateExpression).prefix ? PREC_UNARY : PREC_UPDATE;
    case "MemberExpression":
    case "CallExpression":
    case "NewExpression":
    case "RangeExpression":
      return PREC_MEMBER;
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return PREC_ASSIGNMENT;
    default:
      return PREC_PRIMARY;
  }
}

function maybeWrap(text: string, shouldWrap: boolean): string {
  return shouldWrap ? `(${text})` : text;
}


function sanitizeManglePart(text: string): string {
  const normalized = text.replace(/[^A-Za-z0-9]+/g, "$").replace(/^\$+|\$+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function parameterTypeName(parameter: FunctionParameter): string {
  return parameter.typeAnnotation?.name ?? "unknown";
}

function overloadSuffix(parameters: FunctionParameter[]): string {
  const visibleParameters = parameters.filter((parameter) => parameter.thisParameter !== true);
  return visibleParameters.map((parameter) => sanitizeManglePart(parameterTypeName(parameter))).join("$$") || "void";
}

function overloadedFunctionName(name: string, parameters: FunctionParameter[]): string {
  return `${name}$$${overloadSuffix(parameters)}`;
}

function typeMangleName(type: AnalysisType | undefined): string | null {
  if (!type) {
    return null;
  }
  if (type.kind === "literal") {
    return type.base === "number" && Number.isInteger(type.value) ? "int" : type.base;
  }
  if (type.kind === "builtin") {
    return type.name === "number" ? "int" : type.name;
  }
  if (type.kind === "named") {
    return type.name;
  }
  return sanitizeManglePart(typeToString(type));
}

function isOverloadMatch(overload: RuntimeOverloadInfo, argumentTypes: Array<string | null>): boolean {
  if (overload.parameterTypes.length !== argumentTypes.length) {
    return false;
  }
  return overload.parameterTypes.every((parameterType, index) => {
    const argumentType = argumentTypes[index];
    return !argumentType || sanitizeManglePart(parameterType) === sanitizeManglePart(argumentType) || parameterType === "number" && argumentType === "int";
  });
}

function resolveOverloadedFunctionCall(call: CallExpression): string | null {
  if (call.callee.kind !== "Identifier") {
    return null;
  }
  const name = (call.callee as Identifier).name;
  const overloads = activeState.programOverloads.get(name);
  if (!overloads || overloads.length <= 1) {
    return null;
  }
  const argumentTypes = call.arguments.map((argument) => typeMangleName(activeState.expressionTypes?.get(argument as unknown as Node)));
  const match = overloads.find((candidate) => candidate.hasBody && isOverloadMatch(candidate, argumentTypes))
    ?? overloads.find((candidate) => candidate.hasBody && candidate.parameterTypes.length === call.arguments.length);
  return match?.emittedName ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emitJavaScriptImplementationCall(call: CallExpression): string | null {
  if (call.optional === true || call.callee.kind !== "Identifier") {
    return null;
  }
  const implementation = activeState.javaScriptImplementations.get((call.callee as Identifier).name);
  if (!implementation) {
    return null;
  }

  let emitted = implementation.template;
  const parameters = implementation.parameters.filter((parameter) => parameter.thisParameter !== true);
  for (const [index, parameter] of parameters.entries()) {
    if (parameter.name.kind !== "Identifier") {
      continue;
    }
    const argument = call.arguments[index] ?? parameter.defaultValue;
    const replacement = argument ? `(${emitListElement(argument)})` : "undefined";
    emitted = emitted.replace(new RegExp(`\\b${escapeRegExp(parameter.name.name)}\\b`, "g"), replacement);
  }
  return emitted;
}

function resolveOperatorMethod(binary: BinaryExpression): RuntimeOperatorInfo | null {
  const leftType = activeState.expressionTypes?.get(binary.left as unknown as Node);
  if (leftType?.kind !== "named") {
    return null;
  }
  const operators = activeState.operators.get(leftType.name)?.filter((candidate) => candidate.operator === binary.operator);
  if (!operators || operators.length === 0) {
    return null;
  }
  const rightType = typeMangleName(activeState.expressionTypes?.get(binary.right as unknown as Node));
  return operators.find((candidate) => candidate.hasBody && isOverloadMatch(candidate, [rightType]))
    ?? operators.find((candidate) => candidate.hasBody)
    ?? null;
}

function resolveUnaryOperatorMethod(unary: UnaryExpression): RuntimeOperatorInfo | null {
  if (unary.operator !== "+" && unary.operator !== "-") {
    return null;
  }
  const argumentType = activeState.expressionTypes?.get(unary.argument as unknown as Node);
  if (argumentType?.kind !== "named") {
    return null;
  }
  const operators = activeState.operators.get(argumentType.name)?.filter((candidate) =>
    candidate.operator === unary.operator && candidate.parameterTypes.length === 0
  );
  if (!operators || operators.length === 0) {
    return null;
  }
  return operators.find((candidate) => candidate.hasBody) ?? null;
}

function extensionReceiverTypeName(type: AnalysisType | undefined): string | null {
  if (type?.kind === "named") {
    return type.name;
  }
  if (type?.kind === "builtin") {
    return type.name === "int" ? "number" : type.name;
  }
  if (type?.kind === "array" || type?.kind === "tuple") {
    return "Array";
  }
  return null;
}

function resolveExtensionMethodCall(call: CallExpression): string | null {
  if (call.optional === true || call.callee.kind !== "MemberExpression") {
    return null;
  }
  const member = call.callee as MemberExpression;
  if (member.computed || member.optional || member.property.kind !== "Identifier") {
    return null;
  }
  const receiverType = extensionReceiverTypeName(activeState.expressionTypes?.get(member.object));
  if (!receiverType) {
    return null;
  }
  const methodName = (member.property as Identifier).name;
  const methods = activeState.extensionMethods.get(receiverType)?.filter((candidate) => candidate.name === methodName);
  if (!methods || methods.length === 0) {
    return null;
  }
  const argumentTypes = call.arguments.map((argument) => typeMangleName(activeState.expressionTypes?.get(argument as unknown as Node)));
  return methods.find((candidate) => candidate.hasBody && isOverloadMatch(candidate, argumentTypes))?.emittedName
    ?? methods.find((candidate) => candidate.hasBody)?.emittedName
    ?? null;
}

function isBuiltinTypeNamed(type: AnalysisType | undefined, name: string): boolean {
  return type?.kind === "builtin" && type.name === name;
}

function emitTypedIntegerBinary(binary: BinaryExpression, leftText: string, rightText: string): string | null {
  const expressionType = activeState.expressionTypes?.get(binary as unknown as Node);
  const leftType = activeState.expressionTypes?.get(binary.left as unknown as Node);
  const rightType = activeState.expressionTypes?.get(binary.right as unknown as Node);

  if (
    !isBuiltinTypeNamed(expressionType, "int") ||
    !isBuiltinTypeNamed(leftType, "int") ||
    !isBuiltinTypeNamed(rightType, "int")
  ) {
    return null;
  }

  switch (binary.operator) {
    case "*":
      return `Math.imul(${leftText}, ${rightText})`;
    case "/":
      return `(${leftText} / ${rightText}) | 0`;
    default:
      return null;
  }
}

function operatorBaseName(operator: BinaryExpression["operator"]): string {
  return OPERATOR_METHOD_NAMES[operator] ?? `operator$${sanitizeManglePart(operator)}`;
}

function operatorMethodName(operator: BinaryExpression["operator"], parameters: FunctionParameter[]): string {
  return overloadedFunctionName(operatorBaseName(operator), parameters);
}

/**
 * Runtime name for an extension member (method or operator). The receiver type
 * is mangled at the front so the name is self-describing, e.g.
 * `fun Point.operator+(other: Point)` becomes `Point$$operator$plus$$Point`.
 */
function extensionMethodRuntimeName(receiverType: string, baseName: string, parameters: FunctionParameter[]): string {
  return `${sanitizeManglePart(receiverType)}$$${overloadedFunctionName(baseName, parameters)}`;
}

/**
 * Detects an imported operator-overload binding such as `operator+`. These are
 * synthesized names whose suffix is an operator symbol rather than an
 * identifier character, so they can never collide with a regular function named
 * `operatorFoo`.
 */
function isOperatorImportName(name: string): boolean {
  return /^operator[^A-Za-z0-9_]/.test(name);
}

function parameterBindingName(name: BindingName | undefined): string | null {
  return name?.kind === "Identifier" ? (name as Identifier).name : null;
}

function functionParameterNames(parameters: FunctionParameter[]): string[] {
  return parameters
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => parameterBindingName(parameter.name))
    .filter((name): name is string => name !== null);
}

function resolveJsName(name: string): string {
  return activeState.jsNames.get(name) ?? name;
}

function extensionPropertyRuntimeName(receiverType: string, propertyName: string): string {
  return `${sanitizeManglePart(receiverType)}$$${sanitizeManglePart(propertyName)}`;
}

function importedExtensionRuntimeNames(importedName: string): string[] {
  return activeState.importedExtensionRuntimeNames.get(importedName) ?? [];
}

function emitIdentifier(identifier: Identifier): string {
  const delegate = activeState.variableDelegates.get(identifier.name);
  if (delegate) {
    return emitVariableDelegateRead(delegate);
  }
  if (activeExtensionThis && identifier.name === "this") {
    return "$this";
  }
  const staticClassName = activeState.staticImplicitReceiverIdentifiers.get(identifier);
  if (staticClassName) {
    return `${staticClassName}.${identifier.name}`;
  }
  if (activeState.implicitReceiverIdentifiers.has(identifier)) {
    return `${activeExtensionThis ? "$this" : "this"}.${identifier.name}`;
  }
  return resolveJsName(identifier.name);
}

function withVariableDelegateShadows<T>(names: readonly string[], emit: () => T): T {
  if (names.length === 0) {
    return emit();
  }
  const previous = activeState;
  const variableDelegates = new Map(previous.variableDelegates);
  for (const name of names) {
    variableDelegates.delete(name);
  }
  activeState = { ...previous, variableDelegates };
  try {
    return emit();
  } finally {
    activeState = previous;
  }
}

function functionParameterBindingNames(parameters: FunctionParameter[]): string[] {
  return parameters.flatMap((parameter) => bindingIdentifiers(parameter.name).map((identifier) => identifier.name));
}

function variableDelegateBackingName(name: string): string {
  return `__$delegate_${resolveJsName(name)}`;
}

function namedTypeHasValueMember(typeName: string, program: Program): boolean {
  for (const statement of program.body) {
    const decl = statement.kind === "ExportStatement" ? (statement as ExportStatement).declaration : statement;
    if (!decl || decl.kind !== "ClassStatement") continue;
    const cls = decl as ClassStatement;
    if (cls.name.name !== typeName) continue;
    return cls.members.some((m) => m.kind === "ClassMethodMember" && m.accessorKind === "get" && m.name.name === "value");
  }
  return false;
}

function variableDelegateKind(type: AnalysisType | undefined, program: Program): RuntimeVariableDelegateInfo["kind"] {
  if (type?.kind === "function") {
    return "function";
  }
  if (type?.kind === "tuple") {
    const first = type.elements[0];
    if (first?.kind === "function") {
      return "tupleFunction";
    }
    return "tupleValue";
  }
  if (type?.kind === "object" && type.properties["value"]) {
    return "objectValue";
  }
  if (type?.kind === "named" && namedTypeHasValueMember(type.name, program)) {
    return "objectValue";
  }
  return "unknownTuple";
}

function collectVariableDelegates(program: Program, expressionTypes?: ReadonlyMap<Node, AnalysisType>): Map<string, RuntimeVariableDelegateInfo> {
  const delegates = new Map<string, RuntimeVariableDelegateInfo>();
  walkAst(program, (node) => {
    if (node.kind !== "VarStatement") return;
    const statement = node as VarStatement;
    const declarations = statement.declarations && statement.declarations.length > 0
      ? statement.declarations
      : [{ kind: "VarDeclarator", name: statement.name, delegate: statement.delegate } as VarDeclarator];
    for (const declaration of declarations) {
      if (!declaration.delegate || declaration.name.kind !== "Identifier") {
        continue;
      }
      const sourceName = declaration.name.name;
      delegates.set(sourceName, {
        backingName: variableDelegateBackingName(sourceName),
        kind: variableDelegateKind(expressionTypes?.get(declaration.delegate as unknown as Node), program)
      });
    }
  });
  return delegates;
}

function emitVariableDelegateRead(delegate: RuntimeVariableDelegateInfo): string {
  switch (delegate.kind) {
    case "function":
      return `${delegate.backingName}()`;
    case "tupleFunction":
      return `${delegate.backingName}[0]()`;
    case "objectValue":
      return `${delegate.backingName}.value`;
    case "tupleValue":
    case "unknownTuple":
      return `${delegate.backingName}[0]`;
  }
}

function emitVariableDelegateWrite(delegate: RuntimeVariableDelegateInfo, valueText: string): string {
  switch (delegate.kind) {
    case "objectValue":
      return `${delegate.backingName}.value = ${valueText}`;
    case "function":
      return `${delegate.backingName}(${valueText})`;
    case "tupleFunction":
    case "tupleValue":
    case "unknownTuple":
      return `${delegate.backingName}[1](${valueText})`;
  }
}

function variableDelegateForTarget(target: Expr): RuntimeVariableDelegateInfo | null {
  if (target.kind !== "Identifier") {
    return null;
  }
  return activeState.variableDelegates.get((target as Identifier).name) ?? null;
}

function compoundAssignmentBinaryOperator(operator: AssignmentExpression["operator"]): BinaryExpression["operator"] | null {
  switch (operator) {
    case "+=": return "+";
    case "-=": return "-";
    case "*=": return "*";
    case "/=": return "/";
    case "%=": return "%";
    case "&=": return "&";
    case "|=": return "|";
    case "&&=": return "&&";
    case "||=": return "||";
    case "??=": return "??";
    case "<<=": return "<<";
    case ">>=": return ">>";
    case ">>>=": return ">>>";
    default: return null;
  }
}

function emitVariableDelegateAssignment(assignment: AssignmentExpression): string | null {
  const delegate = variableDelegateForTarget(assignment.left);
  if (!delegate) {
    return null;
  }
  if (assignment.operator === "=") {
    return emitVariableDelegateWrite(delegate, emitExpression(assignment.right, PREC_ASSIGNMENT, "right"));
  }
  const operator = compoundAssignmentBinaryOperator(assignment.operator);
  if (!operator) {
    return null;
  }
  const valueText = `${emitVariableDelegateRead(delegate)} ${operator} ${emitExpression(assignment.right, PREC_ASSIGNMENT, "right")}`;
  return emitVariableDelegateWrite(delegate, valueText);
}

function emitVariableDelegateUpdate(update: UpdateExpression): string | null {
  const delegate = variableDelegateForTarget(update.argument);
  if (!delegate) {
    return null;
  }
  const operator = update.operator === "++" ? "+" : "-";
  return emitVariableDelegateWrite(delegate, `${emitVariableDelegateRead(delegate)} ${operator} 1`);
}

function eraseTypeArguments(typeName: string): string {
  const ltIndex = typeName.indexOf("<");
  if (ltIndex < 0) {
    return typeName;
  }
  return typeName.slice(0, ltIndex).trim();
}

function isLongExpression(expression: Expr): boolean {
  const type = activeState.expressionTypes?.get(expression as unknown as Node);
  return type?.kind === "builtin" && type.name === "long";
}

function wrapLongExpressionIfNeeded(expression: Expr, text: string): string {
  if (!isLongExpression(expression)) {
    return text;
  }
  return `BigInt.asIntN(64, ${text})`;
}

function emitListElement(expression: Expr): string {
  if (expression.kind === "ArrayHole") {
    return "";
  }
  if (expression.kind === "NamedArgument") {
    return emitListElement((expression as NamedArgument).value);
  }
  const text = emitExpression(expression);
  return expression.kind === "CommaExpression" ? `(${text})` : text;
}

function isPlainIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * Emits embedded XML/JSX using the classic React runtime
 * (`React.createElement` / `React.Fragment`). Intrinsic lowercase tags become
 * string literals; component tags emit their reference expression.
 */
function emitJsxElement(element: JsxElement): string {
  const tag = element.reference ? emitExpression(element.reference) : JSON.stringify(element.tagName);
  const props = emitJsxAttributes(element.attributes);
  const children = emitJsxChildren(element.children);
  return `${activeState.jsxFactory}(${tag}, ${props}${children})`;
}

function emitJsxFragment(fragment: JsxFragment): string {
  const children = emitJsxChildren(fragment.children);
  return `${activeState.jsxFactory}(${activeState.jsxFragmentFactory}, null${children})`;
}

function emitJsxAttributes(attributes: JsxAttributeLike[]): string {
  if (attributes.length === 0) {
    return "null";
  }
  const pieces = attributes.map((attribute) => {
    if (attribute.kind === "JsxSpreadAttribute") {
      return `...${emitExpression((attribute as JsxSpreadAttribute).expression)}`;
    }
    const jsxAttribute = attribute as JsxAttribute;
    const key = isPlainIdentifierName(jsxAttribute.name) ? jsxAttribute.name : JSON.stringify(jsxAttribute.name);
    if (!jsxAttribute.value) {
      return `${key}: true`;
    }
    if (jsxAttribute.value.kind === "StringLiteral") {
      return `${key}: ${JSON.stringify((jsxAttribute.value as StringLiteral).value)}`;
    }
    return `${key}: ${emitExpression((jsxAttribute.value as JsxExpressionContainer).expression)}`;
  });
  return `{ ${pieces.join(", ")} }`;
}

function emitJsxChildren(children: JsxChild[]): string {
  const parts: string[] = [];
  for (const child of children) {
    if (child.kind === "JsxText") {
      parts.push(JSON.stringify((child as JsxText).value));
    } else if (child.kind === "JsxExpressionContainer") {
      parts.push(emitExpression((child as JsxExpressionContainer).expression));
    } else if (child.kind === "JsxElement") {
      parts.push(emitJsxElement(child as JsxElement));
    } else if (child.kind === "JsxFragment") {
      parts.push(emitJsxFragment(child as JsxFragment));
    }
  }
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

/**
 * Resolves the positional parameter names of a call's callee so named
 * arguments can be reordered. Top-level functions and class constructors come
 * from the collected parameter-name map; any other callable (methods, locals
 * holding a function value) is resolved from its analyzed function type.
 */
function resolveCalleeParameterNames(callee: Expr): string[] | null {
  if (callee.kind === "Identifier") {
    const fromDeclarations = activeState.parameterNames.get((callee as Identifier).name);
    if (fromDeclarations) {
      return fromDeclarations;
    }
  }
  const calleeType = activeState.expressionTypes?.get(callee as unknown as Node);
  if (calleeType?.kind === "function") {
    return calleeType.parameters.map((parameter) => parameter.name);
  }
  return null;
}

/**
 * Emits a call's argument list, reordering named arguments (`name: value`)
 * into the callee's positional parameter order. Positional arguments fill
 * parameters left to right; named arguments target the parameter sharing their
 * name; unfilled leading slots become `undefined`. When the parameter order
 * cannot be resolved, named argument values are emitted in written order.
 */
function emitCallArgumentTexts(callee: Expr, args: Expr[]): string[] {
  if (!args.some((argument) => argument.kind === "NamedArgument")) {
    return args.map((argument) => emitListElement(argument));
  }
  const parameterNames = resolveCalleeParameterNames(callee);
  if (!parameterNames) {
    return args.map((argument) => emitListElement(argument));
  }
  const slots: (string | undefined)[] = parameterNames.map(() => undefined);
  const extra: string[] = [];
  let positionalIndex = 0;
  for (const argument of args) {
    if (argument.kind === "NamedArgument") {
      const named = argument as NamedArgument;
      const parameterIndex = parameterNames.indexOf(named.name.name);
      const text = emitListElement(named.value);
      if (parameterIndex >= 0) {
        slots[parameterIndex] = text;
      } else {
        extra.push(text);
      }
      continue;
    }
    const text = emitListElement(argument);
    if (positionalIndex < slots.length) {
      slots[positionalIndex] = text;
    } else {
      extra.push(text);
    }
    positionalIndex += 1;
  }
  let lastFilledSlot = -1;
  for (let index = 0; index < slots.length; index += 1) {
    if (slots[index] !== undefined) {
      lastFilledSlot = index;
    }
  }
  const ordered: string[] = [];
  for (let index = 0; index <= lastFilledSlot; index += 1) {
    ordered.push(slots[index] ?? "undefined");
  }
  ordered.push(...extra);
  return ordered;
}

function emitObjectPropertyKey(property: ObjectProperty): string {
  if (property.computed) {
    return `[${emitExpression(property.key)}]`;
  }
  if (property.key.kind === "Identifier") {
    return (property.key as Identifier).name;
  }
  if (property.key.kind === "StringLiteral") {
    return JSON.stringify((property.key as StringLiteral).value);
  }
  return emitExpression(property.key);
}

function emitExpression(expression: Expr, parentPrecedence: number = 0, side: "left" | "right" = "left"): string {
  const currentPrecedence = expressionPrecedence(expression);

  const emitSelf = (): string => {
    switch (expression.kind) {
      case "IntLiteral":
        return String((expression as IntLiteral).value);
      case "FloatLiteral":
        return String((expression as FloatLiteral).value);
      case "BigIntLiteral":
        return `${(expression as BigIntLiteral).value}n`;
      case "LongLiteral":
        return `${(expression as LongLiteral).value}n`;
      case "StringLiteral":
        return JSON.stringify((expression as StringLiteral).value);
      case "RegExpLiteral": {
        const regexp = expression as RegExpLiteral;
        return `/${regexp.pattern}/${regexp.flags}`;
      }
      case "BooleanLiteral":
        return (expression as BooleanLiteral).value ? "true" : "false";
      case "NullLiteral":
        return "null";
      case "UndefinedLiteral":
        return "undefined";
      case "MissingExpression":
        return "undefined";
      case "Identifier":
        return emitIdentifier(expression as Identifier);
      case "CommaExpression": {
        const comma = expression as CommaExpression;
        return comma.expressions.map((child) => emitExpression(child, PREC_ASSIGNMENT)).join(", ");
      }
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        const { precedence, assoc } = binaryPrecedence(binary.operator);

        const leftChildNeedsWrap =
          binary.left.kind === "BinaryExpression" &&
          binaryPrecedence((binary.left as BinaryExpression).operator).precedence === precedence &&
          assoc === "right";
        const rightChildNeedsWrap =
          binary.right.kind === "BinaryExpression" &&
          binaryPrecedence((binary.right as BinaryExpression).operator).precedence === precedence &&
          assoc === "left";

        const leftText = maybeWrap(emitExpression(binary.left, precedence, "left"), leftChildNeedsWrap);
        const rightText = maybeWrap(emitExpression(binary.right, precedence, "right"), rightChildNeedsWrap);
        const operatorMethod = resolveOperatorMethod(binary);
        if (operatorMethod) {
          return operatorMethod.extension
            ? `${operatorMethod.emittedName}(${leftText}, ${rightText})`
            : `${leftText}.${operatorMethod.emittedName}(${rightText})`;
        }
        const typedIntegerBinary = emitTypedIntegerBinary(binary, leftText, rightText);
        if (typedIntegerBinary) {
          return typedIntegerBinary;
        }
        const emittedOperator = binary.operator === "is" ? "instanceof" : binary.operator;
        const binaryText = `${leftText} ${emittedOperator} ${rightText}`;
        return wrapLongExpressionIfNeeded(expression, binaryText);
      }
      case "RangeExpression": {
        const range = expression as RangeExpression;
        const cmp = range.exclusive ? "<" : "<=";
        return `(function*(s, e) { for (let n = s; n ${cmp} e; n++) yield n })(${emitExpression(range.start)}, ${emitExpression(range.end)})`;
      }
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        const delegateAssignment = emitVariableDelegateAssignment(assignment);
        if (delegateAssignment) {
          return delegateAssignment;
        }
        const leftText = emitExpression(assignment.left, PREC_ASSIGNMENT, "left");
        const rightText = emitExpression(assignment.right, PREC_ASSIGNMENT, "right");
        return `${leftText} ${assignment.operator} ${rightText}`;
      }
      case "AsExpression":
        return emitExpression((expression as AsExpression).expression, parentPrecedence, side);
      case "NonNullExpression":
        return emitExpression((expression as NonNullExpression).expression, parentPrecedence, side);
      case "ConditionalExpression": {
        const conditional = expression as ConditionalExpression;
        const test = emitExpression(conditional.test, PREC_CONDITIONAL, "left");
        const consequent = emitExpression(conditional.consequent, PREC_ASSIGNMENT, "right");
        const alternate = emitExpression(conditional.alternate, PREC_ASSIGNMENT, "right");
        return `${test} ? ${consequent} : ${alternate}`;
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        const objectText = emitExpression(member.object, PREC_MEMBER, "left");
        if (!member.computed && member.property.kind === "Identifier") {
          const propertyName = (member.property as Identifier).name;
          const receiverType = activeState.extensionProperties.get(propertyName);
          if (receiverType) {
            return `${extensionPropertyRuntimeName(receiverType, propertyName)}(${objectText})`;
          }
          // Member property names are not affected by `@JsName`; emit them as-is
          // rather than routing through identifier renaming.
          const access = member.optional ? "?." : ".";
          return `${objectText}${access}${propertyName}`;
        }
        if (member.computed) {
          const enumComputed = emitEnumComputedMemberExpression(member, objectText);
          if (enumComputed) {
            return enumComputed;
          }
          return member.optional
            ? `${objectText}?.[${emitExpression(member.property)}]`
            : `${objectText}[${emitExpression(member.property)}]`;
        }
        const access = member.optional ? "?." : ".";
        return `${objectText}${access}${emitExpression(member.property, PREC_MEMBER, "right")}`;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const javaScriptImplementation = emitJavaScriptImplementationCall(call);
        if (javaScriptImplementation) {
          return javaScriptImplementation;
        }
        const extensionMethodName = resolveExtensionMethodCall(call);
        if (extensionMethodName) {
          const member = call.callee as MemberExpression;
          const receiverText = emitExpression(member.object, PREC_MEMBER, "left");
          const callArguments = [receiverText, ...emitCallArgumentTexts(call.callee, call.arguments)];
          return `${extensionMethodName}(${callArguments.join(", ")})`;
        }
        if (
          !call.optional &&
          call.callee.kind === "Identifier" &&
          activeExtensionReceiverTypeName &&
          activeState.implicitReceiverExtensionIdentifiers.has(call.callee as Node)
        ) {
          const methodName = (call.callee as Identifier).name;
          const receiverMethods = activeState.extensionMethods.get(activeExtensionReceiverTypeName);
          const candidates = receiverMethods?.filter((m) => m.name === methodName);
          if (candidates && candidates.length > 0) {
            const argumentTypes = call.arguments.map((arg) =>
              typeMangleName(activeState.expressionTypes?.get(arg as unknown as Node))
            );
            const resolvedName =
              candidates.find((c) => c.hasBody && isOverloadMatch(c, argumentTypes))?.emittedName ??
              candidates.find((c) => c.hasBody)?.emittedName;
            if (resolvedName) {
              const thisReceiver = activeExtensionThis ? "$this" : "this";
              const callArguments = [thisReceiver, ...emitCallArgumentTexts(call.callee, call.arguments)];
              return `${resolvedName}(${callArguments.join(", ")})`;
            }
          }
        }
        const overloadedName = resolveOverloadedFunctionCall(call);
        const calleeText = overloadedName ?? emitExpression(call.callee, PREC_MEMBER, "left");
        const argumentsText = emitCallArgumentTexts(call.callee, call.arguments).join(", ");
        const isClassCall =
          call.optional !== true &&
          call.callee.kind === "Identifier" &&
          (activeState.classNames.has((call.callee as Identifier).name) ||
            activeState.constructableOnlyNames.has((call.callee as Identifier).name));
        return isClassCall
          ? `new ${calleeText}(${argumentsText})`
          : `${calleeText}${call.optional ? "?." : ""}(${argumentsText})`;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        const calleeText = emitExpression(newExpression.callee, PREC_MEMBER, "left");
        if (newExpression.arguments) {
          return `new ${calleeText}(${emitCallArgumentTexts(newExpression.callee, newExpression.arguments).join(", ")})`;
        }
        return `new ${calleeText}`;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        if (unary.operator === "go") {
          // `go expr` is a compile-time marker that opts out of sync auto-await; emit the inner
          // expression unchanged so the underlying Promise flows through untouched.
          return emitExpression(unary.argument, parentPrecedence, side);
        }
        const unaryOperatorMethod = resolveUnaryOperatorMethod(unary);
        if (unaryOperatorMethod) {
          const argumentText = emitExpression(unary.argument, PREC_MEMBER, "left");
          return `${argumentText}.${unaryOperatorMethod.emittedName}()`;
        }
        const unaryOperator =
          unary.operator === "typeof" ||
          unary.operator === "void" ||
          unary.operator === "delete" ||
          unary.operator === "await" ||
          unary.operator === "yield" ||
          unary.operator === "yield*"
            ? `${unary.operator} `
            : unary.operator;
        const unaryText = `${unaryOperator}${emitExpression(unary.argument, PREC_UNARY, "right")}`;
        return wrapLongExpressionIfNeeded(expression, unaryText);
      }
      case "UpdateExpression": {
        const update = expression as UpdateExpression;
        const delegateUpdate = emitVariableDelegateUpdate(update);
        if (delegateUpdate) {
          return delegateUpdate;
        }
        if (update.prefix) {
          return `${update.operator}${emitExpression(update.argument, PREC_UNARY, "right")}`;
        }
        return `${emitExpression(update.argument, PREC_UPDATE, "left")}${update.operator}`;
      }
      case "SpreadExpression":
        return `...${emitExpression((expression as SpreadExpression).argument, PREC_UNARY, "right")}`;
      case "NamedArgument":
        // Reached only when a named argument is emitted outside a call's
        // argument list; emit its value so the output stays valid.
        return emitExpression((expression as NamedArgument).value, parentPrecedence, side);
      case "ArrayLiteral":
        return `[${(expression as ArrayLiteral).elements.map((element) => emitListElement(element)).join(", ")}]`;
      case "ObjectLiteral": {
        const objectLiteral = expression as ObjectLiteral;
        return `{${objectLiteral.properties
          .map((property) => {
            if (property.kind === "ObjectSpreadProperty") {
              return `...${emitExpression((property as ObjectSpreadProperty).argument)}`;
            }
            const objectProperty = property as ObjectProperty;
            if (objectProperty.shorthand && objectProperty.key.kind === "Identifier") {
              return (objectProperty.key as Identifier).name;
            }
            const key = emitObjectPropertyKey(objectProperty);
            if (objectProperty.method && objectProperty.value.kind === "FunctionExpression") {
              const fn = objectProperty.value as FunctionExpression;
              return withVariableDelegateShadows(
                functionParameterBindingNames(fn.parameters),
                () => `${key}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`
              );
            }
            return `${key}: ${emitListElement(objectProperty.value)}`;
          })
          .join(", ")}}`;
      }
      case "ArrowFunctionExpression": {
        const arrow = expression as ArrowFunctionExpression;
        if (arrow.contextualObjectLiteral && activeState.expressionTypes?.get(expression as unknown as Node)?.kind !== "function") {
          return emitExpression(arrow.contextualObjectLiteral, parentPrecedence, side);
        }
        const parameters = `(${emitFunctionParameters(arrow.parameters)})`;
        return withVariableDelegateShadows(functionParameterBindingNames(arrow.parameters), () => {
          if (arrow.body.kind === "BlockStatement") {
            return `${asyncEmitPrefix(arrow)}${parameters} => ${emitBlock(arrow.body as BlockStatement)}`;
          }
          const bodyExpression = arrow.body as Expr;
          const bodyText = emitExpression(bodyExpression);
          if (bodyExpression.kind === "ObjectLiteral") {
            return `${asyncEmitPrefix(arrow)}${parameters} => (${bodyText})`;
          }
          return `${asyncEmitPrefix(arrow)}${parameters} => ${bodyText}`;
        });
      }
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        const name = fn.name ? ` ${fn.name.name}` : "";
        return withVariableDelegateShadows(
          functionParameterBindingNames(fn.parameters),
          () => `${asyncEmitPrefix(fn)}function${fn.generator === true ? "*" : ""}${name}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`
        );
      }
      case "JsxElement":
        return emitJsxElement(expression as JsxElement);
      case "JsxFragment":
        return emitJsxFragment(expression as JsxFragment);
      default:
        return "undefined";
    }
  };

  let self = emitSelf();
  let effectivePrecedence = currentPrecedence;

  if (isAutoAwaited(expression)) {
    // Wrap the (Promise-typed) expression in an implicit `await`. The awaited result binds as a
    // unary expression, so parenthesize the operand when it would otherwise bind looser.
    self = `await ${maybeWrap(self, currentPrecedence < PREC_UNARY)}`;
    effectivePrecedence = PREC_UNARY;
  }

  if (effectivePrecedence < parentPrecedence) {
    return `(${self})`;
  }

  if (effectivePrecedence === parentPrecedence && expression.kind === "AssignmentExpression" && side === "left") {
    return `(${self})`;
  }

  return self;
}

function emitEnumComputedMemberExpression(member: MemberExpression, objectText: string): string | null {
  const directEnumName =
    member.object.kind === "Identifier"
      ? (member.object as Identifier).name
      : null;
  const objectType = activeState.expressionTypes?.get(member.object as unknown as Node);
  const enumName =
    directEnumName && activeState.enumInfos.has(directEnumName)
      ? directEnumName
      : objectType?.kind === "named" && activeState.enumInfos.has(objectType.name)
        ? objectType.name
        : null;
  if (!enumName) {
    return null;
  }
  const enumInfo = activeState.enumInfos.get(enumName);
  if (!enumInfo) {
    return null;
  }

  const keyText = emitExpression(member.property);
  const memberNames = JSON.stringify(Array.from(enumInfo.memberNames));
  const body = `(function ($enum, $key) { return ${memberNames}.includes($key) ? $enum[$key] : Object.values($enum).includes($key) ? $key : undefined; })(${objectText}, ${keyText})`;
  return member.optional ? `(${objectText} == null ? undefined : ${body})` : body;
}

function emitFunctionParameters(parameters: FunctionParameter[]): string {
  return parameters
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => {
      const restPrefix = parameter.rest ? "..." : "";
      if (parameter.defaultValue) {
        return `${restPrefix}${emitBindingName(parameter.name)} = ${emitListElement(parameter.defaultValue)}`;
      }
      return `${restPrefix}${emitBindingName(parameter.name)}`;
    })
    .join(", ");
}

function emitBindingElement(element: BindingElement, objectPattern: boolean): string {
  const rest = element.rest ? "..." : "";
  const name = emitBindingName(element.name);
  const property = objectPattern && element.propertyName ? `${element.propertyName.name}: ` : "";
  const initializer = element.initializer ? ` = ${emitListElement(element.initializer)}` : "";
  return `${rest}${property}${name}${initializer}`;
}

function emitBindingName(binding: BindingName): string {
  if (binding.kind === "Identifier") return resolveJsName(binding.name);
  if (binding.kind === "ObjectBindingPattern") {
    return `{ ${binding.elements.map((element) => emitBindingElement(element, true)).join(", ")} }`;
  }
  const elements = binding.elements.map((element) => element.kind === "BindingHole" ? "" : emitBindingElement(element, false)).join(", ");
  const trailingHole = binding.elements.at(-1)?.kind === "BindingHole" ? "," : "";
  return `[${elements}${trailingHole}]`;
}

function emitVarDeclarator(declarator: VarDeclarator): string {
  if (declarator.delegate && declarator.name.kind === "Identifier") {
    return `${variableDelegateBackingName(declarator.name.name)} = ${emitListElement(declarator.delegate)}`;
  }
  if (declarator.initializer) {
    return `${emitBindingName(declarator.name)} = ${emitListElement(declarator.initializer)}`;
  }
  return emitBindingName(declarator.name);
}

function emitVarStatementBody(statement: VarStatement): string {
  if (statement.declarations && statement.declarations.length > 0) {
    return statement.declarations.map((declaration) => emitVarDeclarator(declaration)).join(", ");
  }
  if (statement.initializer) {
    return `${emitBindingName(statement.name)} = ${emitListElement(statement.initializer)}`;
  }
  return emitBindingName(statement.name);
}

function emitVarStatement(statement: VarStatement): string {
  if (statement.declared) {
    return "";
  }
  if (statement.declarations && statement.declarations.some((declaration) => declaration.delegate)) {
    return statement.declarations.map((declaration) => {
      const kind = declaration.delegate ? "const" : normalizeVarKind(statement.declarationKind);
      return `${kind} ${emitVarDeclarator(declaration)};`;
    }).join("\n");
  }
  if (statement.delegate && statement.name.kind === "Identifier") {
    return `const ${variableDelegateBackingName(statement.name.name)} = ${emitListElement(statement.delegate)};`;
  }
  return `${normalizeVarKind(statement.declarationKind)} ${emitVarStatementBody(statement)};`;
}

function emitBlock(statement: BlockStatement): string {
  if (statement.body.length === 0) {
    return "{}";
  }
  return `{
${statement.body.map((child) => emitStatement(child)).join("\n")}
}`;
}

function emitForIteratorHeader(iterator: ForStatement["iterator"]): string {
  if (!iterator) {
    return "";
  }

  if (iterator.kind === "VarStatement") {
    const varStatement = iterator as VarStatement;
    return `${normalizeVarKind(varStatement.declarationKind)} ${emitVarStatementBody(varStatement)}`;
  }

  if (iterator.kind === "Identifier") {
    return (iterator as Identifier).name;
  }

  return emitExpression(iterator as Expr);
}

function classInstanceMemberNames(statement: ClassStatement, members: Array<ClassFieldMember | ClassMethodMember>): Set<string> {
  const names = new Set<string>();
  for (const parameter of statement.primaryConstructorParameters ?? []) {
    names.add(parameter.name.name);
  }
  for (const constructor of members.filter(
    (member): member is ClassMethodMember => member.kind === "ClassMethodMember" && member.name.name === "constructor"
  )) {
    for (const parameter of constructor.parameters) {
      if (parameter.name.kind === "Identifier" && (parameter.accessModifier !== undefined || parameter.readonly === true)) {
        names.add(parameter.name.name);
      }
    }
  }
  for (const member of members) {
    if (member.name.name !== "constructor" && member.static !== true) {
      names.add(member.name.name);
    }
  }
  return names;
}

function emitClassDelegateTarget(expression: Expr, instanceMemberNames: Set<string>): string {
  if (expression.kind === "ObjectLiteral") {
    const objectLiteral = expression as ObjectLiteral;
    if (objectLiteral.properties.length === 1) {
      const property = objectLiteral.properties[0]!;
      if (property.kind === "ObjectProperty" && (property as ObjectProperty).shorthand === true) {
        return emitClassDelegateTarget((property as ObjectProperty).value, instanceMemberNames);
      }
    }
  }
  if (expression.kind === "Identifier" && instanceMemberNames.has((expression as Identifier).name)) {
    return `this.${(expression as Identifier).name}`;
  }
  if (expression.kind === "ArrowFunctionExpression" || expression.kind === "FunctionExpression") {
    return `(${emitExpression(expression, PREC_MEMBER, "left")})()`;
  }
  return emitExpression(expression, PREC_MEMBER, "left");
}

function emitClassDelegateMembers(statement: ClassStatement, members: Array<ClassFieldMember | ClassMethodMember>): string[] {
  const existingNames = new Set(members.map((member) => member.name.name));
  const instanceMemberNames = classInstanceMemberNames(statement, members);
  const lines: string[] = [];
  for (const classDelegate of statement.classDelegates ?? []) {
    for (const interfaceMember of activeState.interfaceMembers.get(classDelegate.typeAnnotation.name) ?? []) {
      if (existingNames.has(interfaceMember.name.name)) {
        continue;
      }
      existingNames.add(interfaceMember.name.name);
      const target = emitClassDelegateTarget(classDelegate.expression, instanceMemberNames);
      if (interfaceMember.kind === "InterfacePropertyMember") {
        lines.push(`get ${interfaceMember.name.name}() { return ${target}.${interfaceMember.name.name}; }`);
      } else {
        const parameters = emitFunctionParameters(interfaceMember.parameters);
        const argumentNames = interfaceMember.parameters
          .filter((parameter) => parameter.thisParameter !== true)
          .map((parameter) => (parameter.name as Identifier).name);
        lines.push(`${interfaceMember.name.name}(${parameters}) { return ${target}.${interfaceMember.name.name}(${argumentNames.join(", ")}); }`);
      }
    }
  }
  return lines;
}

function emitClassPrimaryConstructor(
  parameters: ClassPrimaryConstructorParameter[] | undefined,
  members: Array<ClassFieldMember | ClassMethodMember>
): string | null {
  if (!parameters || parameters.length === 0) {
    return null;
  }

  const hasExplicitConstructor = members.some(
    (member) => member.kind === "ClassMethodMember" && member.name.name === "constructor"
  );
  if (hasExplicitConstructor) {
    return null;
  }

  const params = parameters.map((parameter) => parameter.name.name).join(", ");
  const assignments: string[] = [];

  for (const parameter of parameters) {
    assignments.push(`this.${(parameter.name as Identifier).name} = ${(parameter.name as Identifier).name};`);
  }

  return `constructor(${params}) {${assignments.length > 0 ? ` ${assignments.join(" ")}` : ""} }`;
}

function isParameterProperty(parameter: FunctionParameter): boolean {
  return parameter.accessModifier !== undefined || parameter.readonly === true;
}

function emitConstructorBlock(method: ClassMethodMember): string {
  const assignments = method.parameters
    .filter(isParameterProperty)
    .map((parameter) => `this.${(parameter.name as Identifier).name} = ${(parameter.name as Identifier).name};`);
  if (assignments.length === 0) {
    return emitBlock(method.body);
  }

  const emittedStatements = method.body.body.map((statement) => emitStatement(statement));
  const firstStatement = method.body.body[0];
  const insertAt = firstStatement?.kind === "ExprStatement" &&
    (firstStatement as ExprStatement).expression.kind === "CallExpression" &&
    ((firstStatement as ExprStatement).expression as CallExpression).callee.kind === "Identifier" &&
    (((firstStatement as ExprStatement).expression as CallExpression).callee as Identifier).name === "super"
      ? 1
      : 0;
  emittedStatements.splice(insertAt, 0, ...assignments);
  return `{
${emittedStatements.join("\n")}
}`;
}

function emitClassMember(member: ClassFieldMember | ClassMethodMember): string {
  const staticPrefix = member.static === true ? "static " : "";
  if (member.kind === "ClassFieldMember") {
    const field = member as ClassFieldMember;
    if (field.initializer) {
      return `${staticPrefix}${field.name.name} = ${emitListElement(field.initializer)};`;
    }
    return `${staticPrefix}${field.name.name};`;
  }

  const method = member as ClassMethodMember;
  const accessorPrefix = method.accessorKind ? `${method.accessorKind} ` : "";
  const asyncPrefix = asyncEmitPrefix(method);
  const generatorPrefix = method.generator === true ? "*" : "";
  const methodName = method.computed
    ? `[${emitExpression(method.computedKey!)}]`
    : method.operator
      ? operatorMethodName(method.operator, method.parameters)
      : method.name.name;
  return withVariableDelegateShadows(functionParameterBindingNames(method.parameters), () => {
    const body = methodName === "constructor" ? emitConstructorBlock(method) : emitBlock(method.body);
    return `${staticPrefix}${asyncPrefix}${accessorPrefix}${generatorPrefix}${methodName}(${emitFunctionParameters(method.parameters)}) ${body}`;
  });
}

function isAsyncFor(statement: ForStatement): boolean {
  // lowerProgram creates new ForStatement objects but copies firstToken by reference via copyNodeBounds,
  // so we match by firstToken identity rather than node identity.
  if (!statement.firstToken) return false;
  for (const node of activeState.asyncForStatements) {
    if ((node as { firstToken?: unknown }).firstToken === statement.firstToken) return true;
  }
  return false;
}

function emitForStatement(statement: ForStatement): string {
  if (statement.iterationKind && statement.iterator && statement.iterable) {
    const awaitPrefix = isAsyncFor(statement) ? "await " : "";
    if (statement.iterator.kind === "Identifier") {
      const iteratorName = (statement.iterator as Identifier).name;
      return `for ${awaitPrefix}(const ${iteratorName} of ${emitExpression(statement.iterable)}) ${emitStatement(statement.body)}`;
    }

    return `for ${awaitPrefix}(${emitForIteratorHeader(statement.iterator)} ${statement.iterationKind} ${emitExpression(statement.iterable)}) ${emitStatement(statement.body)}`;
  }

  const initializer = statement.initializer
    ? statement.initializer.kind === "VarStatement"
      ? `${normalizeVarKind((statement.initializer as VarStatement).declarationKind)} ${emitVarStatementBody(statement.initializer as VarStatement)}`
      : emitExpression(statement.initializer as Expr)
    : "";
  const condition = statement.condition ? emitExpression(statement.condition) : "";
  const update = statement.update ? emitExpression(statement.update) : "";

  return `for (${initializer}; ${condition}; ${update}) ${emitStatement(statement.body)}`;
}


function emitEnumStatement(statement: EnumStatement): string {
  if (statement.declared) {
    return "";
  }

  const name = resolveJsName(statement.name.name);
  const lines: string[] = [`var ${name};`, `(function (${name}) {`];
  let nextNumericValue = 0;
  const emittedMemberNames = new Set<string>();
  for (const member of statement.members) {
    const memberName = member.name.name;
    if (member.initializer) {
      const initializer = emitEnumInitializerExpression(member.initializer, name, emittedMemberNames);
      if (member.initializer.kind === "StringLiteral") {
        lines.push(`  ${name}[${JSON.stringify(memberName)}] = ${initializer};`);
      } else {
        lines.push(`  ${name}[${name}[${JSON.stringify(memberName)}] = ${initializer}] = ${JSON.stringify(memberName)};`);
      }
      if (member.initializer.kind === "IntLiteral") {
        nextNumericValue = (member.initializer as IntLiteral).value + 1;
      } else {
        nextNumericValue = 0;
      }
      emittedMemberNames.add(memberName);
      continue;
    }
    lines.push(`  ${name}[${name}[${JSON.stringify(memberName)}] = ${nextNumericValue}] = ${JSON.stringify(memberName)};`);
    nextNumericValue += 1;
    emittedMemberNames.add(memberName);
  }
  lines.push(`})(${name} || (${name} = {}));`);
  return lines.join("\n");
}

function emitEnumInitializerExpression(expression: Expr, enumName: string, memberNames: ReadonlySet<string>): string {
  switch (expression.kind) {
    case "Identifier": {
      const identifier = expression as Identifier;
      return memberNames.has(identifier.name) ? `${enumName}.${identifier.name}` : emitExpression(expression);
    }
    case "BinaryExpression": {
      const binary = expression as BinaryExpression;
      return `${emitEnumInitializerExpression(binary.left, enumName, memberNames)} ${binary.operator} ${emitEnumInitializerExpression(binary.right, enumName, memberNames)}`;
    }
    case "UnaryExpression": {
      const unary = expression as UnaryExpression;
      const spacing = /^[A-Za-z]/.test(unary.operator) ? " " : "";
      return `${unary.operator}${spacing}${emitEnumInitializerExpression(unary.argument, enumName, memberNames)}`;
    }
    case "MemberExpression": {
      const member = expression as MemberExpression;
      const objectText = emitEnumInitializerExpression(member.object, enumName, memberNames);
      if (member.computed) {
        return `${objectText}[${emitEnumInitializerExpression(member.property, enumName, memberNames)}]`;
      }
      if (member.property.kind === "Identifier") {
        return `${objectText}.${(member.property as Identifier).name}`;
      }
      return `${objectText}.${emitEnumInitializerExpression(member.property, enumName, memberNames)}`;
    }
    default:
      return emitExpression(expression);
  }
}

function exportedDeclarationNames(statement: Statement): string[] {
  if (statement.kind === "VarStatement") {
    const variable = statement as VarStatement;
    if (variable.declarations && variable.declarations.length > 0) {
      return variable.declarations.flatMap((declaration) => bindingIdentifiers(declaration.name).map((identifier) => identifier.name));
    }
    return bindingIdentifiers(variable.name).map((identifier) => identifier.name);
  }
  if (statement.kind === "FunctionStatement" || statement.kind === "ClassStatement" || statement.kind === "EnumStatement") {
    return [(statement as FunctionStatement | ClassStatement | EnumStatement).name.name];
  }
  if (statement.kind === "NamespaceStatement") {
    return (statement as NamespaceStatement).names?.slice(0, 1).map((name) => name.name) ?? [];
  }
  return [];
}

function indentEmitted(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function emitNamespaceStatement(statement: NamespaceStatement): string {
  if (statement.declared || !statement.names || statement.names.length === 0) {
    return "";
  }

  const path = statement.names.map((name) => name.name);
  const root = path[0]!;
  const alias = path.at(-1)!;
  const target = path.join(".");
  const lines: string[] = [`var ${root};`];
  if (path.length > 1) {
    lines.push(`${root} = ${root} || {};`);
    for (let index = 1; index < path.length; index += 1) {
      const current = path.slice(0, index + 1).join(".");
      lines.push(`${current} = ${current} || {};`);
    }
  }
  lines.push(`(function (${alias}) {`);
  for (const child of statement.body.body) {
    if (child.kind !== "ExportStatement") {
      const emitted = emitStatement(child);
      if (emitted) lines.push(indentEmitted(emitted));
      continue;
    }
    const exported = child as ExportStatement;
    if (exported.declaration) {
      const emitted = emitStatement(exported.declaration);
      if (emitted) lines.push(indentEmitted(emitted));
      for (const name of exportedDeclarationNames(exported.declaration)) {
        lines.push(`  ${alias}.${name} = ${name};`);
      }
    }
    for (const specifier of exported.specifiers ?? []) {
      const local = specifier.local?.name ?? specifier.exported.name;
      lines.push(`  ${alias}.${specifier.exported.name} = ${local};`);
    }
  }
  lines.push(path.length === 1
    ? `})(${root} || (${root} = {}));`
    : `})(${target});`);
  return lines.join("\n");
}

export function emitStatement(statement: Statement): string {
  switch (statement.kind) {
    case "ExportStatement": {
      const exportStatement = statement as ExportStatement;
      if (exportStatement.typeOnly || exportStatement.namespaceExport) {
        return "";
      }
      if (exportStatement.exportAll) {
        return exportStatement.from ? `export * from ${JSON.stringify(rewriteImportPath(exportStatement.from.value))};` : "";
      }
      if (exportStatement.specifiers) {
        const names = exportStatement.specifiers
          .map((specifier) => {
            // `@JsName` renames the local binding; keep the public exported name
            // stable and point the export at the renamed local when they differ.
            const localName = exportStatement.from ? (specifier.local ?? specifier.exported).name : resolveJsName((specifier.local ?? specifier.exported).name);
            return localName === specifier.exported.name ? specifier.exported.name : `${localName} as ${specifier.exported.name}`;
          })
          .join(", ");
        const fromClause = exportStatement.from ? ` from ${JSON.stringify(rewriteImportPath(exportStatement.from.value))}` : "";
        return `export { ${names} }${fromClause};`;
      }
      if (!exportStatement.declaration) {
        return "";
      }
      if (exportStatement.default && exportStatement.declaration.kind === "ExprStatement") {
        return `export default ${emitExpression((exportStatement.declaration as ExprStatement).expression)};`;
      }
      const emitted = emitStatement(exportStatement.declaration);
      if (!emitted) {
        return "";
      }
      return exportStatement.default ? `export default ${emitted}` : `export ${emitted}`;
    }
    case "ImportStatement": {
      const importStatement = statement as ImportStatement;
      if (importStatement.typeOnly) {
        return "";
      }
      const source = JSON.stringify(rewriteImportPath(importStatement.from.value));
      if (importStatement.sideEffectOnly) {
        return `import ${source};`;
      }
      const clauses: string[] = [];
      if (importStatement.defaultImport) {
        clauses.push(importStatement.defaultImport.name);
      }
      const namedImports: string[] = [];
      for (const specifier of importStatement.specifiers) {
        const extensionRuntimeNames = importedExtensionRuntimeNames(specifier.imported.name);
        if (extensionRuntimeNames.length > 0) {
          namedImports.push(...extensionRuntimeNames);
          continue;
        }

        const localName = specifier.local?.name ?? specifier.imported.name;
        const receiverType = activeState.extensionProperties.get(localName);
        if (receiverType) {
          const importedName = extensionPropertyRuntimeName(receiverType, specifier.imported.name);
          namedImports.push(specifier.local ? `${importedName} as ${specifier.local.name}` : importedName);
          continue;
        }

        if (!isOperatorImportName(specifier.imported.name)) {
          namedImports.push(specifier.local ? `${specifier.imported.name} as ${specifier.local.name}` : specifier.imported.name);
        }
      }
      const hadOperatorImport = importStatement.specifiers.some((specifier) => isOperatorImportName(specifier.imported.name));
      if (importStatement.namespaceImport) {
        clauses.push(`* as ${importStatement.namespaceImport.name}`);
      } else if (namedImports.length > 0) {
        clauses.push(`{ ${namedImports.join(", ")} }`);
      }
      if (clauses.length === 0) {
        // Operator-only import without cross-file declaration context: keep the
        // side-effecting load so bundled/local-module emission keeps working.
        return hadOperatorImport ? `import ${source};` : "";
      }
      return `import ${clauses.join(", ")} from ${source};`;
    }
    case "VarStatement": {
      const property = statement as VarStatement;
      if (property.receiverType) {
        const previousExtensionThis = activeExtensionThis;
        const previousReceiverTypeName = activeExtensionReceiverTypeName;
        activeExtensionThis = true;
        activeExtensionReceiverTypeName = property.receiverType.name;
        try {
          return `const ${extensionPropertyRuntimeName(property.receiverType.name, (property.name as Identifier).name)} = ($this) => ${property.initializer ? emitExpression(property.initializer) : "undefined"};`;
        } finally {
          activeExtensionThis = previousExtensionThis;
          activeExtensionReceiverTypeName = previousReceiverTypeName;
        }
      }
      return emitVarStatement(property);
    }
    case "EnumStatement":
      return emitEnumStatement(statement as EnumStatement);
    case "FunctionStatement": {
      const fn = statement as FunctionStatement;
      if (fn.declared || fn.missingBody) {
        return "";
      }
      if (fn.receiverType) {
        // Extension methods/operators are emitted as standalone receiver-mangled
        // functions whose first parameter is the receiver (`$this`). Implicit
        // member references and `this` inside the body resolve to `$this`.
        const baseName = fn.operator ? operatorBaseName(fn.operator) : fn.name.name;
        const emittedName = extensionMethodRuntimeName(fn.receiverType.name, baseName, fn.parameters);
        const visibleParameters = emitFunctionParameters(fn.parameters);
        const parameterList = visibleParameters.length > 0 ? `$this, ${visibleParameters}` : "$this";
        const previousExtensionThis = activeExtensionThis;
        const previousReceiverTypeName = activeExtensionReceiverTypeName;
        activeExtensionThis = true;
        activeExtensionReceiverTypeName = fn.receiverType.name;
        try {
          return withVariableDelegateShadows(
            functionParameterBindingNames(fn.parameters),
            () => `${asyncEmitPrefix(fn)}function${fn.generator === true ? "*" : ""} ${emittedName}(${parameterList}) ${emitBlock(fn.body)}`
          );
        } finally {
          activeExtensionThis = previousExtensionThis;
          activeExtensionReceiverTypeName = previousReceiverTypeName;
        }
      }
      const overloads = activeState.programOverloads.get(fn.name.name);
      const emittedName = activeState.jsNames.get(fn.name.name)
        ?? (overloads && overloads.length > 1 ? overloadedFunctionName(fn.name.name, fn.parameters) : fn.name.name);
      return withVariableDelegateShadows(
        functionParameterBindingNames(fn.parameters),
        () => `${asyncEmitPrefix(fn)}function${fn.generator === true ? "*" : ""} ${emittedName}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`
      );
    }
    case "ClassStatement": {
      const classStatement = statement as ClassStatement;
      if (classStatement.declared) {
        return "";
      }
      const members = [...classStatement.members];
      const syntheticConstructor = emitClassPrimaryConstructor(classStatement.primaryConstructorParameters, members);
      const memberLines = [
        ...(syntheticConstructor ? [syntheticConstructor] : []),
        ...members.map((member) => emitClassMember(member)),
        ...emitClassDelegateMembers(classStatement, members)
      ];
      const extendsClause = classStatement.extendsType && !activeState.interfaceNames.has(classStatement.extendsType.name)
        ? ` extends ${eraseTypeArguments(classStatement.extendsType.name)}`
        : "";
      return `class ${resolveJsName(classStatement.name.name)}${extendsClause} {${memberLines.length > 0 ? `\n${memberLines.join("\n")}\n` : ""}}`;
    }
    case "NamespaceStatement":
      return emitNamespaceStatement(statement as NamespaceStatement);
    case "InterfaceStatement":
    case "TypeAliasStatement":
      return "";
    case "ExprStatement":
      return `${emitExpression((statement as ExprStatement).expression)};`;
    case "EmptyStatement":
      return ";";
    case "DebuggerStatement":
      return "debugger;";
    case "BlockStatement":
      return emitBlock(statement as BlockStatement);
    case "WhileStatement": {
      const whileStatement = statement as WhileStatement;
      return `while (${emitExpression(whileStatement.condition)}) ${emitStatement(whileStatement.body)}`;
    }
    case "WithStatement": {
      const withStatement = statement as WithStatement;
      return `with (${emitExpression(withStatement.object)}) ${emitStatement(withStatement.body)}`;
    }
    case "LabeledStatement": {
      const labeled = statement as LabeledStatement;
      return `${labeled.label.name}: ${emitStatement(labeled.body)}`;
    }
    case "DoWhileStatement": {
      const doWhileStatement = statement as DoWhileStatement;
      return `do ${emitStatement(doWhileStatement.body)} while (${emitExpression(doWhileStatement.condition)});`;
    }
    case "ForStatement":
      return emitForStatement(statement as ForStatement);
    case "IfStatement": {
      const ifStatement = statement as IfStatement;
      if (ifStatement.elseBranch) {
        return `if (${emitExpression(ifStatement.condition)}) ${emitStatement(ifStatement.thenBranch)} else ${emitStatement(ifStatement.elseBranch)}`;
      }
      return `if (${emitExpression(ifStatement.condition)}) ${emitStatement(ifStatement.thenBranch)}`;
    }
    case "SwitchStatement": {
      const switchStatement = statement as SwitchStatement;
      const cases = switchStatement.cases
        .map((switchCase) => {
          const head = switchCase.test
            ? `case ${emitExpression(switchCase.test)}:`
            : "default:";
          const body = switchCase.consequent.map((consequent) => emitStatement(consequent)).join("\n");
          return `${head}${body.length > 0 ? `\n${body}` : ""}`;
        })
        .join("\n");
      return `switch (${emitExpression(switchStatement.discriminant)}) {${cases.length > 0 ? `\n${cases}\n` : ""}}`;
    }
    case "ReturnStatement": {
      const returnStatement = statement as ReturnStatement;
      if (returnStatement.expression) {
        return `return ${emitExpression(returnStatement.expression)};`;
      }
      return "return;";
    }
    case "ThrowStatement": {
      const throwStatement = statement as ThrowStatement;
      return `throw ${emitExpression(throwStatement.expression)};`;
    }
    case "TryStatement": {
      const tryStatement = statement as TryStatement;
      const tryPart = `try ${emitBlock(tryStatement.tryBlock)}`;
      const catchPart = tryStatement.catchClause
        ? tryStatement.catchClause.parameter
          ? ` catch (${tryStatement.catchClause.parameter.name}) ${emitBlock(tryStatement.catchClause.body)}`
          : ` catch ${emitBlock(tryStatement.catchClause.body)}`
        : "";
      const finallyPart = tryStatement.finallyBlock
        ? ` finally ${emitBlock(tryStatement.finallyBlock)}`
        : "";
      return `${tryPart}${catchPart}${finallyPart}`;
    }
    case "ContinueStatement": {
      const label = (statement as import("compiler/ast/ast").ContinueStatement).label;
      return label ? `continue ${label.name};` : "continue;";
    }
    case "BreakStatement": {
      const label = (statement as import("compiler/ast/ast").BreakStatement).label;
      return label ? `break ${label.name};` : "break;";
    }
    default:
      return "";
  }
}

export function emitProgram(
  program: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>,
  implicitReceiverIdentifiers?: ReadonlySet<Node>,
  autoAwaitExpressions?: ReadonlySet<Node>,
  options: EmitOptions = {},
  asyncForStatements?: ReadonlySet<Node>
): string {
  const runtimeContext = createEmitProgramRuntimeContext(program, expressionTypes, options);
  return emitProgramStatements(
    program,
    expressionTypes,
    program,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    runtimeContext,
    new Map(),
    asyncForStatements
  ).join("\n");
}

interface EmitProgramRuntimeContext {
  overloads: Map<string, RuntimeOverloadInfo[]>;
  operators: Map<string, RuntimeOperatorInfo[]>;
  extensionMethods: Map<string, RuntimeExtensionMethodInfo[]>;
  importedExtensionRuntimeNames: Map<string, string[]>;
  extensionProperties: Map<string, string>;
  classNames: Set<string>;
  interfaceNames: Set<string>;
  interfaceMembers: Map<string, InterfaceStatement["members"]>;
  constructableOnlyNames: Set<string>;
  parameterNames: Map<string, string[]>;
  javaScriptImplementations: Map<string, JavaScriptImplementationInfo>;
  jsNames: Map<string, string>;
  variableDelegates: Map<string, RuntimeVariableDelegateInfo>;
  enumInfos: Map<string, RuntimeEnumInfo>;
  rewriteImportExtensions: boolean;
  jsxFactory: string;
  jsxFragmentFactory: string;
}

interface EmitProgramRuntimeSeed {
  overloadBuckets: Map<string, FunctionStatement[]>;
  operators: Map<string, RuntimeOperatorInfo[]>;
  extensionMethods: Map<string, RuntimeExtensionMethodInfo[]>;
  importedExtensionRuntimeNames: Map<string, string[]>;
  extensionProperties: Map<string, string>;
  classNames: Set<string>;
  interfaceNames: Set<string>;
  interfaceMembers: Map<string, InterfaceStatement["members"]>;
  interfaceMethodNames: Map<string, Set<string>>;
  constructableCandidates: Array<{ variableName: string; typeName: string }>;
  parameterNames: Map<string, string[]>;
  javaScriptImplementations: Map<string, JavaScriptImplementationInfo>;
  jsNames: Map<string, string>;
  enumInfos: Map<string, RuntimeEnumInfo>;
}

function appendMapArrayValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

function appendUniqueMapArrayValue(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(value)) {
      existing.push(value);
    }
    return;
  }
  map.set(key, [value]);
}

function cloneMapArrayValues<T>(map: Map<string, T[]>): Map<string, T[]> {
  return new Map(Array.from(map.entries(), ([key, values]) => [key, [...values]]));
}

function cloneSetMapValues<T>(map: Map<string, Set<T>>): Map<string, Set<T>> {
  return new Map(Array.from(map.entries(), ([key, values]) => [key, new Set(values)]));
}

function cloneRuntimeSeed(seed: EmitProgramRuntimeSeed): EmitProgramRuntimeSeed {
  return {
    overloadBuckets: cloneMapArrayValues(seed.overloadBuckets),
    operators: cloneMapArrayValues(seed.operators),
    extensionMethods: cloneMapArrayValues(seed.extensionMethods),
    importedExtensionRuntimeNames: cloneMapArrayValues(seed.importedExtensionRuntimeNames),
    extensionProperties: new Map(seed.extensionProperties),
    classNames: new Set(seed.classNames),
    interfaceNames: new Set(seed.interfaceNames),
    interfaceMembers: new Map(seed.interfaceMembers),
    interfaceMethodNames: cloneSetMapValues(seed.interfaceMethodNames),
    constructableCandidates: [...seed.constructableCandidates],
    parameterNames: cloneMapArrayValues(seed.parameterNames),
    javaScriptImplementations: new Map(seed.javaScriptImplementations),
    jsNames: new Map(seed.jsNames),
    enumInfos: new Map(seed.enumInfos)
  };
}

export function createEmitProgramRuntimeSeed(contextProgram: Program): EmitProgramRuntimeSeed {
  const overloadBuckets = new Map<string, FunctionStatement[]>();
  const operators = new Map<string, RuntimeOperatorInfo[]>();
  const extensionMethods = new Map<string, RuntimeExtensionMethodInfo[]>();
  const importedExtensionRuntimeNames = new Map<string, string[]>();
  const extensionProperties = new Map<string, string>();
  const classNames = new Set<string>();
  const interfaceNames = new Set<string>();
  const interfaceMembers = new Map<string, InterfaceStatement["members"]>();
  const interfaceMethodNames = new Map<string, Set<string>>();
  const constructableCandidates: Array<{ variableName: string; typeName: string }> = [];
  const parameterNames = new Map<string, string[]>();
  const javaScriptImplementations = new Map<string, JavaScriptImplementationInfo>();
  const jsNames = new Map<string, string>();
  const enumInfos = new Map<string, RuntimeEnumInfo>();

  for (const statement of contextProgram.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (!candidate) {
      continue;
    }

    const jsName = candidate.jsName ?? statement.jsName;
    if (jsName !== undefined) {
      if (
        candidate.kind === "FunctionStatement" ||
        candidate.kind === "ClassStatement" ||
        candidate.kind === "EnumStatement" ||
        candidate.kind === "InterfaceStatement"
      ) {
        const named = candidate as unknown as { name: Identifier };
        jsNames.set(named.name.name, jsName);
      } else if (candidate.kind === "VarStatement") {
        const variable = candidate as VarStatement;
        if (variable.name.kind === "Identifier") {
          jsNames.set((variable.name as Identifier).name, jsName);
        }
      }
    }

    if (candidate.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      if (fn.jsInline !== undefined) {
        javaScriptImplementations.set(fn.name.name, { template: fn.jsInline, parameters: fn.parameters });
      }
      if (!fn.receiverType) {
        if (!fn.declared) {
          appendMapArrayValue(overloadBuckets, fn.name.name, fn);
        }
        if (!parameterNames.has(fn.name.name)) {
          parameterNames.set(fn.name.name, functionParameterNames(fn.parameters));
        }
        continue;
      }
      if (fn.operator) {
        const emittedName = extensionMethodRuntimeName(fn.receiverType.name, operatorBaseName(fn.operator), fn.parameters);
        const info: RuntimeOperatorInfo = {
          operator: fn.operator,
          emittedName,
          parameterTypes: fn.parameters.filter((parameter) => parameter.thisParameter !== true).map(parameterTypeName),
          hasBody: fn.missingBody !== true,
          extension: true
        };
        appendMapArrayValue(operators, fn.receiverType.name, info);
        appendUniqueMapArrayValue(importedExtensionRuntimeNames, `operator${fn.operator}`, emittedName);
      } else {
        const emittedName = extensionMethodRuntimeName(fn.receiverType.name, fn.name.name, fn.parameters);
        const info: RuntimeExtensionMethodInfo = {
          name: fn.name.name,
          emittedName,
          parameterTypes: fn.parameters.filter((parameter) => parameter.thisParameter !== true).map(parameterTypeName),
          hasBody: fn.missingBody !== true
        };
        appendMapArrayValue(extensionMethods, fn.receiverType.name, info);
        appendUniqueMapArrayValue(importedExtensionRuntimeNames, fn.name.name, emittedName);
      }
      continue;
    }

    if (candidate.kind === "ClassStatement") {
      const classStatement = candidate as ClassStatement;
      classNames.add(classStatement.name.name);
      if (!parameterNames.has(classStatement.name.name)) {
        const primaryNames = (classStatement.primaryConstructorParameters ?? [])
          .map((parameter) => parameterBindingName(parameter.name))
          .filter((name): name is string => name !== null);
        if (primaryNames.length > 0) {
          parameterNames.set(classStatement.name.name, primaryNames);
        } else {
          const constructor = classStatement.members.find(
            (member): member is ClassMethodMember =>
              member.kind === "ClassMethodMember" && member.name.name === "constructor"
          );
          if (constructor) {
            parameterNames.set(classStatement.name.name, functionParameterNames(constructor.parameters));
          }
        }
      }
      for (const member of classStatement.members) {
        if (member.kind !== "ClassMethodMember" || !member.operator) {
          continue;
        }
        appendMapArrayValue(operators, classStatement.name.name, {
          operator: member.operator,
          emittedName: operatorMethodName(member.operator, member.parameters),
          parameterTypes: member.parameters.map(parameterTypeName),
          hasBody: member.missingBody !== true,
          extension: false
        });
      }
      continue;
    }

    if (candidate.kind === "InterfaceStatement") {
      const interfaceStatement = candidate as InterfaceStatement;
      interfaceNames.add(interfaceStatement.name.name);
      interfaceMembers.set(interfaceStatement.name.name, interfaceStatement.members);
      const names = interfaceMethodNames.get(interfaceStatement.name.name) ?? new Set<string>();
      for (const member of interfaceStatement.members) {
        if (member.kind === "InterfaceMethodMember") {
          names.add(member.name.name);
        }
      }
      interfaceMethodNames.set(interfaceStatement.name.name, names);
      continue;
    }

    if (candidate.kind === "EnumStatement") {
      const enumStatement = candidate as EnumStatement;
      const rawValues: Array<string | number> = [];
      let nextNumericValue = 0;
      for (const member of enumStatement.members) {
        if (!member.initializer) {
          rawValues.push(nextNumericValue);
          nextNumericValue += 1;
          continue;
        }
        if (member.initializer.kind === "IntLiteral") {
          rawValues.push((member.initializer as IntLiteral).value);
          nextNumericValue = (member.initializer as IntLiteral).value + 1;
          continue;
        }
        if (member.initializer.kind === "StringLiteral") {
          rawValues.push((member.initializer as StringLiteral).value);
        }
      }
      enumInfos.set(enumStatement.name.name, {
        memberNames: new Set(enumStatement.members.map((member) => member.name.name)),
        rawValues
      });
      continue;
    }

    if (candidate.kind === "VarStatement") {
      const variable = candidate as VarStatement;
      if (variable.receiverType && variable.name.kind === "Identifier") {
        extensionProperties.set((variable.name as Identifier).name, variable.receiverType.name);
      }
      if (variable.name.kind === "Identifier") {
        const typeName = variable.typeAnnotation?.name;
        if (typeName) {
          constructableCandidates.push({ variableName: variable.name.name, typeName });
        }
      }
    }
  }

  return {
    overloadBuckets,
    operators,
    extensionMethods,
    importedExtensionRuntimeNames,
    extensionProperties,
    classNames,
    interfaceNames,
    interfaceMembers,
    interfaceMethodNames,
    constructableCandidates,
    parameterNames,
    javaScriptImplementations,
    jsNames,
    enumInfos
  };
}

function collectEmitProgramRuntimeContext(
  contextProgram: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>,
  options: EmitOptions = {},
  baseSeed?: EmitProgramRuntimeSeed
): EmitProgramRuntimeContext {
  const seed = baseSeed ? cloneRuntimeSeed(baseSeed) : createEmitProgramRuntimeSeed({ ...contextProgram, body: [] });
  const overloadBuckets = seed.overloadBuckets;
  const operators = seed.operators;
  const extensionMethods = seed.extensionMethods;
  const importedExtensionRuntimeNames = seed.importedExtensionRuntimeNames;
  const extensionProperties = seed.extensionProperties;
  const classNames = seed.classNames;
  const interfaceNames = seed.interfaceNames;
  const interfaceMembers = seed.interfaceMembers;
  const interfaceMethodNames = seed.interfaceMethodNames;
  const enumInfos = seed.enumInfos;
  const constructableOnlyNames = new Set<string>();
  const constructableCandidates = seed.constructableCandidates;
  const parameterNames = seed.parameterNames;
  const javaScriptImplementations = seed.javaScriptImplementations;
  const jsNames = seed.jsNames;
  const importedNames = new Set<string>();

  for (const statement of contextProgram.body) {
    if (statement.kind === "ImportStatement") {
      for (const specifier of (statement as ImportStatement).specifiers) {
        importedNames.add((specifier.local ?? specifier.imported).name);
      }
    }

    const statementSeed = createEmitProgramRuntimeSeed({ ...contextProgram, body: [statement] });
    for (const [name, functions] of statementSeed.overloadBuckets) {
      const existing = overloadBuckets.get(name);
      if (existing) {
        existing.push(...functions);
      } else {
        overloadBuckets.set(name, [...functions]);
      }
    }
    for (const [key, values] of statementSeed.operators) {
      for (const value of values) {
        appendMapArrayValue(operators, key, value);
      }
    }
    for (const [key, values] of statementSeed.extensionMethods) {
      for (const value of values) {
        appendMapArrayValue(extensionMethods, key, value);
      }
    }
    for (const [key, values] of statementSeed.importedExtensionRuntimeNames) {
      for (const value of values) {
        appendUniqueMapArrayValue(importedExtensionRuntimeNames, key, value);
      }
    }
    for (const [key, value] of statementSeed.extensionProperties) {
      extensionProperties.set(key, value);
    }
    for (const value of statementSeed.classNames) {
      classNames.add(value);
    }
    for (const value of statementSeed.interfaceNames) {
      interfaceNames.add(value);
    }
    for (const [key, value] of statementSeed.interfaceMembers) {
      interfaceMembers.set(key, value);
    }
    for (const [key, values] of statementSeed.interfaceMethodNames) {
      const existing = interfaceMethodNames.get(key) ?? new Set<string>();
      for (const value of values) {
        existing.add(value);
      }
      interfaceMethodNames.set(key, existing);
    }
    constructableCandidates.push(...statementSeed.constructableCandidates);
    for (const [key, value] of statementSeed.parameterNames) {
      if (!parameterNames.has(key)) {
        parameterNames.set(key, value);
      }
    }
    for (const [key, value] of statementSeed.javaScriptImplementations) {
      javaScriptImplementations.set(key, value);
    }
    for (const [key, value] of statementSeed.jsNames) {
      jsNames.set(key, value);
    }
    for (const [key, value] of statementSeed.enumInfos) {
      enumInfos.set(key, value);
    }
  }

  for (const candidate of constructableCandidates) {
    const methodNames = interfaceMethodNames.get(candidate.typeName);
    if (methodNames?.has("constructor") && !methodNames.has("call") && candidate.variableName !== "Boolean") {
      constructableOnlyNames.add(candidate.variableName);
    }
  }

  const overloads = new Map<string, RuntimeOverloadInfo[]>();
  for (const [name, functions] of overloadBuckets) {
    if (functions.length <= 1) {
      continue;
    }
    overloads.set(name, functions.map((fn) => ({
      emittedName: overloadedFunctionName(name, fn.parameters),
      parameterTypes: fn.parameters.filter((parameter) => parameter.thisParameter !== true).map(parameterTypeName),
      hasBody: fn.missingBody !== true
    })));
  }

  if (importedNames.size > 0) {
    walkAst(contextProgram, (node) => {
      if (node.kind === "MemberExpression") {
        const member = node as MemberExpression;
        if (!member.computed && member.property.kind === "Identifier") {
          const name = (member.property as Identifier).name;
          if (!extensionProperties.has(name) && importedNames.has(name)) {
            const objectType = expressionTypes?.get(member.object);
            if (objectType?.kind === "builtin") {
              extensionProperties.set(name, objectType.name === "int" ? "number" : objectType.name);
            } else if (objectType?.kind === "named") {
              extensionProperties.set(name, objectType.name);
            } else if (objectType?.kind === "array" || objectType?.kind === "tuple") {
              extensionProperties.set(name, "Array");
            }
          }
        }
      }
    });
  }

  const variableDelegates = collectVariableDelegates(contextProgram, expressionTypes);

  return {
    overloads,
    operators,
    extensionMethods,
    importedExtensionRuntimeNames,
    extensionProperties,
    classNames,
    interfaceNames,
    interfaceMembers,
    constructableOnlyNames,
    parameterNames,
    javaScriptImplementations,
    jsNames,
    variableDelegates,
    enumInfos,
    rewriteImportExtensions: options.rewriteImportExtensions ?? false,
    jsxFactory: options.jsxFactory ?? DEFAULT_JSX_FACTORY,
    jsxFragmentFactory: options.jsxFragmentFactory ?? DEFAULT_JSX_FRAGMENT_FACTORY
  };
}

export interface EmittedProgramStatement {
  statement: Statement;
  emitted: string;
}

export function createEmitProgramRuntimeContext(
  contextProgram: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>,
  options: EmitOptions = {},
  baseSeed?: EmitProgramRuntimeSeed
): EmitProgramRuntimeContext {
  return collectEmitProgramRuntimeContext(contextProgram, expressionTypes, options, baseSeed);
}

export function emitProgramStatements(
  program: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>,
  contextProgram: Program = program,
  implicitReceiverIdentifiers: ReadonlySet<Node> = new Set(),
  autoAwaitExpressions: ReadonlySet<Node> = new Set(),
  runtimeContext: EmitProgramRuntimeContext = createEmitProgramRuntimeContext(contextProgram, expressionTypes),
  staticImplicitReceiverIdentifiers: ReadonlyMap<Node, string> = new Map(),
  asyncForStatements: ReadonlySet<Node> = new Set()
): string[] {
  return emitProgramStatementPairs(
    program,
    expressionTypes,
    contextProgram,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    runtimeContext,
    staticImplicitReceiverIdentifiers,
    new Map(),
    asyncForStatements
  )
    .map(({ emitted }) => emitted)
    .filter((statement) => statement.trim().length > 0);
}

export function emitProgramStatementPairs(
  program: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>,
  contextProgram: Program = program,
  implicitReceiverIdentifiers: ReadonlySet<Node> = new Set(),
  autoAwaitExpressions: ReadonlySet<Node> = new Set(),
  runtimeContext: EmitProgramRuntimeContext = createEmitProgramRuntimeContext(contextProgram, expressionTypes),
  staticImplicitReceiverIdentifiers: ReadonlyMap<Node, string> = new Map(),
  implicitReceiverExtensionIdentifiers: ReadonlyMap<Node, string> = new Map(),
  asyncForStatements: ReadonlySet<Node> = new Set()
): EmittedProgramStatement[] {
  const saved = activeState;
  activeState = {
    programOverloads: runtimeContext.overloads,
    operators: runtimeContext.operators,
    extensionMethods: runtimeContext.extensionMethods,
    extensionProperties: runtimeContext.extensionProperties,
    classNames: runtimeContext.classNames,
    interfaceNames: runtimeContext.interfaceNames,
    interfaceMembers: runtimeContext.interfaceMembers,
    constructableOnlyNames: runtimeContext.constructableOnlyNames,
    parameterNames: runtimeContext.parameterNames,
    javaScriptImplementations: runtimeContext.javaScriptImplementations,
    jsNames: runtimeContext.jsNames,
    variableDelegates: runtimeContext.variableDelegates,
    enumInfos: runtimeContext.enumInfos,
    importedExtensionRuntimeNames: runtimeContext.importedExtensionRuntimeNames,
    implicitReceiverIdentifiers,
    staticImplicitReceiverIdentifiers,
    implicitReceiverExtensionIdentifiers,
    expressionTypes,
    autoAwaitExpressions,
    asyncForStatements,
    rewriteImportExtensions: runtimeContext.rewriteImportExtensions,
    jsxFactory: runtimeContext.jsxFactory,
    jsxFragmentFactory: runtimeContext.jsxFragmentFactory
  };
  try {
    return program.body.map((statement) => ({
      statement,
      emitted: emitStatement(statement)
    }));
  } finally {
    activeState = saved;
  }
}
