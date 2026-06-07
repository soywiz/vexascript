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

interface RuntimeImportedExtensionInfo {
  importedName: string;
  runtimeName: string;
}

interface JavaScriptImplementationInfo {
  template: string;
  parameters: FunctionParameter[];
}

let activeProgramOverloads: Map<string, RuntimeOverloadInfo[]> = new Map();
let activeOperators: Map<string, RuntimeOperatorInfo[]> = new Map();
let activeExtensionMethods: Map<string, RuntimeExtensionMethodInfo[]> = new Map();
let activeExtensionProperties: Map<string, string> = new Map();
let activeClassNames: Set<string> = new Set();
// Parameter names (in declaration order) keyed by callable name (top-level
// functions and class constructors), used to reorder named call arguments
// (`fetch(url: ...)`) into the callee's positional parameter order.
let activeParameterNames: Map<string, string[]> = new Map();
let activeJavaScriptImplementations: Map<string, JavaScriptImplementationInfo> = new Map();
// Source-name to final JavaScript-name overrides declared via `@JsName("...")`.
let activeJsNames: Map<string, string> = new Map();
let activeExtensionThis = false;
let activeImplicitReceiverIdentifiers: ReadonlySet<Node> = new Set();

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
let activeExpressionTypes: ReadonlyMap<Node, AnalysisType> | undefined;
// Expressions flagged by the analyzer as receiving an implicit `await` because they evaluate to a
// Promise inside a `sync` function body. Auto-await placement (including which positions opt out)
// is decided entirely by the analyzer; the emitter just inserts `await` for the flagged nodes.
let activeAutoAwaitExpressions: ReadonlySet<Node> = new Set();

function isAsyncEmittedFunction(node: { async?: boolean; sync?: boolean }): boolean {
  return node.async === true || node.sync === true;
}

function asyncEmitPrefix(node: { async?: boolean; sync?: boolean }): string {
  return isAsyncEmittedFunction(node) ? "async " : "";
}

function isAutoAwaited(expression: Expr): boolean {
  return activeAutoAwaitExpressions.has(expression as unknown as Node);
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
  const overloads = activeProgramOverloads.get(name);
  if (!overloads || overloads.length <= 1) {
    return null;
  }
  const argumentTypes = call.arguments.map((argument) => typeMangleName(activeExpressionTypes?.get(argument as unknown as Node)));
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
  const implementation = activeJavaScriptImplementations.get((call.callee as Identifier).name);
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
  const leftType = activeExpressionTypes?.get(binary.left as unknown as Node);
  if (leftType?.kind !== "named") {
    return null;
  }
  const operators = activeOperators.get(leftType.name)?.filter((candidate) => candidate.operator === binary.operator);
  if (!operators || operators.length === 0) {
    return null;
  }
  const rightType = typeMangleName(activeExpressionTypes?.get(binary.right as unknown as Node));
  return operators.find((candidate) => candidate.hasBody && isOverloadMatch(candidate, [rightType]))
    ?? operators.find((candidate) => candidate.hasBody)
    ?? null;
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
  const receiverType = extensionReceiverTypeName(activeExpressionTypes?.get(member.object));
  if (!receiverType) {
    return null;
  }
  const methodName = (member.property as Identifier).name;
  const methods = activeExtensionMethods.get(receiverType)?.filter((candidate) => candidate.name === methodName);
  if (!methods || methods.length === 0) {
    return null;
  }
  const argumentTypes = call.arguments.map((argument) => typeMangleName(activeExpressionTypes?.get(argument as unknown as Node)));
  return methods.find((candidate) => candidate.hasBody && isOverloadMatch(candidate, argumentTypes))?.emittedName
    ?? methods.find((candidate) => candidate.hasBody)?.emittedName
    ?? null;
}

function isBuiltinTypeNamed(type: AnalysisType | undefined, name: string): boolean {
  return type?.kind === "builtin" && type.name === name;
}

function emitTypedIntegerBinary(binary: BinaryExpression, leftText: string, rightText: string): string | null {
  const expressionType = activeExpressionTypes?.get(binary as unknown as Node);
  const leftType = activeExpressionTypes?.get(binary.left as unknown as Node);
  const rightType = activeExpressionTypes?.get(binary.right as unknown as Node);

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

function collectRuntimeOverloads(program: Program): Map<string, RuntimeOverloadInfo[]> {
  const byName = new Map<string, FunctionStatement[]>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind !== "FunctionStatement") {
      continue;
    }
    const fn = candidate as FunctionStatement;
    if (fn.declared || fn.receiverType) {
      continue;
    }
    byName.set(fn.name.name, [...(byName.get(fn.name.name) ?? []), fn]);
  }
  const result = new Map<string, RuntimeOverloadInfo[]>();
  for (const [name, functions] of byName) {
    if (functions.length <= 1) {
      continue;
    }
    result.set(name, functions.map((fn) => ({
      emittedName: overloadedFunctionName(name, fn.parameters),
      parameterTypes: fn.parameters.filter((parameter) => parameter.thisParameter !== true).map(parameterTypeName),
      hasBody: fn.missingBody !== true
    })));
  }
  return result;
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

function collectClassNames(program: Program): Set<string> {
  const result = new Set<string>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind === "ClassStatement") {
      result.add((candidate as ClassStatement).name.name);
    }
  }
  return result;
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

function collectParameterNames(program: Program): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      // Skip extension functions: their receiver shifts the positional layout.
      if (fn.receiverType || result.has(fn.name.name)) {
        continue;
      }
      result.set(fn.name.name, functionParameterNames(fn.parameters));
    } else if (candidate?.kind === "ClassStatement") {
      const classStatement = candidate as ClassStatement;
      if (result.has(classStatement.name.name)) {
        continue;
      }
      const primaryNames = (classStatement.primaryConstructorParameters ?? [])
        .map((parameter) => parameterBindingName(parameter.name))
        .filter((name): name is string => name !== null);
      if (primaryNames.length > 0) {
        result.set(classStatement.name.name, primaryNames);
        continue;
      }
      const constructor = classStatement.members.find(
        (member): member is ClassMethodMember =>
          member.kind === "ClassMethodMember" && member.name.name === "constructor"
      );
      if (constructor) {
        result.set(classStatement.name.name, functionParameterNames(constructor.parameters));
      }
    }
  }
  return result;
}

function collectJavaScriptImplementations(program: Program): Map<string, JavaScriptImplementationInfo> {
  const result = new Map<string, JavaScriptImplementationInfo>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind !== "FunctionStatement") {
      continue;
    }
    const fn = candidate as FunctionStatement;
    if (fn.jsInline !== undefined) {
      result.set(fn.name.name, { template: fn.jsInline, parameters: fn.parameters });
    }
  }
  return result;
}

function collectJsNames(program: Program): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (!candidate) {
      continue;
    }
    // The annotation may sit on the declaration itself or on its `export` wrapper.
    const jsName = candidate.jsName ?? statement.jsName;
    if (jsName === undefined) {
      continue;
    }
    if (
      candidate.kind === "FunctionStatement" ||
      candidate.kind === "ClassStatement" ||
      candidate.kind === "EnumStatement" ||
      candidate.kind === "InterfaceStatement"
    ) {
      const named = candidate as unknown as { name: Identifier };
      result.set(named.name.name, jsName);
    } else if (candidate.kind === "VarStatement") {
      const variable = candidate as VarStatement;
      if (variable.name.kind === "Identifier") {
        result.set((variable.name as Identifier).name, jsName);
      }
    }
  }
  return result;
}

function resolveJsName(name: string): string {
  return activeJsNames.get(name) ?? name;
}

function collectOperators(program: Program): Map<string, RuntimeOperatorInfo[]> {
  const result = new Map<string, RuntimeOperatorInfo[]>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind === "ClassStatement") {
      const classStatement = candidate as ClassStatement;
      for (const member of classStatement.members) {
        if (member.kind !== "ClassMethodMember" || !(member as ClassMethodMember).operator) {
          continue;
        }
        const method = member as ClassMethodMember;
        const info: RuntimeOperatorInfo = {
          operator: method.operator!,
          emittedName: operatorMethodName(method.operator!, method.parameters),
          parameterTypes: method.parameters.map(parameterTypeName),
          hasBody: method.missingBody !== true,
          extension: false
        };
        result.set(classStatement.name.name, [...(result.get(classStatement.name.name) ?? []), info]);
      }
    } else if (candidate?.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      if (!fn.receiverType || !fn.operator) {
        continue;
      }
      const info: RuntimeOperatorInfo = {
        operator: fn.operator,
        emittedName: extensionMethodRuntimeName(fn.receiverType.name, operatorBaseName(fn.operator), fn.parameters),
        parameterTypes: fn.parameters.filter((parameter) => parameter.thisParameter !== true).map(parameterTypeName),
        hasBody: fn.missingBody !== true,
        extension: true
      };
      result.set(fn.receiverType.name, [...(result.get(fn.receiverType.name) ?? []), info]);
    }
  }
  return result;
}

function collectExtensionMethods(program: Program): Map<string, RuntimeExtensionMethodInfo[]> {
  const result = new Map<string, RuntimeExtensionMethodInfo[]>();
  for (const statement of program.body) {
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind !== "FunctionStatement") {
      continue;
    }
    const fn = candidate as FunctionStatement;
    if (!fn.receiverType || fn.operator) {
      continue;
    }
    const info: RuntimeExtensionMethodInfo = {
      name: fn.name.name,
      emittedName: extensionMethodRuntimeName(fn.receiverType.name, fn.name.name, fn.parameters),
      parameterTypes: fn.parameters.filter((parameter) => parameter.thisParameter !== true).map(parameterTypeName),
      hasBody: fn.missingBody !== true
    };
    result.set(fn.receiverType.name, [...(result.get(fn.receiverType.name) ?? []), info]);
  }
  return result;
}

function extensionPropertyRuntimeName(receiverType: string, propertyName: string): string {
  return `${sanitizeManglePart(receiverType)}$$${sanitizeManglePart(propertyName)}`;
}

function collectImportedExtensionRuntimeNames(): RuntimeImportedExtensionInfo[] {
  const result: RuntimeImportedExtensionInfo[] = [];
  for (const operators of activeOperators.values()) {
    for (const operator of operators) {
      if (operator.extension) {
        result.push({ importedName: `operator${operator.operator}`, runtimeName: operator.emittedName });
      }
    }
  }
  for (const methods of activeExtensionMethods.values()) {
    for (const method of methods) {
      result.push({ importedName: method.name, runtimeName: method.emittedName });
    }
  }
  return result;
}

function importedExtensionRuntimeNames(importedName: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const extension of collectImportedExtensionRuntimeNames()) {
    if (extension.importedName !== importedName || seen.has(extension.runtimeName)) {
      continue;
    }
    seen.add(extension.runtimeName);
    names.push(extension.runtimeName);
  }
  return names;
}

function collectExtensionProperties(
  program: Program,
  expressionTypes: ReadonlyMap<Node, AnalysisType> | undefined = activeExpressionTypes
): Map<string, string> {
  const result = new Map<string, string>();
  const importedNames = new Set<string>();
  for (const statement of program.body) {
    if (statement.kind === "ImportStatement") {
      for (const specifier of (statement as ImportStatement).specifiers) importedNames.add((specifier.local ?? specifier.imported).name);
    }
    const candidate = unwrapExportedDeclaration(statement);
    if (candidate?.kind === "VarStatement" && (candidate as VarStatement).receiverType) {
      const property = candidate as VarStatement;
      result.set((property.name as Identifier).name, property.receiverType!.name);
    }
  }

  walkAst(program, (node) => {
    if (node.kind !== "MemberExpression") {
      return;
    }

    const member = node as MemberExpression;
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const name = (member.property as Identifier).name;
    if (result.has(name) || !importedNames.has(name)) {
      return;
    }

    const objectType = expressionTypes?.get(member.object);
    if (objectType?.kind === "builtin") {
      result.set(name, objectType.name === "int" ? "number" : objectType.name);
    } else if (objectType?.kind === "named") {
      result.set(name, objectType.name);
    } else if (objectType?.kind === "array" || objectType?.kind === "tuple") {
      result.set(name, "Array");
    }
  });
  return result;
}

function emitIdentifier(identifier: Identifier): string {
  if (activeExtensionThis && identifier.name === "this") {
    return "$this";
  }
  if (activeImplicitReceiverIdentifiers.has(identifier)) {
    return `${activeExtensionThis ? "$this" : "this"}.${identifier.name}`;
  }
  return resolveJsName(identifier.name);
}

function eraseTypeArguments(typeName: string): string {
  const ltIndex = typeName.indexOf("<");
  if (ltIndex < 0) {
    return typeName;
  }
  return typeName.slice(0, ltIndex).trim();
}

function isLongExpression(expression: Expr): boolean {
  const type = activeExpressionTypes?.get(expression as unknown as Node);
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
  return `React.createElement(${tag}, ${props}${children})`;
}

function emitJsxFragment(fragment: JsxFragment): string {
  const children = emitJsxChildren(fragment.children);
  return `React.createElement(React.Fragment, null${children})`;
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
    const fromDeclarations = activeParameterNames.get((callee as Identifier).name);
    if (fromDeclarations) {
      return fromDeclarations;
    }
  }
  const calleeType = activeExpressionTypes?.get(callee as unknown as Node);
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
        return `(function*(s, e) { for (let n = s; n < e; n++) yield n })(${emitExpression(range.start)}, ${emitExpression(range.end)})`;
      }
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
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
          const receiverType = activeExtensionProperties.get(propertyName);
          if (receiverType) {
            return `${extensionPropertyRuntimeName(receiverType, propertyName)}(${objectText})`;
          }
          // Member property names are not affected by `@JsName`; emit them as-is
          // rather than routing through identifier renaming.
          const access = member.optional ? "?." : ".";
          return `${objectText}${access}${propertyName}`;
        }
        if (member.computed) {
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
        const overloadedName = resolveOverloadedFunctionCall(call);
        const calleeText = overloadedName ?? emitExpression(call.callee, PREC_MEMBER, "left");
        const argumentsText = emitCallArgumentTexts(call.callee, call.arguments).join(", ");
        const isClassCall =
          call.optional !== true &&
          call.callee.kind === "Identifier" &&
          activeClassNames.has((call.callee as Identifier).name);
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
              return `${key}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`;
            }
            return `${key}: ${emitListElement(objectProperty.value)}`;
          })
          .join(", ")}}`;
      }
      case "ArrowFunctionExpression": {
        const arrow = expression as ArrowFunctionExpression;
        if (arrow.contextualObjectLiteral && activeExpressionTypes?.get(expression as unknown as Node)?.kind !== "function") {
          return emitExpression(arrow.contextualObjectLiteral, parentPrecedence, side);
        }
        const parameters = `(${emitFunctionParameters(arrow.parameters)})`;
        if (arrow.body.kind === "BlockStatement") {
          return `${asyncEmitPrefix(arrow)}${parameters} => ${emitBlock(arrow.body as BlockStatement)}`;
        }
        const bodyExpression = arrow.body as Expr;
        const bodyText = emitExpression(bodyExpression);
        if (bodyExpression.kind === "ObjectLiteral") {
          return `${asyncEmitPrefix(arrow)}${parameters} => (${bodyText})`;
        }
        return `${asyncEmitPrefix(arrow)}${parameters} => ${bodyText}`;
      }
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        const name = fn.name ? ` ${fn.name.name}` : "";
        return `${asyncEmitPrefix(fn)}function${fn.generator === true ? "*" : ""}${name}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`;
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
  const methodName = method.operator ? operatorMethodName(method.operator, method.parameters) : method.name.name;
  const body = methodName === "constructor" ? emitConstructorBlock(method) : emitBlock(method.body);
  return `${staticPrefix}${asyncPrefix}${accessorPrefix}${generatorPrefix}${methodName}(${emitFunctionParameters(method.parameters)}) ${body}`;
}

function emitForStatement(statement: ForStatement): string {
  if (statement.iterationKind && statement.iterator && statement.iterable) {
    if (statement.iterator.kind === "Identifier") {
      const iteratorName = (statement.iterator as Identifier).name;
      return `for (const ${iteratorName} of ${emitExpression(statement.iterable)}) ${emitStatement(statement.body)}`;
    }

    return `for (${emitForIteratorHeader(statement.iterator)} ${statement.iterationKind} ${emitExpression(statement.iterable)}) ${emitStatement(statement.body)}`;
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
  for (const member of statement.members) {
    const memberName = member.name.name;
    if (member.initializer) {
      const initializer = emitExpression(member.initializer);
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
      continue;
    }
    lines.push(`  ${name}[${name}[${JSON.stringify(memberName)}] = ${nextNumericValue}] = ${JSON.stringify(memberName)};`);
    nextNumericValue += 1;
  }
  lines.push(`})(${name} || (${name} = {}));`);
  return lines.join("\n");
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
        return exportStatement.from ? `export * from ${JSON.stringify(exportStatement.from.value)};` : "";
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
        const fromClause = exportStatement.from ? ` from ${JSON.stringify(exportStatement.from.value)}` : "";
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
      const source = JSON.stringify(importStatement.from.value);
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
        const receiverType = activeExtensionProperties.get(localName);
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
        activeExtensionThis = true;
        try {
          return `const ${extensionPropertyRuntimeName(property.receiverType.name, (property.name as Identifier).name)} = ($this) => ${property.initializer ? emitExpression(property.initializer) : "undefined"};`;
        } finally {
          activeExtensionThis = previousExtensionThis;
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
        activeExtensionThis = true;
        try {
          return `${asyncEmitPrefix(fn)}function${fn.generator === true ? "*" : ""} ${emittedName}(${parameterList}) ${emitBlock(fn.body)}`;
        } finally {
          activeExtensionThis = previousExtensionThis;
        }
      }
      const overloads = activeProgramOverloads.get(fn.name.name);
      const emittedName = activeJsNames.get(fn.name.name)
        ?? (overloads && overloads.length > 1 ? overloadedFunctionName(fn.name.name, fn.parameters) : fn.name.name);
      return `${asyncEmitPrefix(fn)}function${fn.generator === true ? "*" : ""} ${emittedName}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`;
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
        ...members.map((member) => emitClassMember(member))
      ];
      const extendsClause = classStatement.extendsType
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
  autoAwaitExpressions?: ReadonlySet<Node>
): string {
  return emitProgramStatements(program, expressionTypes, program, implicitReceiverIdentifiers, autoAwaitExpressions).join("\n");
}

interface EmitProgramRuntimeContext {
  overloads: Map<string, RuntimeOverloadInfo[]>;
  operators: Map<string, RuntimeOperatorInfo[]>;
  extensionMethods: Map<string, RuntimeExtensionMethodInfo[]>;
  extensionProperties: Map<string, string>;
  classNames: Set<string>;
  parameterNames: Map<string, string[]>;
  javaScriptImplementations: Map<string, JavaScriptImplementationInfo>;
  jsNames: Map<string, string>;
}

export function createEmitProgramRuntimeContext(
  contextProgram: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>
): EmitProgramRuntimeContext {
  return {
    overloads: collectRuntimeOverloads(contextProgram),
    operators: collectOperators(contextProgram),
    extensionMethods: collectExtensionMethods(contextProgram),
    extensionProperties: collectExtensionProperties(contextProgram, expressionTypes),
    classNames: collectClassNames(contextProgram),
    parameterNames: collectParameterNames(contextProgram),
    javaScriptImplementations: collectJavaScriptImplementations(contextProgram),
    jsNames: collectJsNames(contextProgram)
  };
}

export function emitProgramStatements(
  program: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>,
  contextProgram: Program = program,
  implicitReceiverIdentifiers: ReadonlySet<Node> = new Set(),
  autoAwaitExpressions: ReadonlySet<Node> = new Set(),
  runtimeContext: EmitProgramRuntimeContext = createEmitProgramRuntimeContext(contextProgram, expressionTypes)
): string[] {
  const previous = activeExpressionTypes;
  const previousOverloads = activeProgramOverloads;
  const previousOperators = activeOperators;
  const previousExtensionMethods = activeExtensionMethods;
  const previousExtensionProperties = activeExtensionProperties;
  const previousClassNames = activeClassNames;
  const previousParameterNames = activeParameterNames;
  const previousJavaScriptImplementations = activeJavaScriptImplementations;
  const previousJsNames = activeJsNames;
  const previousImplicitReceiverIdentifiers = activeImplicitReceiverIdentifiers;
  const previousAutoAwaitExpressions = activeAutoAwaitExpressions;
  activeExpressionTypes = expressionTypes;
  activeImplicitReceiverIdentifiers = implicitReceiverIdentifiers;
  activeAutoAwaitExpressions = autoAwaitExpressions;
  activeProgramOverloads = runtimeContext.overloads;
  activeOperators = runtimeContext.operators;
  activeExtensionMethods = runtimeContext.extensionMethods;
  activeExtensionProperties = runtimeContext.extensionProperties;
  activeClassNames = runtimeContext.classNames;
  activeParameterNames = runtimeContext.parameterNames;
  activeJavaScriptImplementations = runtimeContext.javaScriptImplementations;
  activeJsNames = runtimeContext.jsNames;
  try {
    return program.body
      .map((statement) => emitStatement(statement))
      .filter((statement) => statement.trim().length > 0);
  } finally {
    activeExpressionTypes = previous;
    activeProgramOverloads = previousOverloads;
    activeOperators = previousOperators;
    activeExtensionMethods = previousExtensionMethods;
    activeExtensionProperties = previousExtensionProperties;
    activeClassNames = previousClassNames;
    activeParameterNames = previousParameterNames;
    activeJavaScriptImplementations = previousJavaScriptImplementations;
    activeJsNames = previousJsNames;
    activeImplicitReceiverIdentifiers = previousImplicitReceiverIdentifiers;
    activeAutoAwaitExpressions = previousAutoAwaitExpressions;
  }
}
