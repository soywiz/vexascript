import { AnalysisTypeKind } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
import {
  ArrayLiteral,
  ArrayBindingPattern,
  AsExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  BigIntLiteral,
  BinaryExpression,
  BindingElement,
  BindingName,
  BlockStatement,
  BooleanLiteral,
  BreakStatement,
  CallExpression,
  CallableExpression,
  CallableMember,
  ClassFieldMember,
  ClassMethodMember,
  ClassPrimaryConstructorParameter,
  ClassStatement,
  CommaExpression,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  EnumStatement,
  Expr,
  ExprStatement,
  ExportStatement,
  ForStatement,
  FloatLiteral,
  FunctionExpression,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  IfStatement,
  IntLiteral,
  InterfaceMember,
  InterfaceMethodMember,
  InterfacePropertyMember,
  InterfaceStatement,
  LabeledStatement,
  LongLiteral,
  MemberExpression,
  NamedArgument,
  NewExpression,
  NonNullExpression,
  Node,
  ObjectLiteral,
  ObjectBindingPattern,
  ObjectProperty,
  OverloadableOperator,
  Program,
  RangeExpression,
  RegExpLiteral,
  ReturnStatement,
  SatisfiesExpression,
  Statement,
  StringLiteral,
  SpreadExpression,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  TypeAliasStatement,
  TypeParameter,
  UnaryExpression,
  UndefinedLiteral,
  UpdateExpression,
  VarStatement,
  WhileStatement,
} from "compiler/ast/ast";
import { compoundAssignmentBinaryOperator } from "compiler/ast/ast";
import { bindingElementPropertyName, bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { childNodes } from "compiler/ast/traversal";
import { builtinType, type AnalysisType, type BuiltinTypeName, type FunctionType, type NamedType } from "compiler/analysis/types";
import type { AnalysisSymbol } from "compiler/analysis/model";
import type { ExtensionPropertyResolution } from "compiler/analysis/model";
import { parseFunctionTypeAnnotation, parseObjectTypeAnnotation, parseTypeNameShape, splitArraySuffixTypeName, splitTopLevelTypeText, substituteTypeNameText } from "compiler/analysis/typeNames";
import type { ArraySuffixTypeName } from "compiler/analysis/typeNames";
import type { ReceiverLambdaInfo } from "compiler/analysis/model";
import { operatorMethodRuntimeName } from "./operatorNames";

export class CppEmitError extends Error {
  constructor(message: string, readonly statement?: Node) {
    super(message);
    this.name = "CppEmitError";
  }
}

class DeclaredCppTypeCacheEntry {
  constructor(public cppType: string) {}
}

const CPP_RESERVED_WORDS = new Set([
  "alignas", "alignof", "and", "asm", "auto", "bitand", "bitor", "bool", "break", "case", "catch",
  "char", "class", "compl", "concept", "const", "consteval", "constexpr", "constinit", "const_cast",
  "continue", "co_await", "co_return", "co_yield", "decltype", "default", "delete", "do", "double",
  "dynamic_cast", "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend",
  "goto", "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept", "not", "nullptr",
  "operator", "or", "private", "protected", "public", "register", "reinterpret_cast", "requires", "return",
  "short", "signed", "sizeof", "static", "static_assert", "static_cast", "struct", "switch", "template",
  "this", "thread_local", "throw", "true", "try", "typedef", "typeid", "typename", "union", "unsigned",
  "using", "virtual", "void", "volatile", "wchar_t", "while", "xor",
]);
const NATIVE_RUNTIME_FUNCTION_NAMES = new Set([
  "readTextFile", "writeTextFile", "commandLineArguments",
  "nativeStatPath", "nativeReadDirectory", "nativeCreateDirectory", "nativeRemovePath", "nativeCopyFile", "nativeRunCommandCapture", "nativeRunTask", "nativeEnvironmentVariable",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
]);

function isNativeArrayTypeName(name: string): boolean {
  switch (name) {
    case "Array":
    case "ReadonlyArray":
    case "ConcatArray":
      return true;
    default:
      return false;
  }
}

function isNativeMapTypeName(name: string): boolean {
  return name === "Map" || name === "ReadonlyMap";
}

function isNativeSetTypeName(name: string): boolean {
  return name === "Set" || name === "ReadonlySet";
}

function isNativeErrorTypeName(name: string): boolean {
  switch (name) {
    case "Error":
    case "TypeError":
    case "RangeError":
    case "SyntaxError":
      return true;
    default:
      return false;
  }
}

function isConsoleMethodName(name: string): boolean {
  switch (name) {
    case "log":
    case "info":
    case "warn":
    case "error":
      return true;
    default:
      return false;
  }
}

function isNullishNodeKind(kind: NodeKind): boolean {
  return kind === NodeKind.NullLiteral || kind === NodeKind.UndefinedLiteral;
}
const cppNameCache: Map<string, string> = new Map();

let activeClassNames: ReadonlySet<string> = new Set();
let activeInterfaceNames: ReadonlySet<string> = new Set();
let activeEnumNames: ReadonlySet<string> = new Set();
let activeTypeAliases: ReadonlyMap<string, string> = new Map();
let activeCppTypeParameters: ReadonlySet<string> = new Set();
let activeCppTypeParameterCacheKey = "";
let activeDeclaredCppTypeCache: Map<string, DeclaredCppTypeCacheEntry> = new Map();
let activeGcObjectTypes: Map<string, string> = new Map();
let activeGcArrayTypes: Map<string, string> = new Map();
let activeDynamicValueNames: Set<string> = new Set();
let activeFunctionObjectCapture = false;
let activeFunctionObjectCaptureNames: ReadonlySet<string> | null = null;
let activeExpressionTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeHasExpressionTypes = false;
let activeNativeFunctionCaptureNamesCache: Map<Node, ReadonlySet<string>> = new Map();
let activeNestedClosureCaptureNamesCache: Map<Node, ReadonlySet<string>> = new Map();
let activeFunctionStatements: ReadonlyMap<string, FunctionStatement> = new Map();
let activeExtensionFunctions: ReadonlyMap<string, readonly FunctionStatement[]> = new Map();
let activeClassStatements: ReadonlyMap<string, ClassStatement> = new Map();
let activeClassStatementsByCppBase: ReadonlyMap<string, ClassStatement> = new Map();
let activeCanonicalNativeObjectNameCache: Map<string, string | null> = new Map();
let activeClassMethodCache: Map<string, ClassMethodMember | null> = new Map();
let activeClassGetterCache: Map<string, ClassMethodMember | null> = new Map();
let activeClassSetterCache: Map<string, ClassMethodMember | null> = new Map();
let activeClassStoredPropertyInfoCache: Map<string, ClassStoredPropertyInfo | null> = new Map();
let activeClassPropertyCppTypes: Map<string, string | null> = new Map();
let activeDerivedClassNames: ReadonlySet<string> = new Set();
let activeInterfaceStatements: ReadonlyMap<string, InterfaceStatement> = new Map();
let activeInterfaceStatementsByCppBase: ReadonlyMap<string, InterfaceStatement> = new Map();
let activeCurrentClassName: string | null = null;
let activeCurrentClassStatement: ClassStatement | null = null;
let activeCppExpressionTypeCache: Map<Node, string> = new Map();
let activeEmittedExpressionTypeCache: Map<Node, string | null> = new Map();
let activeCurrentMethodStatic = false;
let activeLocalNames: Set<string> = new Set();
let activeLocalDeclaredTypeNames: Map<string, string> = new Map();
let activeGlobalDeclaredTypeNames: Map<string, string> = new Map();
let activeGlobalCppTypes: Map<string, string> = new Map();
let activeGlobalGcRootTypes: Map<string, string> = new Map();
let activeLocalCppTypes: Map<string, string> = new Map();
let activeCallableParameterPointerTypes: Map<string, string> = new Map();
let activeSharedBindingNames: Set<string> = new Set();
let activeSharedBindingCandidates: ReadonlySet<string> = new Set();
let activeRuntimeName = "runtime";
const currentRuntimeExpression = "vexa::Runtime::current()";
let activeStringLiteralNames: Map<string, string> = new Map();
let activeThisExpression = "this";
let activeDefaultArgumentExpressions: ReadonlyMap<string, Expr> = new Map();
let activeImplicitReceiverIdentifiers: ReadonlySet<Node> = new Set();
let activeReceiverLambdas: ReadonlyMap<Node, ReceiverLambdaInfo> = new Map();
let activeReceiverLabels: ReadonlyMap<string, string> = new Map();
let activeReceiverSymbolCounter = 0;
let activeImplicitReceiverExtensionIdentifiers: ReadonlyMap<Node, string> = new Map();
let activeStaticImplicitReceiverIdentifiers: ReadonlyMap<Node, string> = new Map();
let activeAutoAwaitExpressions: ReadonlySet<Node> = new Set();
let activeCallableTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeOperatorResolutions: ReadonlyMap<Node, AnalysisSymbol> = new Map();
let activeExtensionPropertyResolutions: ReadonlyMap<Node, ExtensionPropertyResolution> = new Map();
let activeExtensionProperties: ReadonlyMap<string, VarStatement> = new Map();
let activeOperatorMethodsByNameNode: ReadonlyMap<Node, ClassMethodMember> = new Map();
let activeSuppressAutoAwait = false;
let activeAsyncResultType: string | null = null;
let activeGeneratorResultType: string | null = null;
let activeCallableResultType: string | null = null;
let activeCallableUsesReturnSignal = false;
let activeFinallyProtectedDepth = 0;
interface ControlBoundary {
  finallyDepth: number;
  usesSignal: boolean;
}
let activeBreakBoundaries: ControlBoundary[] = [];
let activeContinueBoundaries: ControlBoundary[] = [];
let activeYieldTemporaryCounter = 0;
let activeExceptionTemporaryCounter = 0;
let activeSwitchTemporaryCounter = 0;
let activeDestructureTemporaryCounter = 0;
let activeSourceFilePath: string | null = null;
let activeEmitSourceLocations = false;
let activeExpectedExpressionCppType: string | null = null;
let activeExpectedRecordPropertyCppTypes: ReadonlyMap<string, string> | null = null;
let activeExpectedLambdaResultCppType: string | null = null;
let activeExpectedLambdaParameterCppTypes: readonly string[] | null = null;

function cppName(name: string): string {
  const cached = cppNameCache.get(name);
  if (cached !== undefined) return cached;
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const withValidStart = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
  const result = CPP_RESERVED_WORDS.has(withValidStart) ? `vexa_${withValidStart}` : withValidStart;
  cppNameCache.set(name, result);
  return result;
}

function cppTemplatePrefix(
  typeParameters: readonly TypeParameter[] | undefined,
  indent = "",
  includeDefaults = false
): string {
  if (!typeParameters?.length) return "";
  const parameters = typeParameters.map((parameter) => {
    const defaultType = includeDefaults && parameter.defaultType
      ? cppTypeForDeclaredName(parameter.defaultType.name)
      : "";
    return `typename ${cppName(parameter.name.name)}${defaultType ? ` = ${defaultType}` : ""}`;
  }).join(", ");
  return `${indent}template <${parameters}>\n`;
}

function withCppTypeParameters(
  typeParameters: readonly TypeParameter[] | undefined,
  emit: () => string
): string {
  if (!typeParameters?.length) return emit();
  const previous = activeCppTypeParameters;
  const previousCacheKey = activeCppTypeParameterCacheKey;
  const nextTypeParameters = new Set<string>(activeCppTypeParameters);
  for (const parameter of typeParameters) nextTypeParameters.add(parameter.name.name);
  activeCppTypeParameters = nextTypeParameters;
  activeCppTypeParameterCacheKey = [...activeCppTypeParameters].sort().join("\u001f");
  let result: string;
  try {
    result = emit();
  } finally {
    activeCppTypeParameters = previous;
    activeCppTypeParameterCacheKey = previousCacheKey;
  }
  return result;
}

function copyStringSetWithValues(base: ReadonlySet<string>, values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of base) result.add(value);
  for (const value of values) result.add(value);
  return result;
}

function substituteTypeName(typeName: string, bindings: ReadonlyMap<string, string>): string {
  return substituteTypeNameText(typeName, bindings);
}

function cppOperatorMethodName(operator: OverloadableOperator, parameters: readonly FunctionParameter[]): string {
  return cppName(operatorMethodRuntimeName(operator, parameters));
}

function identifierName(expression: Expr): string | null {
  return expression.kind === NodeKind.Identifier ? (expression as Identifier).name : null;
}

function resolvedDefaultArgument(name: string): Expr | null {
  let current = activeDefaultArgumentExpressions.get(name);
  if (!current) return null;
  const resolving = new Set<string>([name]);
  while (current.kind === NodeKind.Identifier) {
    const currentName = (current as Identifier).name;
    if (resolving.has(currentName)) return null;
    const next = activeDefaultArgumentExpressions.get(currentName);
    if (!next) return current;
    resolving.add(currentName);
    current = next;
  }
  return current;
}

function isOptionalChainExpression(expression: Expr): boolean {
  if (expression.kind === NodeKind.MemberExpression) {
    const member = expression as MemberExpression;
    return Boolean(member.optional) || isOptionalChainExpression(member.object);
  }
  if (expression.kind === NodeKind.CallExpression) {
    const call = expression as CallExpression;
    return Boolean(call.optional) || isOptionalChainExpression(call.callee);
  }
  return false;
}

function usesPooledFunctionTypeof(unary: UnaryExpression): boolean {
  if (unary.operator !== "typeof") return false;
  const runtimeFunctionName = identifierName(unary.argument);
  if (runtimeFunctionName && NATIVE_RUNTIME_FUNCTION_NAMES.has(runtimeFunctionName)) return true;
  const member = unary.argument.kind === NodeKind.MemberExpression
    ? memberParts(unary.argument)
    : null;
  return member?.objectName === "process" && member.propertyName === "cwd";
}

function emitIdentifier(identifier: Identifier): string {
  if (identifier.name === "this") {
    return identifier.receiverLabel
      ? activeReceiverLabels.get(identifier.receiverLabel) ?? activeThisExpression
      : activeThisExpression;
  }
  const defaultArgument = resolvedDefaultArgument(identifier.name);
  if (defaultArgument) return emitExpression(defaultArgument);
  if (identifier.name === "process") return "vexa::process";
  if (activeImplicitReceiverExtensionIdentifiers.has(identifier as Node)) {
    const receiverName = activeImplicitReceiverExtensionIdentifiers.get(identifier as Node)!;
    const extensionProperty = activeExtensionProperties.get(`${receiverName}.${identifier.name}`);
    if (extensionProperty) {
      return `${extensionPropertyCppName(extensionProperty)}(${activeThisExpression})`;
    }
    if (identifier.name === "length" && activeCurrentClassName === "Array") {
      return `static_cast<double>(vexa::arrayPointer(${activeThisExpression})->size())`;
    }
    return `${activeThisExpression}->${cppName(identifier.name)}`;
  }
  const staticClassName = activeStaticImplicitReceiverIdentifiers.get(identifier as Node);
  if (staticClassName) {
    return `${cppName(staticClassName)}::${cppName(identifier.name)}`;
  }
  if (activeImplicitReceiverIdentifiers.has(identifier as Node)) {
    if (identifier.name === "length" && activeCurrentClassName === "Array") {
      return `static_cast<double>(vexa::arrayPointer(${activeThisExpression})->size())`;
    }
    const currentClass = activeCurrentClassStatement ?? (activeCurrentClassName
      ? activeClassStatements.get(activeCurrentClassName)
      : undefined);
    if (currentClass && classGetterForName(currentClass, identifier.name)) {
      return `${activeThisExpression}->${cppName(identifier.name)}()`;
    }
    return `${activeThisExpression}->${cppName(identifier.name)}`;
  }
  const name = cppName(identifier.name);
  return activeSharedBindingNames.has(identifier.name) ? `(*${name})` : name;
}

function emitTopLevelFunctionValue(statement: FunctionStatement): string {
  const lambdaParameters: string[] = [];
  const forwardedArguments: string[] = [];
  for (let index = 0; index < statement.parameters.length; index += 1) {
    const parameter = statement.parameters[index]!;
    const argumentName = `__vexa_function_argument_${index}`;
    const targetType = cppTypeForCallableParameter(parameter, false) ?? "vexa::Value";
    lambdaParameters.push(`auto&& ${argumentName}`);
    forwardedArguments.push(
      `vexa::convertValue<${targetType}>(std::forward<decltype(${argumentName})>(${argumentName}))`
    );
  }
  const argumentsText = forwardedArguments.join(", ");
  const expectedResultType = activeExpectedLambdaResultCppType ??
    (activeExpectedExpressionCppType ? managedArrayElementType(activeExpectedExpressionCppType) : null) ??
    (statement.returnType ? cppTypeForDeclaredName(statement.returnType.name) : null);
  const call = `${cppName(statement.name.name)}(${argumentsText})`;
  const result = expectedResultType
    ? `vexa::convertValue<${expectedResultType}>(${call})`
    : call;
  return `[=](${lambdaParameters.join(", ")}) -> ${expectedResultType ?? "decltype(auto)"} { return ${result}; }`;
}

function emitWithoutAutoAwait(expression: Expr): string {
  const previous = activeSuppressAutoAwait;
  activeSuppressAutoAwait = true;
  let result: string;
  try {
    result = emitExpression(expression);
  } finally {
    activeSuppressAutoAwait = previous;
  }
  return result;
}

function maybeAutoAwait(expression: Expr, emitted: string): string {
  const call = expression.kind === NodeKind.CallExpression ? expression as CallExpression : null;
  const calleeName = call ? identifierName(call.callee) : null;
  const declaration = calleeName ? activeFunctionStatements.get(calleeName) : undefined;
  const syntacticAutoAwait = !activeHasExpressionTypes && activeAsyncResultType !== null && declaration &&
    (declaration.async === true || declaration.sync === true ||
      parseTypeNameShape(declaration.returnType?.name ?? "").baseName === "Promise");
  return !activeSuppressAutoAwait &&
    (activeAutoAwaitExpressions.has(expression as Node) || syntacticAutoAwait)
    ? activeAsyncResultType
      ? `(co_await ${emitted})`
      : `${emitted}.get()`
    : emitted;
}

function emitAsyncResultValue(expression: Expr, resultType: string): string {
  const expressionType = activeExpressionTypes.get(expression as Node);
  if (expressionType?.kind === AnalysisTypeKind.Named && expressionType.name === "Promise") {
    return `vexa::convertValue<${resultType}>((co_await ${emitWithoutAutoAwait(expression)}))`;
  }
  return emitConvertedValue(expression, resultType);
}

class MemberParts {
  constructor(
    public object: Expr,
    public objectName: string | null,
    public propertyName: string,
    public property?: Identifier
  ) {}
}

function createMemberParts(object: Expr, propertyName: string): MemberParts {
  return new MemberParts(object, identifierName(object), propertyName);
}

function memberParts(expression: Expr): MemberParts | null {
  if (expression.kind !== NodeKind.MemberExpression) return null;
  const member = expression as MemberExpression;
  if (member.computed || member.property.kind !== NodeKind.Identifier) return null;
  return new MemberParts(
    member.object,
    identifierName(member.object),
    (member.property as Identifier).name,
    member.property as Identifier
  );
}

function cppString(value: string): string {
  return JSON.stringify(value)
    .replace(/\\u2028/g, "\\u2028")
    .replace(/\\u2029/g, "\\u2029");
}

function cppUtf16String(value: string): string {
  return `u${cppString(value)}`;
}

function cppText(value: string): string {
  return `vexa::Text(std::u16string_view(${cppUtf16String(value)}, ${value.length}))`;
}

function pooledStringLiteral(value: string): string {
  const name = activeStringLiteralNames.get(value);
  if (!name) throw new CppEmitError(`Missing pooled C++ string literal '${value}'`);
  return `*${name}`;
}

function emitStringKeyDispatch(
  entries: readonly { key: string; body: string }[],
  indent: string,
  valueName: string,
  valueKind: "utf16" | "value"
): string {
  if (entries.length === 0) return "";
  const lengths: number[] = [];
  for (const entry of entries) {
    const length = entry.key.length;
    if (lengths.indexOf(length) < 0) lengths.push(length);
  }
  lengths.sort((left, right) => left - right);
  const lengthExpression = valueKind === "utf16"
    ? `${valueName}.size()`
    : `vexa::stringCodeUnitLength(${valueName})`;
  const firstExpression = valueKind === "utf16"
    ? `static_cast<std::uint16_t>(${valueName}[0])`
    : `vexa::stringFirstCodeUnit(${valueName})`;
  const lines = [`${indent}switch (${lengthExpression}) {`];
  for (const length of lengths) {
    lines.push(`${indent}  case ${length}:`);
    if (length === 0) {
      for (const entry of entries) {
        if (entry.key.length !== 0) continue;
        const compared = valueKind === "utf16"
          ? cppUtf16String(entry.key)
          : cppText(entry.key);
        lines.push(`${indent}    if (${valueName} == ${compared}) { ${entry.body} }`);
      }
    } else {
      const firstBytes: number[] = [];
      for (const entry of entries) {
        const entryLength = entry.key.length;
        if (entryLength !== length) continue;
        const firstByte = entry.key.charCodeAt(0);
        if (firstBytes.indexOf(firstByte) < 0) firstBytes.push(firstByte);
      }
      firstBytes.sort((left, right) => left - right);
      lines.push(`${indent}    switch (${firstExpression}) {`);
      for (const firstByte of firstBytes) {
        lines.push(`${indent}      case ${firstByte}:`);
        for (const entry of entries) {
          const entryLength = entry.key.length;
          const entryFirst = entry.key.charCodeAt(0);
          if (entryLength !== length || entryFirst !== firstByte) continue;
          const compared = valueKind === "utf16"
            ? cppUtf16String(entry.key)
            : cppText(entry.key);
          lines.push(`${indent}        if (${valueName} == ${compared}) { ${entry.body} }`);
        }
        lines.push(`${indent}        break;`);
      }
      lines.push(`${indent}      default:`, `${indent}        break;`, `${indent}    }`);
    }
    lines.push(`${indent}    break;`);
  }
  lines.push(`${indent}  default:`, `${indent}    break;`, `${indent}}`);
  return lines.join("\n");
}

function emitDynamicKeyDispatch(
  entries: readonly { key: string; body: string }[],
  indent: string
): string {
  return emitStringKeyDispatch(entries, indent, "__vexa_key", "utf16");
}

function cppTypeForBuiltin(typeName: BuiltinTypeName): string | null {
  switch (typeName) {
    case "int":
      return "std::int32_t";
    case "long":
      return "std::int64_t";
    case "bigint":
      return "vexa::BigInt";
    case "number":
    case "numeric":
      return "double";
    case "boolean":
      return "bool";
    case "void":
      return "void";
    case "undefined":
      return "vexa::Undefined";
    case "null":
      return "vexa::Null";
    case "string":
      return "vexa::Text";
    case "any":
    case "unknown":
    case "object":
      return "vexa::Value";
    default:
      return null;
  }
}

const nativeWeakObjectKeyCppType = "cppgc::GarbageCollectedMixin*";

function cppTypeForWeakAnalysisKey(type: AnalysisType): string | null {
  return type.kind === AnalysisTypeKind.Builtin && type.name === "object"
    ? nativeWeakObjectKeyCppType
    : cppTypeForAnalysisType(type);
}

function cppTypeForWeakDeclaredKey(typeName: string): string | null {
  return parseTypeNameShape(typeName).baseName === "object"
    ? nativeWeakObjectKeyCppType
    : cppTypeForDeclaredName(typeName);
}

function cppTypeForAnalysisType(type: AnalysisType): string | null {
  if (type.kind === AnalysisTypeKind.Builtin) return cppTypeForBuiltin(type.name);
  if (type.kind === AnalysisTypeKind.Named && activeCppTypeParameters.has(type.name) && !(type.typeArguments?.length)) {
    return cppName(type.name);
  }
  if (type.kind === AnalysisTypeKind.Literal) {
    return cppTypeForBuiltin(type.base === "number" ? "number" : type.base);
  }
  if (type.kind === AnalysisTypeKind.Array) {
    const elementType = cppArrayElementType(type.elementType);
    return elementType ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (type.kind === AnalysisTypeKind.Range) {
    const elementType = cppArrayElementType(type.elementType);
    return elementType ? `std::vector<${elementType}>` : null;
  }
  if (type.kind === AnalysisTypeKind.Tuple) {
    const elementTypes = new Set(type.elements.map(cppArrayElementType));
    const elementType = elementTypes.size === 1 ? [...elementTypes][0] : null;
    return elementType ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (type.kind === AnalysisTypeKind.Object) return "vexa::RecordObject*";
  if (type.kind === AnalysisTypeKind.Function) {
    const functionType = type as FunctionType;
    const result = cppTypeForAnalysisType(functionType.returnType) ?? "vexa::Value";
    const parameters: string[] = [];
    for (const parameter of functionType.parameters) {
      parameters.push(cppTypeForAnalysisType(parameter.type) ?? "vexa::Value");
    }
    return `std::function<${result}(${parameters.join(", ")})>`;
  }
  if (
    type.kind === AnalysisTypeKind.Named &&
    (type.name === "Array" || type.name === "ReadonlyArray" || type.name === "ConcatArray")
  ) {
    const elementType = cppArrayElementType(type.typeArguments?.[0] ?? builtinType("unknown"));
    return elementType ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (type.kind === AnalysisTypeKind.Named && type.name === "Promise") {
    const resultType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? builtinType("unknown"));
    return `vexa::Task<${resultType ?? "vexa::Value"}>`;
  }
  if (type.kind === AnalysisTypeKind.Named && type.name === "URL") return "vexa::URLObject*";
  if (type.kind === AnalysisTypeKind.Named && isNativeErrorTypeName(type.name)) return "vexa::Error";
  if (type.kind === AnalysisTypeKind.Named && (type.name === "Map" || type.name === "ReadonlyMap")) {
    const keyType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? builtinType("any")) ?? "vexa::Value";
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[1] ?? builtinType("any")) ?? "vexa::Value";
    return `vexa::MapObject<${keyType}, ${valueType}>*`;
  }
  if (type.kind === AnalysisTypeKind.Named && (type.name === "Set" || type.name === "ReadonlySet")) {
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? builtinType("any")) ?? "vexa::Value";
    return `vexa::SetObject<${valueType}>*`;
  }
  if (type.kind === AnalysisTypeKind.Named && type.name === "WeakMap") {
    const keyType = cppTypeForWeakAnalysisKey(type.typeArguments?.[0] ?? builtinType("unknown"));
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[1] ?? builtinType("any")) ?? "vexa::Value";
    return keyType?.endsWith("*") ? `vexa::WeakMapObject<${keyType}, ${valueType}>*` : null;
  }
  if (type.kind === AnalysisTypeKind.Named && type.name === "WeakSet") {
    const valueType = cppTypeForWeakAnalysisKey(type.typeArguments?.[0] ?? builtinType("unknown"));
    return valueType?.endsWith("*") ? `vexa::WeakSetObject<${valueType}>*` : null;
  }
  if (type.kind === AnalysisTypeKind.Named && type.name === "RegExp") return "vexa::RegExp";
  if (type.kind === AnalysisTypeKind.Named && type.name === "Date") return "vexa::DateObject*";
  if (type.kind === AnalysisTypeKind.Named && type.name === "ArrayBuffer") return "vexa::ArrayBufferObject*";
  if (type.kind === AnalysisTypeKind.Named && type.name === "Uint8Array") return "vexa::Uint8ArrayObject*";
  if (type.kind === AnalysisTypeKind.Named && type.name === "DataView") return "vexa::DataViewObject*";
  if (type.kind === AnalysisTypeKind.Named && activeEnumNames.has(type.name)) return "std::int32_t";
  if (type.kind === AnalysisTypeKind.Named && isNativeObjectTypeName(type.name)) {
    const statement = activeClassStatements.get(type.name) ?? activeInterfaceStatements.get(type.name);
    const parameters = statement?.typeParameters ?? [];
    const typeArguments: Array<string | null> = (type.typeArguments ?? []).map(cppTypeForAnalysisType);
    for (let index = typeArguments.length; index < parameters.length; index += 1) {
      const defaultType = parameters[index]?.defaultType;
      typeArguments.push(defaultType ? cppTypeForDeclaredName(defaultType.name) : null);
    }
    if (typeArguments.some((argument) => !argument) || typeArguments.length < parameters.length) return null;
    const specialization = parameters.length > 0
      ? `<${typeArguments.join(", ")}>`
      : "";
    return `${cppName(statement?.name.name ?? parseTypeNameShape(type.name).baseName)}${specialization}*`;
  }
  return null;
}

function stripOuterTypeParentheses(typeName: string): string {
  let current = typeName.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let wrapsEntireType = true;
    for (let index = 0; index < current.length; index += 1) {
      const character = current.charCodeAt(index);
      if (character === 40) depth += 1;
      if (character === 41) depth -= 1;
      if (depth === 0 && index < current.length - 1) {
        wrapsEntireType = false;
        break;
      }
    }
    if (!wrapsEntireType) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function cppTypeForDeclaredName(typeName: string, visitedAliases?: Set<string>): string {
  if (visitedAliases !== undefined) return computeCppTypeForDeclaredName(typeName, visitedAliases);
  const cacheKey = activeCppTypeParameterCacheKey.length === 0
    ? typeName
    : `${activeCppTypeParameterCacheKey}\u0000${typeName}`;
  const cached = activeDeclaredCppTypeCache.get(cacheKey);
  if (cached !== undefined) return cached.cppType;
  const result = computeCppTypeForDeclaredName(typeName, new Set<string>());
  activeDeclaredCppTypeCache.set(cacheKey, new DeclaredCppTypeCacheEntry(result));
  return result;
}

function cppTypeForDeclaredNameOr(
  typeName: string,
  fallback: string,
  visitedAliases?: Set<string>
): string {
  const mapped = cppTypeForDeclaredName(typeName, visitedAliases);
  return mapped.length > 0 ? mapped : fallback;
}

function isRecordUtilityTypeName(typeName: string): boolean {
  switch (typeName) {
    case "Omit":
    case "Pick":
    case "Partial":
    case "Required":
    case "Readonly":
      return true;
    default:
      return false;
  }
}

function isDynamicUtilityTypeName(typeName: string): boolean {
  switch (typeName) {
    case "ReturnType":
    case "Parameters":
    case "ConstructorParameters":
    case "InstanceType":
    case "Awaited":
    case "Exclude":
    case "Extract":
    case "NonNullable":
      return true;
    default:
      return false;
  }
}

function computeCppTypeForDeclaredName(typeName: string, visitedAliases: Set<string>): string {
  typeName = stripOuterTypeParentheses(typeName);
  if (typeName.startsWith("readonly ")) typeName = typeName.slice("readonly ".length).trim();
  if (typeName === "never") return "void";
  if (typeName.startsWith("typeof ")) return "vexa::Value";
  if (/^asserts\s+/.test(typeName)) return "void";
  if (/^[A-Za-z_$][\w$]*\s+is\s+/.test(typeName)) return "bool";
  if (typeName.includes("=>")) {
    const functionType = parseFunctionTypeAnnotation(typeName);
    if (!functionType) return "vexa::Value";
    const result = cppTypeForDeclaredName(functionType.returnTypeName, new Set(visitedAliases));
    const parameters = [
      ...(functionType.receiverTypeName ? [functionType.receiverTypeName] : []),
      ...functionType.parameters.map((parameter) => parameter.typeName)
    ].map((parameterTypeName) =>
      cppTypeForDeclaredNameOr(parameterTypeName, "vexa::Value", new Set(visitedAliases)));
    return result ? `std::function<${result}(${parameters.join(", ")})>` : "vexa::Value";
  }
  if (splitTopLevelTypeText(typeName, "&").length > 1) return "vexa::Value";
  const unionMembers = splitTopLevelTypeText(typeName, "|");
  if (unionMembers.length > 1) {
    const presentMembers = unionMembers.filter((member) => {
      const trimmed = member.trim();
      return trimmed !== "undefined" && trimmed !== "null";
    });
    if (presentMembers.length === 1) {
      const presentTypeName = presentMembers[0]!.trim();
      const presentType = cppTypeForDeclaredName(presentTypeName, new Set(visitedAliases));
      if (presentType?.endsWith("*") || presentType?.startsWith("std::function<") || activeCppTypeParameters.has(presentTypeName)) return presentType;
    }
    const memberTypes = unionMembers.map((member) => cppTypeForDeclaredName(member.trim(), new Set(visitedAliases)));
    const firstType = memberTypes[0];
    if (firstType && memberTypes.every((memberType) => memberType === firstType)) return firstType;
    if (firstType?.endsWith("*") && memberTypes.every((memberType) => memberType.endsWith("*"))) {
      let commonType: string | null = firstType;
      for (let index = 1; commonType && index < memberTypes.length; index += 1) {
        commonType = commonClassPointerType(commonType, memberTypes[index]!);
      }
      if (commonType) return commonType;
    }
    return "vexa::Value";
  }
  if (/^(['"]).*\1$/s.test(typeName)) return "vexa::Value";
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(typeName)) return "double";
  if (typeName === "true" || typeName === "false") return "bool";
  if (typeName.startsWith("{") && typeName.endsWith("}")) return "vexa::RecordObject*";
  const arrayType = splitArraySuffixTypeName(typeName);
  if (arrayType) {
    const elementType = arrayType.elementTypeName === "string"
      ? "vexa::Text"
      : cppTypeForDeclaredName(arrayType.elementTypeName, visitedAliases);
    if (!elementType || elementType === "void") return "";
    let result = elementType;
    for (let depth = 0; depth < arrayType.arrayDepth; depth += 1) {
      result = `vexa::ArrayObject<${result}>*`;
    }
    return result;
  }
  if (typeName.includes("[") && typeName.endsWith("]")) return "vexa::Value";
  if (activeCppTypeParameters.has(typeName)) return cppName(typeName);
  const builtin = cppTypeForBuiltin(typeName as BuiltinTypeName);
  if (builtin) return builtin;
  if (activeEnumNames.has(typeName)) return "std::int32_t";
  const shape = parseTypeNameShape(typeName);
  if (isRecordUtilityTypeName(shape.baseName)) {
    return "vexa::RecordObject*";
  }
  if (isDynamicUtilityTypeName(shape.baseName)) {
    return "vexa::Value";
  }
  if (shape.baseName === "Array" || shape.baseName === "ReadonlyArray" || shape.baseName === "ConcatArray") {
    const elementType = cppTypeForDeclaredName(shape.typeArguments[0] ?? "unknown", visitedAliases);
    return elementType && elementType !== "void" ? `vexa::ArrayObject<${elementType}>*` : "";
  }
  if (shape.baseName === "Map" || shape.baseName === "ReadonlyMap") {
    const keyType = cppTypeForDeclaredNameOr(shape.typeArguments[0] ?? "any", "vexa::Value", visitedAliases);
    const valueType = cppTypeForDeclaredNameOr(shape.typeArguments[1] ?? "any", "vexa::Value", visitedAliases);
    return `vexa::MapObject<${keyType}, ${valueType}>*`;
  }
  if (shape.baseName === "Promise") {
    const resultType = cppTypeForDeclaredNameOr(shape.typeArguments[0] ?? "unknown", "vexa::Value", visitedAliases);
    return `vexa::Task<${resultType}>`;
  }
  if (shape.baseName === "Record") return "vexa::RecordObject*";
  if (shape.baseName === "Set" || shape.baseName === "ReadonlySet") {
    const valueType = cppTypeForDeclaredNameOr(shape.typeArguments[0] ?? "any", "vexa::Value", visitedAliases);
    return `vexa::SetObject<${valueType}>*`;
  }
  if (shape.baseName === "WeakMap") {
    const keyType = cppTypeForWeakDeclaredKey(shape.typeArguments[0] ?? "unknown");
    const valueType = cppTypeForDeclaredNameOr(shape.typeArguments[1] ?? "any", "vexa::Value", visitedAliases);
    return keyType?.endsWith("*") ? `vexa::WeakMapObject<${keyType}, ${valueType}>*` : "";
  }
  if (shape.baseName === "WeakSet") {
    const valueType = cppTypeForWeakDeclaredKey(shape.typeArguments[0] ?? "unknown");
    return valueType?.endsWith("*") ? `vexa::WeakSetObject<${valueType}>*` : "";
  }
  if (shape.baseName === "Date") return "vexa::DateObject*";
  if (shape.baseName === "URL") return "vexa::URLObject*";
  if (isNativeErrorTypeName(shape.baseName)) return "vexa::Error";
  if (shape.baseName === "ArrayBuffer") return "vexa::ArrayBufferObject*";
  if (shape.baseName === "Uint8Array") return "vexa::Uint8ArrayObject*";
  if (shape.baseName === "DataView") return "vexa::DataViewObject*";
  if (activeClassNames.has(shape.baseName) || activeInterfaceNames.has(shape.baseName)) {
    const statement = activeClassStatements.get(shape.baseName) ?? activeInterfaceStatements.get(shape.baseName);
    const parameters = statement?.typeParameters ?? [];
    const argumentNames = [...shape.typeArguments];
    for (let index = argumentNames.length; index < parameters.length; index += 1) {
      const defaultType = parameters[index]?.defaultType;
      if (!defaultType) return "";
      argumentNames.push(defaultType.name);
    }
    const typeArguments = argumentNames.map((argument) => cppTypeForDeclaredName(argument, visitedAliases));
    if (typeArguments.some((argument) => !argument) || typeArguments.length < parameters.length) return "";
    const specialization = parameters.length > 0 ? `<${typeArguments.join(", ")}>` : "";
    return `${cppName(statement?.name.name ?? shape.baseName)}${specialization}*`;
  }
  if (visitedAliases.has(typeName)) return "";
  const aliasTarget = activeTypeAliases.get(typeName);
  if (!aliasTarget) return "";
  visitedAliases.add(typeName);
  return cppTypeForDeclaredName(aliasTarget, visitedAliases);
}

function isNativeObjectTypeName(typeName: string): boolean {
  const baseName = parseTypeNameShape(typeName).baseName;
  return activeClassNames.has(baseName) || activeInterfaceNames.has(baseName);
}

function canonicalNativeObjectName(typeName: string): string | null {
  const cacheKey = `${activeCppTypeParameterCacheKey}\u0000${typeName}`;
  if (activeCanonicalNativeObjectNameCache.has(cacheKey)) {
    return activeCanonicalNativeObjectNameCache.get(cacheKey)!;
  }
  const baseName = parseTypeNameShape(typeName).baseName;
  const direct = activeClassStatements.get(baseName) ?? activeInterfaceStatements.get(baseName);
  if (direct) {
    activeCanonicalNativeObjectNameCache.set(cacheKey, direct.name.name);
    return direct.name.name;
  }
  const mapped = cppTypeForDeclaredName(typeName);
  const statement = classStatementForCppType(mapped) ?? interfaceStatementForCppType(mapped);
  let result: string | null = null;
  if (statement) result = statement.name.name;
  activeCanonicalNativeObjectNameCache.set(cacheKey, result);
  return result;
}

function cppArrayElementType(type: AnalysisType): string | null {
  if (type.kind === AnalysisTypeKind.Builtin && type.name === "string") return "vexa::Text";
  if (type.kind === AnalysisTypeKind.Literal && type.base === "string") return "vexa::Text";
  if (type.kind === AnalysisTypeKind.Union) return "vexa::Value";
  return cppTypeForAnalysisType(type);
}

function currentClassPropertyCppType(propertyName: string): string | null {
  if (!activeCurrentClassName) return null;
  const cacheKey = `${activeCurrentClassName}.${propertyName}`;
  if (activeClassPropertyCppTypes.has(cacheKey)) {
    return activeClassPropertyCppTypes.get(cacheKey) ?? null;
  }
  // Install the sentinel before inspecting an initializer so self-referential
  // field expressions cannot recursively infer the same property forever.
  activeClassPropertyCppTypes.set(cacheKey, null);
  const currentClass = activeCurrentClassStatement ?? activeClassStatements.get(activeCurrentClassName);
  const storedProperty = currentClass ? classStoredPropertyInfo(currentClass, propertyName) : null;
  const fieldType: string | null = storedProperty ? storedProperty.valueType : null;
  if (fieldType !== null) {
    activeClassPropertyCppTypes.set(cacheKey, fieldType);
    return fieldType;
  }
  let primaryProperty: ClassPrimaryConstructorParameter | undefined;
  if (currentClass) {
    for (const parameter of currentClass.primaryConstructorParameters ?? []) {
      if (parameter.name.name === propertyName) {
        primaryProperty = parameter;
        break;
      }
    }
  }
  const primaryType = primaryProperty && primaryProperty.typeAnnotation
    ? cppTypeForDeclaredName(primaryProperty.typeAnnotation.name)
    : null;
  activeClassPropertyCppTypes.set(cacheKey, primaryType);
  return primaryType;
}

function cppTypeForExpression(expression: Expr): string {
  const node = expression as Node;
  const cached = activeCppExpressionTypeCache.get(node);
  if (cached) return cached;
  activeCppExpressionTypeCache.set(node, "auto");
  const result = computeCppTypeForExpression(expression);
  activeCppExpressionTypeCache.set(node, result);
  return result;
}

function computeCppTypeForExpression(expression: Expr): string {
  if (expression.kind === NodeKind.CommaExpression) {
    const expressions = (expression as CommaExpression).expressions;
    return expressions.length > 0 ? cppTypeForExpression(expressions[expressions.length - 1]!) : "vexa::Value";
  }
  if (!activeHasExpressionTypes && expression.kind === NodeKind.BinaryExpression) {
    const binary = expression as BinaryExpression;
    if (dynamicBinaryHelper(binary.operator)) {
      return syntacticDynamicBinaryResultType(
        binary.operator,
        emittedCppTypeForExpression(binary.left) ?? "auto",
        emittedCppTypeForExpression(binary.right) ?? "auto"
      ) ?? "vexa::Value";
    }
  }
  if (expression.kind === NodeKind.AsExpression) {
    const mapped = cppTypeForDeclaredName((expression as AsExpression).typeAnnotation.name);
    if (mapped) return mapped;
  }
  if (expression.kind === NodeKind.SatisfiesExpression || expression.kind === NodeKind.NonNullExpression) {
    return cppTypeForExpression((expression as SatisfiesExpression | NonNullExpression).expression);
  }
  if (expression.kind === NodeKind.Identifier) {
    const identifier = expression as Identifier;
    const name = identifier.name;
    const defaultArgument = resolvedDefaultArgument(name);
    if (defaultArgument) return cppTypeForExpression(defaultArgument);
    const declared = activeLocalDeclaredTypeNames.get(name) ?? activeGlobalDeclaredTypeNames.get(name);
    const mappedDeclared = declared ? cppTypeForDeclaredName(declared) : "";
    if (mappedDeclared) return mappedDeclared;
    const emittedType = activeLocalCppTypes.get(name) ?? activeGlobalCppTypes.get(name);
    if (emittedType) return emittedType;
    if (activeImplicitReceiverIdentifiers.has(identifier as Node) && activeCurrentClassName) {
      const propertyType = currentClassPropertyCppType(name);
      if (propertyType) return propertyType;
    }
  }
  if (expression.kind === NodeKind.MemberExpression) {
    const member = expression as MemberExpression;
    const storageType = classStoredPropertyInfoForMember(member)?.valueType;
    if (storageType) return storageType;
    const nativePropertyType = resolvedNativePropertyMember(member)?.valueType;
    if (nativePropertyType) return nativePropertyType;
    if (!member.computed && member.property.kind === NodeKind.Identifier) {
      const property = interfacePropertyForMember(
        createMemberParts(member.object, (member.property as Identifier).name)
      );
      const propertyType = property ? interfacePropertyCppType(property) : null;
      if (propertyType) return propertyType;
    }
    if (usesDynamicClassProperty(member) && !resolvedNativePropertyMember(member)) return "vexa::Value";
    if (!member.computed && member.property.kind === NodeKind.Identifier &&
      member.object.kind === NodeKind.Identifier && (member.object as Identifier).name === "this") {
      const propertyType = currentClassPropertyCppType((member.property as Identifier).name);
      if (propertyType) return propertyType;
    }
  }
  if (expression.kind === NodeKind.CallExpression) {
    const call = expression as CallExpression;
    const callMember = memberParts(call.callee);
    if (callMember?.objectName === "console" && isConsoleMethodName(callMember.propertyName)) {
      return "void";
    }
    const className = identifierName(call.callee);
    const classStatement = className ? activeClassStatements.get(className) : undefined;
    if (classStatement) {
      const constructedType = classConstructionCppType(classStatement, call.args, call);
      if (constructedType) return constructedType;
    }
    const inferredFunctionResult = inferredFunctionCallCppType(call);
    if (inferredFunctionResult) return inferredFunctionResult;
    const member = memberParts((expression as CallExpression).callee);
    if (member?.propertyName === "get") {
      const receiverType = emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object);
      const mapTypes = cppTemplateArguments(receiverType, "vexa::MapObject<");
      if (mapTypes?.length === 2) return mapTypes[1]!;
      const receiverAnalysisType = activeExpressionTypes.get(member.object as Node);
      if (
        receiverAnalysisType?.kind === AnalysisTypeKind.Named &&
        isNativeMapTypeName(receiverAnalysisType.name)
      ) {
        const valueType = receiverAnalysisType.typeArguments?.[1];
        const mappedValueType = valueType ? cppTypeForAnalysisType(valueType) : null;
        if (mappedValueType) return mappedValueType;
      }
    }
  }
  if (expression.kind === NodeKind.NewExpression) {
    const construction = expression as NewExpression;
    const name = identifierName(construction.callee);
    const classStatement = name ? activeClassStatements.get(name) : undefined;
    if (classStatement) {
      const constructedType = classConstructionCppType(classStatement, construction.args ?? [], construction);
      if (constructedType) return constructedType;
    }
    if (name === "ArrayBuffer") return "vexa::ArrayBufferObject*";
    if (name === "Uint8Array") return "vexa::Uint8ArrayObject*";
    if (name === "DataView") return "vexa::DataViewObject*";
  }
  const analysisType = activeExpressionTypes.get(expression as Node);
  if (analysisType) {
    const mapped = cppTypeForAnalysisType(analysisType);
    if (mapped) {
      if (expression.kind === NodeKind.CallExpression) {
        const member = memberParts((expression as CallExpression).callee);
        if (member?.propertyName === "flatMap") {
          const elementType = managedArrayElementType(mapped);
          if (elementType && managedArrayElementType(elementType) !== null) return elementType;
        }
      }
      return mapped;
    }
  }
  if (expression.kind === NodeKind.MemberExpression) {
    const declaredType = declaredTypeNameForExpression(expression);
    if (declaredType) {
      const mapped = cppTypeForDeclaredName(declaredType);
      if (mapped) return mapped;
    }
  }
  if (expression.kind === NodeKind.IntLiteral) return "std::int32_t";
  if (expression.kind === NodeKind.LongLiteral) return "std::int64_t";
  if (expression.kind === NodeKind.BigIntLiteral) return "vexa::BigInt";
  if (expression.kind === NodeKind.FloatLiteral) return "double";
  if (expression.kind === NodeKind.BooleanLiteral) return "bool";
  if (expression.kind === NodeKind.StringLiteral || expression.kind === NodeKind.NullLiteral ||
      expression.kind === NodeKind.UndefinedLiteral) return "vexa::Value";
  if (expression.kind === NodeKind.ArrayLiteral) {
    return `vexa::ArrayObject<${arrayLiteralCppElementType(expression as ArrayLiteral)}>*`;
  }
  return "auto";
}

function managedArrayElementType(type: string): string | null {
  const prefix = "vexa::ArrayObject<";
  return type.startsWith(prefix) && type.endsWith(">*")
    ? type.slice(prefix.length, -2)
    : null;
}

function cppTemplateArguments(type: string, prefix: string): string[] | null {
  if (!type.startsWith(prefix)) return null;
  const suffixLength = type.endsWith(">*") ? 2 : type.endsWith(">") ? 1 : 0;
  if (suffixLength === 0) return null;
  const body = type.slice(prefix.length, -suffixLength);
  const argumentsList: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body.charCodeAt(index);
    if (character === 60) depth += 1;
    if (character === 62) depth -= 1;
    if (character === 44 && depth === 0) {
      argumentsList.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsList.push(body.slice(start).trim());
  return argumentsList;
}

function managedArrayCppTypeForExpression(expression: Expr): string | null {
  if (expression.kind === NodeKind.Identifier) {
    const name = (expression as Identifier).name;
    const globalType = activeGlobalCppTypes.get(name);
    if (globalType && managedArrayElementType(globalType) !== null) return globalType;
    const pointee = activeGcArrayTypes.get(name);
    if (pointee) return `${pointee}*`;
  }
  if (expression.kind === NodeKind.ConditionalExpression) {
    const conditional = expression as ConditionalExpression;
    const consequent = managedArrayCppTypeForExpression(conditional.consequent);
    const alternate = managedArrayCppTypeForExpression(conditional.alternate);
    if (consequent && consequent === alternate) return consequent;
  }
  const mapped = cppTypeForExpression(expression);
  if (managedArrayElementType(mapped) !== null) return mapped;
  const taskPrefix = "vexa::Task<";
  if (mapped.startsWith(taskPrefix) && mapped.endsWith(">")) {
    const result = mapped.slice(taskPrefix.length, -1);
    if (managedArrayElementType(result) !== null) return result;
  }
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind === AnalysisTypeKind.Array || type?.kind === AnalysisTypeKind.Tuple) return cppTypeForAnalysisType(type);
  return null;
}

function isManagedArrayExpression(expression: Expr): boolean {
  if (expression.kind === NodeKind.Identifier && activeGcArrayTypes.has((expression as Identifier).name)) return true;
  if (managedArrayElementType(cppTypeForExpression(expression)) !== null) return true;
  if (managedArrayElementType(emittedCppTypeForExpression(expression) ?? "") !== null) return true;
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === AnalysisTypeKind.Array || type?.kind === AnalysisTypeKind.Tuple ||
    (type?.kind === AnalysisTypeKind.Named && isNativeArrayTypeName(type.name)) ||
    expression.kind === NodeKind.ArrayLiteral;
}

function emitManagedArrayPointer(expression: Expr): string {
  return `vexa::arrayPointer(${emitExpression(expression)})`;
}

function isArrayExpression(expression: Expr): boolean {
  if (expression.kind === NodeKind.Identifier && activeGcArrayTypes.has((expression as Identifier).name)) return true;
  if (managedArrayElementType(cppTypeForExpression(expression)) !== null) return true;
  if (managedArrayElementType(emittedCppTypeForExpression(expression) ?? "") !== null) return true;
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === AnalysisTypeKind.Array || type?.kind === AnalysisTypeKind.Tuple || type?.kind === AnalysisTypeKind.Range ||
    (type?.kind === AnalysisTypeKind.Named && isNativeArrayTypeName(type.name)) ||
    expression.kind === NodeKind.ArrayLiteral || expression.kind === NodeKind.RangeExpression;
}

function nativeCollectionKind(expression: Expr): "map" | "set" | "weakMap" | "weakSet" | null {
  const type = activeExpressionTypes.get(expression as Node);
  const mapped = expression.kind === NodeKind.CallExpression
    ? cppTypeForExpression(expression)
    : emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
  if (mapped.startsWith("vexa::MapObject<")) return "map";
  if (mapped.startsWith("vexa::SetObject<")) return "set";
  if (mapped.startsWith("vexa::WeakMapObject<")) return "weakMap";
  if (mapped.startsWith("vexa::WeakSetObject<")) return "weakSet";
  if (type?.kind === AnalysisTypeKind.Union || type?.kind === AnalysisTypeKind.Intersection) {
    for (const memberType of type.types) {
      if (memberType.kind !== AnalysisTypeKind.Named) continue;
      if (memberType.name === "Map" || memberType.name === "ReadonlyMap") return "map";
      if (memberType.name === "Set" || memberType.name === "ReadonlySet") return "set";
      if (memberType.name === "WeakMap") return "weakMap";
      if (memberType.name === "WeakSet") return "weakSet";
    }
  }
  if (type?.kind !== AnalysisTypeKind.Named) return null;
  if (type.name === "Map" || type.name === "ReadonlyMap") return "map";
  if (type.name === "Set" || type.name === "ReadonlySet") return "set";
  if (type.name === "WeakMap") return "weakMap";
  if (type.name === "WeakSet") return "weakSet";
  return null;
}

function nativeCollectionPointerCppType(expression: Expr): string | null {
  const type = activeExpressionTypes.get(expression as Node);
  if (type) {
    let candidates: AnalysisType[] = [type];
    if (type.kind === AnalysisTypeKind.Union || type.kind === AnalysisTypeKind.Intersection) candidates = type.types;
    for (const candidate of candidates) {
      if (candidate.kind !== AnalysisTypeKind.Named) continue;
      if (!isNativeMapTypeName(candidate.name) && !isNativeSetTypeName(candidate.name) &&
          candidate.name !== "WeakMap" && candidate.name !== "WeakSet") {
        continue;
      }
      const mapped = cppTypeForAnalysisType(candidate);
      if (mapped?.endsWith("*")) return mapped;
    }
  }
  const emitted = emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
  const collectionPrefixes = ["vexa::MapObject<", "vexa::SetObject<", "vexa::WeakMapObject<", "vexa::WeakSetObject<"];
  if (collectionPrefixes.some((prefix) => emitted.startsWith(prefix)) && emitted.endsWith("*")) return emitted;
  return null;
}

function isDateExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === AnalysisTypeKind.Named && type.name === "Date";
}

function isStringExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  const localCppType = expression.kind === NodeKind.Identifier
    ? activeLocalCppTypes.get((expression as Identifier).name)
    : null;
  const interfaceProperty: InterfacePropertyMember | null = expression.kind === NodeKind.MemberExpression && !(expression as MemberExpression).computed &&
    (expression as MemberExpression).property.kind === NodeKind.Identifier
    ? interfacePropertyForMember(createMemberParts(
        (expression as MemberExpression).object,
        ((expression as MemberExpression).property as Identifier).name
      ))
    : null;
  if (expression.kind === NodeKind.CallExpression) {
    const member = memberParts((expression as CallExpression).callee);
    if (member && new Set([
      "toString", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "charAt", "repeat",
      "replace", "substring", "slice",
    ]).has(member.propertyName) && isStringExpression(member.object)) {
      return true;
    }
  }
  return localCppType === "vexa::Text" ||
    (type?.kind === AnalysisTypeKind.Builtin && type.name === "string") ||
    (type?.kind === AnalysisTypeKind.Literal && type.base === "string") ||
    declaredTypeNameForExpression(expression) === "string" ||
    interfaceProperty?.typeAnnotation.name === "string";
}

function nativeBinaryObjectKind(expression: Expr): "buffer" | "uint8" | "dataView" | null {
  const type = activeExpressionTypes.get(expression as Node);
  const declaredName = declaredTypeNameForExpression(expression);
  const mappedType = expression.kind === NodeKind.Identifier
    ? activeLocalCppTypes.get((expression as Identifier).name)
    : null;
  const name = type?.kind === AnalysisTypeKind.Named
    ? type.name
    : declaredName
      ? parseTypeNameShape(declaredName).baseName
      : mappedType === "vexa::ArrayBufferObject*"
        ? "ArrayBuffer"
        : mappedType === "vexa::Uint8ArrayObject*"
          ? "Uint8Array"
          : mappedType === "vexa::DataViewObject*"
            ? "DataView"
            : null;
  if (name === "ArrayBuffer") return "buffer";
  if (name === "Uint8Array") return "uint8";
  if (name === "DataView") return "dataView";
  return null;
}

type NativeCollectionName = "Map" | "Set" | "WeakMap" | "WeakSet";

function nativeCollectionArguments(call: CallExpression | NewExpression): Expr[] {
  return call.kind === NodeKind.CallExpression
    ? (call as CallExpression).args
    : (call as NewExpression).args ?? [];
}

function nativeCollectionTypeArguments(call: CallExpression | NewExpression): Identifier[] {
  return call.kind === NodeKind.CallExpression
    ? (call as CallExpression).typeArguments ?? []
    : (call as NewExpression).typeArguments ?? [];
}

function nativeCollectionCppType(
  call: CallExpression | NewExpression,
  name: NativeCollectionName
): { mapped: string; explicit: string[] } {
  const argumentsList = nativeCollectionArguments(call);
  const typeArguments = nativeCollectionTypeArguments(call);
  let mapped = cppTypeForExpression(call as unknown as Expr);
  let explicit: string[] = [];
  if (typeArguments.length) {
    explicit = typeArguments.map((argument, index): string => {
      if ((name === "WeakMap" || name === "WeakSet") && index === 0) {
        return cppTypeForWeakDeclaredKey(argument.name) ?? "vexa::Value";
      }
      return cppTypeForDeclaredNameOr(argument.name, "vexa::Value");
    });
    if (name === "Map" || name === "WeakMap") {
      if (explicit.length !== 2) throw new CppEmitError("C++ Map expects two explicit type arguments", call);
      mapped = name === "Map"
        ? `vexa::MapObject<${explicit[0]}, ${explicit[1]}>*`
        : `vexa::WeakMapObject<${explicit[0]}, ${explicit[1]}>*`;
    } else {
      if (explicit.length !== 1) throw new CppEmitError("C++ Set expects one explicit type argument", call);
      mapped = name === "Set"
        ? `vexa::SetObject<${explicit[0]}>*`
        : `vexa::WeakSetObject<${explicit[0]}>*`;
    }
  }
  if (activeExpectedExpressionCppType && explicit.length === 0) {
    const expectedPrefix = `vexa::${name}Object<`;
    if (activeExpectedExpressionCppType.startsWith(expectedPrefix) && activeExpectedExpressionCppType.endsWith(">*")) {
      mapped = activeExpectedExpressionCppType;
    }
  }
  if (explicit.length === 0 && !activeExpectedExpressionCppType && argumentsList.length === 1) {
    const iterable = argumentsList[0]!;
    const collectionType = nativeCollectionPointerCppType(iterable);
    if (name === "Map" && collectionType?.startsWith("vexa::MapObject<")) {
      mapped = collectionType;
    } else if (name === "Set") {
      const setElementType = collectionType?.startsWith("vexa::SetObject<")
        ? cppTemplateArguments(collectionType, "vexa::SetObject<")?.[0]
        : iterable.kind === NodeKind.ArrayLiteral
          ? arrayLiteralCppElementType(iterable as ArrayLiteral)
          : managedArrayElementType(managedArrayCppTypeForExpression(iterable) ?? "");
      if (setElementType && setElementType !== "auto") {
        mapped = `vexa::SetObject<${setElementType}>*`;
      }
    }
  }
  if (!activeExpectedExpressionCppType && argumentsList.length === 1) {
    const mappedTypes: string[] | null = cppTemplateArguments(mapped, `vexa::${name}Object<`);
    if (mappedTypes?.every((type) => type === "vexa::Value")) {
      const iterable = argumentsList[0]!;
      const collectionType = nativeCollectionPointerCppType(iterable);
      if (name === "Map" && collectionType?.startsWith("vexa::MapObject<")) {
        mapped = collectionType;
      } else if (name === "Set") {
        const elementType = iterable.kind === NodeKind.ArrayLiteral
          ? arrayLiteralCppElementType(iterable as ArrayLiteral)
          : collectionType?.startsWith("vexa::SetObject<")
            ? cppTemplateArguments(collectionType, "vexa::SetObject<")?.[0]
            : managedArrayElementType(managedArrayCppTypeForExpression(iterable) ?? "");
        if (elementType && elementType !== "auto" && elementType !== "vexa::Value") {
          mapped = `vexa::SetObject<${elementType}>*`;
        }
      }
    }
  }
  if (!mapped.endsWith("*") && name === "Map") mapped = "vexa::MapObject<vexa::Value, vexa::Value>*";
  if (!mapped.endsWith("*") && name === "Set") mapped = "vexa::SetObject<vexa::Value>*";
  if (!mapped.endsWith("*") && name === "WeakSet" && argumentsList.length === 1) {
    const arrayType = managedArrayCppTypeForExpression(argumentsList[0]!);
    const elementType = arrayType ? managedArrayElementType(arrayType) : null;
    const arrayAnalysisType = activeExpressionTypes.get(argumentsList[0]! as Node);
    const analysisElementType = arrayAnalysisType?.kind === AnalysisTypeKind.Array
      ? arrayAnalysisType.elementType
      : arrayAnalysisType?.kind === AnalysisTypeKind.Named &&
          (arrayAnalysisType.name === "Array" || arrayAnalysisType.name === "ReadonlyArray")
        ? arrayAnalysisType.typeArguments?.[0]
        : null;
    const inferredElementType = elementType === "vexa::Value" && analysisElementType?.kind === AnalysisTypeKind.Builtin && analysisElementType.name === "object"
      ? nativeWeakObjectKeyCppType
      : elementType;
    if (inferredElementType?.endsWith("*")) {
      mapped = `vexa::WeakSetObject<${inferredElementType}>*`;
      explicit = [inferredElementType];
    }
  }
  return { mapped, explicit };
}

function emitNativeCollectionConstruction(call: CallExpression | NewExpression, name: NativeCollectionName): string {
  const argumentsList = nativeCollectionArguments(call);
  const typeArguments = nativeCollectionTypeArguments(call);
  if (argumentsList.length > 1) throw new CppEmitError(`C++ ${name} construction expects at most one iterable`, call);
  const { mapped, explicit } = nativeCollectionCppType(call, name);
  if (!mapped.endsWith("*")) {
    throw new CppEmitError(
      `C++ cannot resolve ${name} type arguments${typeArguments.length ? ` '${typeArguments.map((argument) => argument.name).join(", ")}'` : ""}${activeExpectedExpressionCppType ? ` for expected '${activeExpectedExpressionCppType}'` : ""}${activeSourceFilePath ? ` in ${activeSourceFilePath}` : ""}`,
      call
    );
  }
  if (argumentsList.length === 1) {
    if (name === "WeakMap") {
      throw new CppEmitError("C++ WeakMap iterable construction is not implemented yet", call);
    }
    const values = argumentsList[0]!;
    if (name === "WeakSet") {
      if (!isManagedArrayExpression(values) || explicit.length !== 1) {
        throw new CppEmitError("C++ WeakSet iterable construction requires a typed native object array", call);
      }
      return `vexa::weakSetFromArray<${explicit[0]}>(${activeRuntimeName}, ${emitManagedArrayPointer(values)})`;
    }
    if (name === "Map") {
      const mappedTypes = cppTemplateArguments(mapped, "vexa::MapObject<");
      const iterableCollectionTypes = cppTemplateArguments(
        nativeCollectionPointerCppType(values) ?? "",
        "vexa::MapObject<"
      );
      const analysisType = activeExpressionTypes.get(call as Node);
      let inferred: string[] = [];
      if (analysisType?.kind === AnalysisTypeKind.Named) {
        const namedAnalysisType = analysisType as NamedType;
        inferred = (namedAnalysisType.typeArguments ?? []).map(
          (argument: AnalysisType): string => cppTypeForAnalysisType(argument) ?? "vexa::Value"
        );
      }
      let types: string[] = inferred;
      if (mappedTypes) types = mappedTypes;
      if (types.every((type) => type === "vexa::Value") && iterableCollectionTypes) {
        types = iterableCollectionTypes;
      }
      if (explicit.length === 2) types = explicit;
      if (types.length < 2) throw new CppEmitError("C++ cannot infer Map entry types", call);
      return `vexa::mapFromIterable<${types[0]}, ${types[1]}>(${activeRuntimeName}, ${emitExpression(values)})`;
    }
    const mappedTypes = cppTemplateArguments(mapped, `vexa::${name}Object<`);
    const analysisType = activeExpressionTypes.get(call as Node);
    const inferred: string = analysisType?.kind === AnalysisTypeKind.Named
      ? cppTypeForAnalysisType(analysisType.typeArguments?.[0] ?? builtinType("any")) ?? "vexa::Value"
      : "vexa::Value";
    let selectedType: string = inferred;
    if (mappedTypes && mappedTypes.length > 0) selectedType = mappedTypes[0]!;
    if (explicit.length > 0) selectedType = explicit[0]!;
    const iterableType: string | null = managedArrayCppTypeForExpression(values);
    const elementType: string | null = iterableType ? managedArrayElementType(iterableType) : null;
    const iterableCollectionType: string | null = cppTemplateArguments(
      nativeCollectionPointerCppType(values) ?? "",
      `vexa::${name}Object<`
    )?.[0] ?? null;
    let inferredIterableType: string | null = elementType;
    if (inferredIterableType === null) inferredIterableType = iterableCollectionType;
    const emittedType: string = selectedType === "undefined" || selectedType === "vexa::Undefined" ||
        (selectedType === "vexa::Value" && inferredIterableType && inferredIterableType !== "vexa::Value")
      ? inferredIterableType ?? "vexa::Value"
      : selectedType;
    return `vexa::setFromIterable<${emittedType}>(${activeRuntimeName}, ${emitExpression(values)})`;
  }
  return `${activeRuntimeName}.make<${mapped.slice(0, -1)}>()`;
}

function isRecordExpression(expression: Expr): boolean {
  return activeExpressionTypes.get(expression as Node)?.kind === AnalysisTypeKind.Object || expression.kind === NodeKind.ObjectLiteral;
}

function isGeneratorExpression(expression: Expr): boolean {
  const emittedType = expression.kind === NodeKind.Identifier
    ? activeLocalCppTypes.get((expression as Identifier).name)
    : null;
  if (emittedType?.startsWith("vexa::Generator<") || emittedType?.startsWith("vexa::AsyncGenerator<")) return true;
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind === AnalysisTypeKind.Named && (type.name === "Generator" || type.name === "AsyncGenerator")) return true;
  if (expression.kind !== NodeKind.CallExpression) return false;
  const call = expression as CallExpression;
  const functionName = identifierName(call.callee);
  if (functionName && activeFunctionStatements.get(functionName)?.generator) return true;
  const member = memberParts(call.callee);
  const method: CallableMember | null = member ? classMethodForMember(member) : null;
  if (!method || method.kind !== NodeKind.ClassMethodMember) return false;
  const classMethod = method as ClassMethodMember;
  return Boolean(classMethod.generator);
}

function directlyEmittedCppType(expression: Expr): string | null {
  switch (expression.kind) {
    case NodeKind.MemberExpression:
      return resolvedNativePropertyMember(expression)?.valueType ?? null;
    case NodeKind.IntLiteral:
      return "std::int32_t";
    case NodeKind.FloatLiteral:
      return "double";
    case NodeKind.LongLiteral:
      return "std::int64_t";
    case NodeKind.BigIntLiteral:
      return "vexa::BigInt";
    case NodeKind.BooleanLiteral:
      return "bool";
    case NodeKind.StringLiteral:
      return "vexa::Text";
    case NodeKind.NullLiteral:
    case NodeKind.UndefinedLiteral:
      return "vexa::Value";
    case NodeKind.ArrayLiteral:
      return `vexa::ArrayObject<${arrayLiteralCppElementType(expression as ArrayLiteral)}>*`;
    case NodeKind.ObjectLiteral:
      return "vexa::RecordObject*";
    case NodeKind.RegExpLiteral:
      return "vexa::RegExp";
    default:
      return null;
  }
}

function emitConvertedValue(expression: Expr, resultType: string): string {
  if (resultType === "void") {
    return `([&]() { ${emitExpression(expression)}; }())`;
  }
  if (resultType === "vexa::Value" && expression.kind === NodeKind.StringLiteral) {
    return pooledStringLiteral((expression as StringLiteral).value);
  }
  if (directlyEmittedCppType(expression) === resultType) {
    return managedArrayElementType(resultType) !== null
      ? emitExpressionWithExpectedCppType(expression, resultType)
      : emitExpression(expression);
  }
  if (resultType === "vexa::Text" && emittedCppTypeForExpression(expression) === resultType) {
    return emitExpression(expression);
  }
  if (builtinCallCppType(expression) === resultType) {
    return emitExpression(expression);
  }
  if (canStaticallyConvertClassPointer(expression, resultType)) {
    return `static_cast<${resultType}>(${emitExpression(expression)})`;
  }
  if (expression.kind === NodeKind.ConditionalExpression) {
    const conditional = expression as ConditionalExpression;
    const branch = (value: Expr): string => emitConvertedValue(value, resultType);
    return `(${emitCondition(conditional.test)} ? ${branch(conditional.consequent)} : ${branch(conditional.alternate)})`;
  }
  const sourceType = activeExpressionTypes.get(expression as Node);
  const alreadyDynamicRecordMember = expression.kind === NodeKind.MemberExpression &&
    activeExpressionTypes.get((expression as MemberExpression).object as Node)?.kind === AnalysisTypeKind.Object;
  if (resultType === "vexa::Value" &&
      (sourceType?.kind === AnalysisTypeKind.Function || expression.kind === NodeKind.ArrowFunctionExpression || expression.kind === NodeKind.FunctionExpression) &&
      !alreadyDynamicRecordMember) {
    const callableExpression = expression.kind === NodeKind.ArrowFunctionExpression || expression.kind === NodeKind.FunctionExpression
      ? expression as ArrowFunctionExpression | FunctionExpression
      : null;
    const functionType = sourceType?.kind === AnalysisTypeKind.Function ? sourceType as FunctionType : null;
    const callableResult = functionType
      ? cppTypeForAnalysisType(functionType.returnType) ?? "vexa::Value"
      : callableExpression
        ? callableExpressionResultCppType(callableExpression) ?? "vexa::Value"
        : "vexa::Value";
    const callableParameters: string[] = [];
    if (functionType) {
      for (const parameter of functionType.parameters) {
        callableParameters.push(cppTypeForAnalysisType(parameter.type) ?? "vexa::Value");
      }
    } else if (callableExpression) {
      for (const parameter of callableExpression.parameters) {
        callableParameters.push(emittedCallableParameterCppType(parameter, false) ?? "vexa::Value");
      }
    }
    const templateArgumentParts: string[] = [callableResult];
    templateArgumentParts.push(...callableParameters);
    const templateArguments = templateArgumentParts.join(", ");
    const captureNames = nativeFunctionCaptureNames(expression);
    const roots = nativeLambdaRootValues(captureNames);
    const previousFunctionObjectCapture = activeFunctionObjectCapture;
    const previousFunctionObjectCaptureNames = activeFunctionObjectCaptureNames;
    const previousLambdaResult = activeExpectedLambdaResultCppType;
    const previousLambdaParameters = activeExpectedLambdaParameterCppTypes;
    activeFunctionObjectCapture = true;
    activeFunctionObjectCaptureNames = captureNames;
    activeExpectedLambdaResultCppType = callableResult;
    activeExpectedLambdaParameterCppTypes = callableParameters;
    let result: string;
    try {
      result = `vexa::Value(vexa::makeFunction<${templateArguments}>(${activeRuntimeName}, ${emitExpression(expression)}, {${roots.join(", ")}}))`;
    } finally {
      activeFunctionObjectCapture = previousFunctionObjectCapture;
      activeFunctionObjectCaptureNames = previousFunctionObjectCaptureNames;
      activeExpectedLambdaResultCppType = previousLambdaResult;
      activeExpectedLambdaParameterCppTypes = previousLambdaParameters;
    }
    return result;
  }
  if (expression.kind === NodeKind.CallExpression || expression.kind === NodeKind.NewExpression) {
    const collectionName = identifierName((expression as CallExpression | NewExpression).callee);
    if (collectionName &&
        (collectionName === "Map" || collectionName === "Set" || collectionName === "WeakMap" || collectionName === "WeakSet") &&
        resultType.startsWith(`vexa::${collectionName}Object<`) && resultType.endsWith(">*")) {
      return emitExpressionWithExpectedCppType(expression, resultType);
    }
  }
  if (
    managedArrayElementType(resultType) !== null &&
    (expression.kind === NodeKind.CallExpression || expression.kind === NodeKind.ArrayLiteral)
  ) {
    const previous = activeExpectedExpressionCppType;
    activeExpectedExpressionCppType = resultType;
    let result: string;
    try {
      result = `vexa::convertValue<${resultType}>(${emitExpression(expression)})`;
    } finally {
      activeExpectedExpressionCppType = previous;
    }
    return result;
  }
  if (resultType.endsWith("*")) {
    let interfaceName: string | null = null;
    for (const [candidateName, rawStatement] of activeInterfaceStatements) {
      const statement = rawStatement as InterfaceStatement;
      if (!statement.typeParameters?.length && cppTypeForDeclaredName(statement.name.name) === resultType) {
        interfaceName = candidateName;
        break;
      }
    }
    if (interfaceName) {
      if (expression.kind === NodeKind.ObjectLiteral) {
        return emitRecordInterfaceAdaptation(expression, interfaceName);
      }
      return `vexa::adaptInterface<${resultType.slice(0, -1)}, ${recordInterfaceAdapterName(interfaceName)}>(${activeRuntimeName}, ${emitExpression(expression)})`;
    }
  }
  return `vexa::convertValue<${resultType}>(${emitExpression(expression)})`;
}

function emitArrayElements(elements: readonly Expr[], elementType: string): string {
  const emitTypedElement = (element: Expr): string =>
    interfaceStatementForCppType(elementType) !== null
      ? emitConvertedValue(element, elementType)
      : elementType.startsWith("vexa::Task<")
        ? emitExpressionWithExpectedCppType(element, elementType)
      : emittedCppTypeForExpression(element) !== elementType
        ? emitConvertedValue(element, elementType)
        : emitExpression(element);
  const hasExpandedElements = elements.some((element) =>
    element.kind === NodeKind.ArrayHole || element.kind === NodeKind.SpreadExpression);
  if (hasExpandedElements) {
    const operations = elements.map((element) => {
      if (element.kind === NodeKind.ArrayHole) {
        if (elementType !== "vexa::Value") {
          throw new CppEmitError("C++ sparse arrays require a dynamic value element type");
        }
        return "vexa::push(__vexa_array, vexa::Value::undefined())";
      }
      if (element.kind === NodeKind.SpreadExpression) {
        const argument = (element as SpreadExpression).argument;
        const argumentType = emittedCppTypeForExpression(argument) ?? cppTypeForExpression(argument);
        const source = argumentType === "vexa::Value"
          ? elementType === "vexa::Value"
            ? emitExpression(argument)
            : emitExpressionWithExpectedCppType(argument, `vexa::ArrayObject<${elementType}>*`)
          : isManagedArrayExpression(argument)
            ? emitManagedArrayPointer(argument)
            : emitExpression(argument);
        return elementType === "vexa::Value"
          ? `vexa::appendAllConverted(${activeRuntimeName}, __vexa_array, ${source})`
          : `vexa::appendAll(__vexa_array, ${source})`;
      }
      const value = elementType === "vexa::Value"
        ? emitConvertedValue(element as Expr, "vexa::Value")
        : emitTypedElement(element as Expr);
      return `vexa::push(__vexa_array, ${value})`;
    });
    return `([&]() { auto* __vexa_array = ${activeRuntimeName}.array<${elementType}>(); ${operations.join("; ")}; return __vexa_array; }())`;
  }
  const emittedElements = elementType === "vexa::Value"
    ? elements.map((element) => emitConvertedValue(element as Expr, "vexa::Value"))
    : elements.map((element) => emitTypedElement(element as Expr));
  return `${activeRuntimeName}.array<${elementType}>({${emittedElements.join(", ")}})`;
}

function arrayLiteralElementCppType(element: Expr): string {
  if (element.kind === NodeKind.ArrayHole) return "vexa::Value";
  if (element.kind === NodeKind.StringLiteral) return "vexa::Text";
  if (element.kind === NodeKind.IntLiteral) return "std::int32_t";
  if (element.kind === NodeKind.FloatLiteral) return "double";
  if (element.kind === NodeKind.LongLiteral) return "std::int64_t";
  if (element.kind === NodeKind.BooleanLiteral) return "bool";
  if (element.kind === NodeKind.NullLiteral || element.kind === NodeKind.UndefinedLiteral) return "vexa::Value";
  if (element.kind === NodeKind.SpreadExpression) {
    const spreadType = emittedCppTypeForExpression((element as SpreadExpression).argument) ??
      cppTypeForExpression((element as SpreadExpression).argument);
    return managedArrayElementType(spreadType) ?? "vexa::Value";
  }
  if (element.kind === NodeKind.ArrayLiteral) {
    return `vexa::ArrayObject<${arrayLiteralCppElementType(element as ArrayLiteral)}>*`;
  }
  const elementType = emittedCppTypeForExpression(element) ?? cppTypeForExpression(element);
  return !elementType || elementType === "auto" ? "vexa::Value" : elementType;
}

function arrayLiteralCppElementType(array: ArrayLiteral): string {
  if (array.elements.length === 0) return "vexa::Value";
  const elementTypes = new Set(array.elements.map((element) => arrayLiteralElementCppType(element as Expr)));
  return elementTypes.size === 1 ? [...elementTypes][0]! : "vexa::Value";
}

function arrayElementCanUseCppType(element: Expr, expectedElementType: string): boolean {
  if (element.kind === NodeKind.ArrayHole) return expectedElementType === "vexa::Value";
  if (element.kind === NodeKind.SpreadExpression) {
    const spreadType = emittedCppTypeForExpression((element as SpreadExpression).argument) ??
      cppTypeForExpression((element as SpreadExpression).argument);
    const spreadElementType = managedArrayElementType(spreadType);
    return spreadElementType === null || spreadElementType === expectedElementType || expectedElementType === "vexa::Value";
  }
  if (element.kind === NodeKind.StringLiteral) {
    return expectedElementType === "vexa::Text" || expectedElementType === "vexa::Value";
  }
  if (element.kind === NodeKind.IntLiteral || element.kind === NodeKind.FloatLiteral || element.kind === NodeKind.LongLiteral) {
    return expectedElementType === "std::int32_t" || expectedElementType === "std::int64_t" ||
      expectedElementType === "double" || expectedElementType === "vexa::Value";
  }
  if (element.kind === NodeKind.BooleanLiteral) {
    return expectedElementType === "bool" || expectedElementType === "vexa::Value";
  }
  if (element.kind === NodeKind.NullLiteral || element.kind === NodeKind.UndefinedLiteral) {
    return expectedElementType === "vexa::Value" || expectedElementType.endsWith("*");
  }
  if (element.kind === NodeKind.ArrayLiteral) {
    const nestedExpectedType = managedArrayElementType(expectedElementType);
    return nestedExpectedType === null ||
      (element as ArrayLiteral).elements.every((nested) =>
        arrayElementCanUseCppType(nested as Expr, nestedExpectedType));
  }
  const actualType = emittedCppTypeForExpression(element) ?? cppTypeForExpression(element);
  return !(actualType?.startsWith("vexa::Task<") && expectedElementType === "vexa::Value");
}

function emitArrayLiteral(array: ArrayLiteral): string {
  const rawInferredType = managedArrayElementType(cppTypeForExpression(array as unknown as Expr));
  const inferredType = rawInferredType === "auto" ? null : rawInferredType;
  const rawExpectedElementType = activeExpectedExpressionCppType
    ? managedArrayElementType(activeExpectedExpressionCppType)
    : null;
  const expectedElementType = rawExpectedElementType === "auto" ? null : rawExpectedElementType;
  const syntacticElementType = arrayLiteralCppElementType(array);
  const compatibleExpectedType = expectedElementType &&
    array.elements.every((element) => arrayElementCanUseCppType(element as Expr, expectedElementType));
  const compatibleInferredType = inferredType &&
    array.elements.every((element) => arrayElementCanUseCppType(element as Expr, inferredType));
  const elementType = compatibleExpectedType
    ? expectedElementType
    : compatibleInferredType
      ? inferredType
      : syntacticElementType;
  return emitArrayElements(array.elements, elementType);
}

function objectPropertyName(property: ObjectProperty): string | null {
  if (property.computed) return null;
  if (property.key.kind === NodeKind.Identifier) return (property.key as Identifier).name;
  if (property.key.kind === NodeKind.StringLiteral) {
    return (property.key as StringLiteral).value;
  }
  if (property.key.kind === NodeKind.IntLiteral || property.key.kind === NodeKind.FloatLiteral) {
    return String((property.key as IntLiteral | FloatLiteral).value);
  }
  return null;
}

function objectLiteralPropertyValue(expression: Expr, propertyName: string): Expr | null {
  if (expression.kind !== NodeKind.ObjectLiteral) return null;
  const property = (expression as ObjectLiteral).properties.find((candidate) =>
    candidate.kind === NodeKind.ObjectProperty && objectPropertyName(candidate as ObjectProperty) === propertyName);
  return property?.kind === NodeKind.ObjectProperty ? (property as ObjectProperty).value : null;
}

function emitObjectLiteral(object: ObjectLiteral): string {
  const expectedPropertyTypes = activeExpectedRecordPropertyCppTypes;
  activeExpectedRecordPropertyCppTypes = null;
  const emitPropertyValue = (name: string, value: Expr): string => {
    const expectedType = expectedPropertyTypes?.get(name);
    return expectedType
      ? `vexa::convertValue<vexa::Value>(${emitExpressionWithExpectedCppType(value, expectedType)})`
      : emitConvertedValue(value, "vexa::Value");
  };
  const emitSpreadValue = (value: Expr): string => {
    const previousExpectedType = activeExpectedExpressionCppType;
    activeExpectedExpressionCppType = null;
    let result: string;
    try {
      result = emitExpression(value);
    } finally {
      activeExpectedExpressionCppType = previousExpectedType;
    }
    return result;
  };
  let result: string;
  try {
    const simple = object.properties.every((property) =>
      property.kind === NodeKind.ObjectProperty &&
      !(property as ObjectProperty).computed &&
      !(property as ObjectProperty).method);
    if (simple) {
      const properties = object.properties.map((property) => {
        const objectProperty = property as ObjectProperty;
        const name = objectPropertyName(objectProperty)!;
        return `{${cppUtf16String(name)}, ${emitPropertyValue(name, objectProperty.value)}}`;
      });
      result = `${activeRuntimeName}.record({${properties.join(", ")}})`;
    } else {
      const operations = object.properties.map((property) => {
        if (property.kind === NodeKind.ObjectSpreadProperty) {
          return `vexa::recordSpread(__vexa_record, ${emitSpreadValue(property.argument)})`;
        }
        const objectProperty = property as ObjectProperty;
        const name = objectPropertyName(objectProperty);
        const key = objectProperty.computed
          ? `vexa::propertyKey(${emitExpression(objectProperty.key)})`
          : cppUtf16String(name!);
        return `vexa::recordSet(${activeRuntimeName}, __vexa_record, ${key}, ${emitPropertyValue(name ?? "", objectProperty.value)})`;
      });
      result = `([&]() { auto* __vexa_record = ${activeRuntimeName}.record(); ${operations.join("; ")}; return __vexa_record; }())`;
    }
  } finally {
    activeExpectedRecordPropertyCppTypes = expectedPropertyTypes;
  }
  return result;
}

type CallableParameter = FunctionParameter | ClassPrimaryConstructorParameter;

function callableParameterName(parameter: CallableParameter): string | null {
  return parameter.name.kind === NodeKind.Identifier ? (parameter.name as Identifier).name : null;
}

function callableParameterIsOptional(parameter: CallableParameter | undefined): boolean {
  return Boolean(parameter && "optional" in parameter && parameter.optional);
}

function cppTypeForCallableParameter(parameter: CallableParameter, allowInferredTypes: boolean): string | null {
  if (parameter.typeAnnotation?.name) return cppTypeForDeclaredName(parameter.typeAnnotation.name);
  if (parameter.defaultValue) return cppTypeForExpression(parameter.defaultValue);
  return allowInferredTypes ? "auto" : "vexa::Value";
}

function cppTypeForSubstitutedCallableParameter(
  parameter: CallableParameter,
  substitutions: ReadonlyMap<string, string> | undefined
): string | null {
  const declared = parameter.typeAnnotation?.name;
  if (!declared || !substitutions?.size) return cppTypeForCallableParameter(parameter, false);
  const functionType = parseFunctionTypeAnnotation(declared);
  if (!functionType) return cppTypeForDeclaredName(substituteTypeName(declared, substitutions));
  const mapType = (typeName: string): string | null => {
    const binding = substitutions.get(typeName);
    return binding ? cppTypeForDeclaredNameOr(binding, binding) : cppTypeForDeclaredName(typeName);
  };
  const result = mapType(functionType.returnTypeName);
  if (!result) return null;
  const parameters = functionType.parameters.map((item) => mapType(item.typeName) ?? "vexa::Value");
  return `std::function<${result}(${parameters.join(", ")})>`;
}

function emittedCallableParameterCppType(
  parameter: CallableParameter,
  allowInferredTypes: boolean,
  substitutions?: ReadonlyMap<string, string>
): string | null {
  let type = substitutions
    ? cppTypeForSubstitutedCallableParameter(parameter, substitutions)
    : cppTypeForCallableParameter(parameter, allowInferredTypes);
  if (callableParameterIsOptional(parameter) && type && type !== "vexa::Value" && !type.endsWith("*") && !type.startsWith("std::function<")) {
    type = "vexa::Value";
  }
  return type;
}

function emittedCppTypeForExpression(expression: Expr): string | null {
  const node = expression as Node;
  if (activeEmittedExpressionTypeCache.has(node)) {
    return activeEmittedExpressionTypeCache.get(node) ?? null;
  }
  activeEmittedExpressionTypeCache.set(node, null);
  const result = computeEmittedCppTypeForExpression(expression);
  activeEmittedExpressionTypeCache.set(node, result);
  return result;
}

function clearExpressionTypeCaches(): void {
  activeCppExpressionTypeCache = new Map();
  activeEmittedExpressionTypeCache = new Map();
}

function builtinCallCppType(expression: Expr): string {
  if (expression.kind !== NodeKind.CallExpression) return "";
  const name = identifierName((expression as CallExpression).callee);
  if (name && activeLocalNames.has(name)) return "";
  if (name === "String") return "vexa::Text";
  if (name === "Number") return "double";
  return "";
}

function isDynamicValueExpression(expression: Expr): boolean {
  if (expression.kind === NodeKind.Identifier) {
    const name = (expression as Identifier).name;
    const localType = activeLocalCppTypes.get(name);
    if (localType) return localType === "vexa::Value";
    if (activeDynamicValueNames.has(name)) return true;
  }
  return emittedCppTypeForExpression(expression) === "vexa::Value";
}

function stdFunctionResultCppType(type: string): string | null {
  const prefix = "std::function<";
  if (!type.startsWith(prefix) || !type.endsWith(">")) return null;
  const signature = type.slice(prefix.length, -1);
  let templateDepth = 0;
  for (let index = 0; index < signature.length; index += 1) {
    const character = signature.charCodeAt(index);
    if (character === 60) templateDepth += 1;
    else if (character === 62) templateDepth -= 1;
    else if (character === 40 && templateDepth === 0) return signature.slice(0, index);
  }
  return null;
}

function stdFunctionParameterCppTypes(type: string): string[] | null {
  const prefix = "std::function<";
  if (!type.startsWith(prefix) || !type.endsWith(">")) return null;
  const signature = type.slice(prefix.length, -1);
  let templateDepth = 0;
  for (let index = 0; index < signature.length; index += 1) {
    const character = signature.charCodeAt(index);
    if (character === 60) templateDepth += 1;
    else if (character === 62) templateDepth -= 1;
    else if (character === 40 && templateDepth === 0 && signature.endsWith(")")) {
      const parameters = signature.slice(index + 1, -1).trim();
      if (parameters.length === 0) return [];
      return cppTemplateArguments(`__vexa_parameters<${parameters}>`, "__vexa_parameters<");
    }
  }
  return null;
}

function callableExpressionResultCppType(
  expression: ArrowFunctionExpression | FunctionExpression
): string | null {
  if (expression.returnType) {
    const mapped = cppTypeForDeclaredName(expression.returnType.name);
    if (mapped) return mapped;
  }
  const functionType = activeExpressionTypes.get(expression as Node);
  if (functionType?.kind === AnalysisTypeKind.Function) {
    const mapped = cppTypeForAnalysisType((functionType as FunctionType).returnType);
    if (mapped) return mapped;
  }
  const previousLocalCppTypes = activeLocalCppTypes;
  const previousDynamicNames = activeDynamicValueNames;
  const previousCppTypeCache = activeCppExpressionTypeCache;
  const previousEmittedTypeCache = activeEmittedExpressionTypeCache;
  activeLocalCppTypes = new Map(activeLocalCppTypes);
  activeDynamicValueNames = new Set(activeDynamicValueNames);
  activeCppExpressionTypeCache = new Map();
  activeEmittedExpressionTypeCache = new Map();
  expression.parameters.forEach((parameter, index) => {
    if (parameter.name.kind !== NodeKind.Identifier) return;
    const type = activeExpectedLambdaParameterCppTypes?.[index] ??
      emittedCallableParameterCppType(parameter, false);
    if (!type) return;
    activeLocalCppTypes.set(parameter.name.name, type);
    if (type === "vexa::Value") activeDynamicValueNames.add(parameter.name.name);
  });
  try {
    const body = expression.kind === NodeKind.FunctionExpression
      ? (expression as FunctionExpression).body
      : (expression as ArrowFunctionExpression).body;
    if (body.kind === NodeKind.BlockStatement) {
      const block = body as BlockStatement;
      if (!containsValueReturn(block)) return "void";
      return inferredCallableReturnType(block);
    }
    const declared = cppTypeForExpression(body as Expr);
    const mapped = declared === "auto" ? emittedCppTypeForExpression(body as Expr) : declared;
    return mapped === "auto" ? null : mapped;
  } finally {
    activeLocalCppTypes = previousLocalCppTypes;
    activeDynamicValueNames = previousDynamicNames;
    activeCppExpressionTypeCache = previousCppTypeCache;
    activeEmittedExpressionTypeCache = previousEmittedTypeCache;
  }
}

function callbackResultCppType(expression: Expr): string | null {
  const analyzed = activeExpressionTypes.get(expression as Node);
  if (analyzed?.kind === AnalysisTypeKind.Function) {
    const mapped = cppTypeForAnalysisType(analyzed.returnType);
    if (mapped) return mapped;
  }
  if (expression.kind === NodeKind.ArrowFunctionExpression || expression.kind === NodeKind.FunctionExpression) {
    return callableExpressionResultCppType(expression as ArrowFunctionExpression | FunctionExpression);
  }
  if (expression.kind === NodeKind.Identifier) {
    const statement = activeFunctionStatements.get((expression as Identifier).name);
    if (statement?.returnType) return cppTypeForDeclaredName(statement.returnType.name);
  }
  return null;
}

function emitNativePointerExpression(expression: Expr, expectedPointerType: string | null = null): string {
  const emitted = emitExpression(expression);
  if (!isDynamicValueExpression(expression)) return `vexa::rawPointer(${emitted})`;
  const targetType = expectedPointerType ?? cppTypeForExpression(expression);
  if (!targetType.endsWith("*")) {
    const sourceLine: number | null = expression.firstToken ? expression.firstToken.range.start.line + 1 : null;
    let sourceName: string;
    if (expression.kind === NodeKind.Identifier) {
      sourceName = (expression as Identifier).name;
    } else if (expression.kind === NodeKind.MemberExpression) {
      const member = expression as MemberExpression;
      const objectName: string = identifierName(member.object) ?? String(expression.kind);
      const propertyName: string = identifierName(member.property) ?? "[computed]";
      sourceName = `${objectName}.${propertyName}`;
    } else {
      sourceName = String(expression.kind);
    }
    throw new CppEmitError(
      `C++ dynamic receiver '${sourceName}' cannot be converted to native pointer type '${targetType}'${activeSourceFilePath ? ` in ${activeSourceFilePath}` : ""}${sourceLine ? `:${sourceLine}` : ""}`,
      expression
    );
  }
  return `vexa::convertValue<${targetType}>(${emitted})`;
}

function emitNativeReceiverCall(
  optional: boolean,
  receiver: string,
  emitCallWithReceiver: (receiver: string) => string
): string {
  if (!optional) return emitCallWithReceiver(receiver);
  return `vexa::optionalCall(${activeRuntimeName}, ${receiver}, [&](auto* __vexa_optional_receiver) { return ${emitCallWithReceiver("__vexa_optional_receiver")}; })`;
}

function emitOptionalPointerAccess(
  receiver: string,
  resultType: string,
  emitAccess: (receiver: string) => string
): string {
  const access = emitAccess("__vexa_optional_receiver");
  const value = resultType === "vexa::Value"
    ? `vexa::convertValue<vexa::Value>(${access})`
    : access;
  return `([&]() { auto* __vexa_optional_receiver = vexa::rawPointer(${receiver}); return __vexa_optional_receiver ? ${value} : vexa::defaultValue<${resultType}>(); }())`;
}

function emitDynamicCallArgument(argument: Expr): string {
  const value = argument.kind === NodeKind.NamedArgument ? (argument as NamedArgument).value : argument;
  if (value.kind !== NodeKind.ArrowFunctionExpression && value.kind !== NodeKind.FunctionExpression) {
    return emitConvertedValue(value, "vexa::Value");
  }
  const callable = value as ArrowFunctionExpression | FunctionExpression;
  const previousParameters = activeExpectedLambdaParameterCppTypes;
  activeExpectedLambdaParameterCppTypes = callable.parameters.map(() => "vexa::Value");
  let result: string;
  try {
    result = emitConvertedValue(value, "vexa::Value");
  } finally {
    activeExpectedLambdaParameterCppTypes = previousParameters;
  }
  return result;
}

function computeEmittedCppTypeForExpression(expression: Expr): string | null {
  if (expression.kind === NodeKind.CommaExpression) {
    const expressions = (expression as CommaExpression).expressions;
    return expressions.length > 0
      ? emittedCppTypeForExpression(expressions[expressions.length - 1]!)
      : "vexa::Value";
  }
  if (!activeHasExpressionTypes && expression.kind === NodeKind.BinaryExpression &&
      dynamicBinaryHelper((expression as BinaryExpression).operator)) {
    return "vexa::Value";
  }
  if (expression.kind === NodeKind.Identifier) {
    const name = (expression as Identifier).name;
    const defaultArgument = resolvedDefaultArgument(name);
    if (defaultArgument) return emittedCppTypeForExpression(defaultArgument);
    const localType = activeLocalCppTypes.get(name);
    if (localType) return localType;
  }
  if (expression.kind === NodeKind.ArrowFunctionExpression || expression.kind === NodeKind.FunctionExpression) {
    const callable = expression as ArrowFunctionExpression | FunctionExpression;
    const resultType = callableExpressionResultCppType(callable);
    if (resultType) {
      const parameterTypes: string[] = [];
      for (const parameter of callable.parameters) {
        parameterTypes.push(emittedCallableParameterCppType(parameter, false) ?? "vexa::Value");
      }
      return `std::function<${resultType}(${parameterTypes.join(", ")})>`;
    }
  }
  if (expression.kind === NodeKind.UnaryExpression && (expression as UnaryExpression).operator === "await") {
    const awaited = (expression as UnaryExpression).argument;
    const awaitedType = emittedCppTypeForExpression(awaited) ?? cppTypeForExpression(awaited);
    return cppTemplateArguments(awaitedType, "vexa::Task<")?.[0] ?? awaitedType;
  }
  if (expression.kind === NodeKind.CallExpression) {
    const callExpression = expression as CallExpression;
    const calleeName = identifierName(callExpression.callee);
    const builtinType = builtinCallCppType(callExpression);
    if (builtinType) return builtinType;
    const callMember = memberParts(callExpression.callee);
    if (callExpression.callee.kind === NodeKind.MemberExpression) {
      const calleeMember = callExpression.callee as MemberExpression;
      if (calleeMember.optional || isOptionalChainExpression(calleeMember.object)) {
        // optionalCall always boxes its result so it can represent undefined
        // when the receiver is absent, including for boolean collection APIs.
        return "vexa::Value";
      }
    }
    if (callMember?.objectName === "JSON" && callMember.propertyName === "stringify") {
      return "vexa::Value";
    }
    if (callMember?.objectName === "Date" && new Set(["now", "parse"]).has(callMember.propertyName)) {
      return "double";
    }
    if (callMember?.objectName === "console" && isConsoleMethodName(callMember.propertyName)) {
      return "void";
    }
    const localCallableType = calleeName ? activeLocalCppTypes.get(calleeName) : undefined;
    const localCallableResult = localCallableType ? stdFunctionResultCppType(localCallableType) : null;
    if (localCallableResult) return localCallableResult;
    const declaredMethod = callMember ? classMethodForMember(callMember) : null;
    if (declaredMethod?.returnType) {
      const bindings = methodTemplateBindings(callExpression, declaredMethod);
      const receiverTypeName = callMember ? declaredTypeNameForExpression(callMember.object) : null;
      const receiverStatement = callMember
        ? classStatementForCppType(cppTypeForExpression(callMember.object)) ??
          interfaceStatementForCppType(cppTypeForExpression(callMember.object))
        : null;
      if (receiverTypeName && receiverStatement?.typeParameters?.length) {
        const receiverShape = parseTypeNameShape(receiverTypeName);
        receiverStatement.typeParameters.forEach((parameter, index) => {
          const argument = receiverShape.typeArguments[index] ?? parameter.defaultType?.name;
          if (argument && !bindings.has(parameter.name.name)) {
            bindings.set(parameter.name.name, cppTypeForDeclaredNameOr(argument, argument));
          }
        });
      }
      const mappedMethodResult = cppTypeForBoundDeclaredName(
        declaredMethod.returnType.name,
        bindings
      );
      if (mappedMethodResult) return mappedMethodResult;
    }
    const member = memberParts((expression as CallExpression).callee);
    const collectionKind = member ? nativeCollectionKind(member.object) : null;
    const collectionType = member ? nativeCollectionPointerCppType(member.object) : null;
    if (member && collectionKind && new Set(["has", "delete"]).has(member.propertyName)) {
      return "bool";
    }
    if (member?.propertyName === "get" && collectionKind === "map") {
      const resultType = cppTypeForExpression(expression);
      if (resultType.endsWith("*")) return resultType;
      return "vexa::Value";
    }
    const mapTypes = collectionType ? cppTemplateArguments(collectionType, "vexa::MapObject<") : null;
    if (member?.propertyName === "keys" && mapTypes) {
      return `vexa::ArrayObject<${mapTypes[0]}>*`;
    }
    if (member?.propertyName === "values" && mapTypes) {
      return `vexa::ArrayObject<${mapTypes[1]}>*`;
    }
    if (member?.propertyName === "entries" && mapTypes) {
      return "vexa::ArrayObject<vexa::ArrayObject<vexa::Value>*>*";
    }
    const setTypes = collectionType ? cppTemplateArguments(collectionType, "vexa::SetObject<") : null;
    if ((member?.propertyName === "keys" || member?.propertyName === "values" || member?.propertyName === "entries") && setTypes) {
      return `vexa::ArrayObject<${setTypes[0]}>*`;
    }
  }
  if (expression.kind === NodeKind.AsExpression) {
    if (dynamicStructuralCastSource(expression)) return "vexa::Value";
    const mapped = cppTypeForDeclaredName((expression as AsExpression).typeAnnotation.name);
    return mapped.length > 0
      ? mapped
      : emittedCppTypeForExpression((expression as AsExpression).expression);
  }
  if (expression.kind === NodeKind.SatisfiesExpression || expression.kind === NodeKind.NonNullExpression) {
    return emittedCppTypeForExpression((expression as SatisfiesExpression | NonNullExpression).expression);
  }
  if (expression.kind === NodeKind.MemberExpression) {
    const member = expression as MemberExpression;
    if (emittedCppTypeForExpression(member.object) === "vexa::Value") return "vexa::Value";
    const propertyName = !member.computed ? identifierName(member.property) : null;
    const interfaceProperty = propertyName
      ? interfacePropertyForMember(createMemberParts(member.object, propertyName))
      : null;
    const interfacePropertyType = interfaceProperty
      ? interfacePropertyCppType(interfaceProperty)
      : null;
    if (member.optional || isOptionalChainExpression(member.object)) {
      const valueType: string = interfacePropertyType ??
        classStoredPropertyInfoForMember(member)?.valueType ??
        resolvedNativePropertyMember(member)?.valueType ??
        cppTypeForExpression(expression);
      if (!valueType.endsWith("*")) return "vexa::Value";
    }
    if (interfacePropertyType) return interfacePropertyType;
    if (member.optional && !member.computed && classStoredPropertyInfoForMember(member)) return "vexa::Value";
    const storageType = classStoredPropertyInfoForMember(member)?.valueType;
    if (storageType) return storageType;
    const nativePropertyType = resolvedNativePropertyMember(member)?.valueType;
    if (nativePropertyType) return nativePropertyType;
    if (usesDynamicClassProperty(member) && !resolvedNativePropertyMember(member)) return "vexa::Value";
    if (member.computed && member.optional && isManagedArrayExpression(member.object)) {
      const arrayType = managedArrayCppTypeForExpression(member.object);
      const elementType = arrayType ? managedArrayElementType(arrayType) : null;
      return elementType?.endsWith("*") ? elementType : "vexa::Value";
    }
    if (member.computed && member.optional) return "vexa::Value";
  }
  if (expression.kind === NodeKind.ConditionalExpression) {
    const conditional = expression as ConditionalExpression;
    const consequent = emittedCppTypeForExpression(conditional.consequent);
    const alternate = emittedCppTypeForExpression(conditional.alternate);
    if (consequent === alternate) return consequent;
    const consequentElement = consequent ? managedArrayElementType(consequent) : null;
    const alternateElement = alternate ? managedArrayElementType(alternate) : null;
    if (consequentElement && alternateElement) {
      if (consequentElement === "vexa::Value") return alternate;
      if (alternateElement === "vexa::Value") return consequent;
    }
    if (consequent?.endsWith("*") && isNullishNodeKind(conditional.alternate.kind)) {
      return consequent;
    }
    if (alternate?.endsWith("*") && isNullishNodeKind(conditional.consequent.kind)) {
      return alternate;
    }
    if (consequent?.endsWith("*") && alternate?.endsWith("*")) {
      const commonType = commonClassPointerType(consequent, alternate);
      if (commonType) return commonType;
    }
    if (consequent === "vexa::Value" || alternate === "vexa::Value") return "vexa::Value";
  }
  if (expression.kind === NodeKind.BinaryExpression &&
      new Set(["&&", "||"]).has((expression as BinaryExpression).operator)) {
    const binary = expression as BinaryExpression;
    const left = emittedCppTypeForExpression(binary.left) ?? cppTypeForExpression(binary.left);
    const right = emittedCppTypeForExpression(binary.right) ?? cppTypeForExpression(binary.right);
    if (left === "bool" && right === "bool") return "bool";
    return left === right && left !== "void" ? left : "vexa::Value";
  }
  if (expression.kind === NodeKind.BinaryExpression && (expression as BinaryExpression).operator === "??") {
    const binary = expression as BinaryExpression;
    const indexedArrayType = binary.left.kind === NodeKind.MemberExpression &&
      (binary.left as MemberExpression).computed &&
      !(binary.left as MemberExpression).optional &&
      isManagedArrayExpression((binary.left as MemberExpression).object)
      ? managedArrayElementType(
          managedArrayCppTypeForExpression((binary.left as MemberExpression).object) ?? ""
        )
      : null;
    const left = hasValueBackedClassProperty(binary.left) || indexedArrayType !== null
      ? "vexa::Value"
      : emittedCppTypeForExpression(binary.left);
    const right = emittedCppTypeForExpression(binary.right);
    const declaredLeft = cppTypeForExpression(binary.left);
    if (binary.right.kind === NodeKind.ArrayLiteral && (binary.right as ArrayLiteral).elements.length === 0) {
      const contextualLeft = declaredLeft !== "auto" && declaredLeft !== "vexa::Value" ? declaredLeft : left;
      if (contextualLeft) return contextualLeft;
    }
    if (left === "vexa::Value") {
      const analysisType = activeExpressionTypes.get(expression as Node);
      const mappedAnalysisType = analysisType ? cppTypeForAnalysisType(analysisType) : null;
      if (mappedAnalysisType === "void" || mappedAnalysisType === "vexa::Null" || mappedAnalysisType === "vexa::Undefined") {
        return right && !new Set(["void", "vexa::Null", "vexa::Undefined"]).has(right)
          ? right
          : "vexa::Value";
      }
      return mappedAnalysisType && mappedAnalysisType !== "vexa::Value"
        ? mappedAnalysisType
        : "vexa::Value";
    }
    if (left && left !== "auto" && !left.endsWith("*")) return left;
    if (left === right) return left;
    if (left?.endsWith("*") && right?.endsWith("*")) {
      return commonClassPointerType(left, right) ?? "vexa::Value";
    }
  }
  if (expression.kind === NodeKind.NewExpression || expression.kind === NodeKind.CallExpression) {
    const call = expression as NewExpression | CallExpression;
    const name = identifierName(call.kind === NodeKind.NewExpression ? call.callee : call.callee);
    if (name && new Set<NativeCollectionName>(["Map", "Set", "WeakMap", "WeakSet"]).has(name as NativeCollectionName)) {
      return nativeCollectionCppType(call, name as NativeCollectionName).mapped;
    }
    if (expression.kind === NodeKind.NewExpression && name === "URL") return "vexa::URLObject*";
    if (expression.kind === NodeKind.NewExpression && name === "Date") return "vexa::DateObject*";
    if (expression.kind === NodeKind.CallExpression) {
      const callExpression = expression as CallExpression;
      const member = memberParts(callExpression.callee);
      if (callExpression.callee.kind === NodeKind.MemberExpression &&
          (callExpression.callee as MemberExpression).optional) {
        return "vexa::Value";
      }
      if (member?.objectName === "Promise" && member.propertyName === "resolve") {
        const argument = callExpression.args[0];
        if (!argument) return "vexa::Task<vexa::Value>";
        let resultType = emittedCppTypeForExpression(argument) ?? cppTypeForExpression(argument);
        let nested = cppTemplateArguments(resultType, "vexa::Task<")?.[0];
        while (nested) {
          resultType = nested;
          nested = cppTemplateArguments(resultType, "vexa::Task<")?.[0];
        }
        return `vexa::Task<${resultType}>`;
      }
      if (member?.objectName === "Promise" && member.propertyName === "reject") {
        return "vexa::Task<vexa::Value>";
      }
      if (member?.objectName === "Promise" && new Set(["all", "race", "any"]).has(member.propertyName)) {
        const taskArray = callExpression.args[0];
        let resultType: string | null = null;
        if (taskArray?.kind === NodeKind.ArrayLiteral) {
          for (const element of (taskArray as ArrayLiteral).elements) {
            if (element.kind === NodeKind.SpreadExpression) continue;
            const taskType = emittedCppTypeForExpression(element);
            const candidate = taskType ? cppTemplateArguments(taskType, "vexa::Task<")?.[0] : null;
            if (!candidate) continue;
            resultType ??= candidate;
            if (candidate !== "void" && candidate !== "vexa::Value") {
              resultType = candidate;
              break;
            }
          }
        }
        if (resultType) {
          return member.propertyName === "all"
            ? `vexa::Task<vexa::ArrayObject<${resultType}>*>`
            : `vexa::Task<${resultType}>`;
        }
      }
      const functionName = identifierName(callExpression.callee);
      const functionStatement = functionName ? activeFunctionStatements.get(functionName) : undefined;
      if (functionStatement?.generator) {
        const generator: CallableGeneratorInfo = callableGeneratorInfo(
          functionStatement.name,
          functionStatement.returnType,
          true,
          Boolean(functionStatement.async || functionStatement.sync),
          functionStatement
        )!;
        return `vexa::${generator.async ? "AsyncGenerator" : "Generator"}<${generator.resultType}>`;
      }
      const generatorReceiverType = member
        ? emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object)
        : null;
      const generatorElementType = generatorReceiverType
        ? cppTemplateArguments(generatorReceiverType, "vexa::Generator<")?.[0]
        : null;
      if (generatorElementType && new Set(["next", "return"]).has(member!.propertyName)) {
        return `vexa::GeneratorResult<${generatorElementType}>`;
      }
      if (member?.objectName === "Object") {
        if (member.propertyName === "keys") return "vexa::ArrayObject<vexa::Text>*";
        if (member.propertyName === "values") return "vexa::ArrayObject<vexa::Value>*";
        if (member.propertyName === "entries") return "vexa::ArrayObject<vexa::ArrayObject<vexa::Value>*>*";
      }
      if (member?.objectName === "Number" && member.propertyName === "isInteger") return "bool";
      if (member?.objectName === "Number" && member.propertyName === "isNaN") return "bool";
      if (member?.objectName === "Array" && member.propertyName === "isArray") return "bool";
      if (member?.objectName === "String" && member.propertyName === "fromCharCode") return "vexa::Text";
      if (member?.objectName === "Promise" && member.propertyName === "allSettled") {
        return "vexa::Task<vexa::ArrayObject<vexa::RecordObject*>*>";
      }
      if (member && new Set(["then", "catch", "finally"]).has(member.propertyName)) {
        const receiverType = emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object);
        if (receiverType.startsWith("vexa::Task<")) {
          if (member.propertyName === "then") {
            const callback = callExpression.args[0];
            if (callback && (callback.kind === NodeKind.ArrowFunctionExpression || callback.kind === NodeKind.FunctionExpression)) {
              const callbackResult = callableExpressionResultCppType(
                callback as ArrowFunctionExpression | FunctionExpression
              );
              if (callbackResult && callbackResult !== "void") {
                return callbackResult.startsWith("vexa::Task<")
                  ? callbackResult
                  : `vexa::Task<${callbackResult}>`;
              }
            }
          }
          return receiverType;
        }
      }
      if (member && isStringExpression(member.object)) {
        if (member.propertyName === "split") return "vexa::ArrayObject<vexa::Text>*";
        if (new Set([
          "toString", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd", "charAt", "repeat",
          "replace", "substring", "slice",
        ]).has(member.propertyName)) return "vexa::Text";
        if (new Set(["includes", "startsWith", "endsWith", "test"]).has(member.propertyName)) return "bool";
        if (new Set(["charCodeAt", "lastIndexOf", "indexOf"]).has(member.propertyName)) return "double";
      }
      if (member && isArrayExpression(member.object)) {
        if (isDynamicValueExpression(member.object)) return "vexa::Value";
        const receiverType = managedArrayCppTypeForExpression(member.object) ??
          emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object);
        const elementType = managedArrayElementType(receiverType);
        if (new Set(["slice", "concat", "filter", "splice", "reverse", "fill", "copyWithin", "sort"]).has(member.propertyName)) {
          return receiverType;
        }
        if (new Set(["includes", "some", "every"]).has(member.propertyName)) return "bool";
        if (member.propertyName === "join") return "vexa::Text";
        if (member.propertyName === "map" || member.propertyName === "flatMap") {
          const callback = callExpression.args[0];
          let callbackResult = callback ? callbackResultCppType(callback) : null;
          if ((!callbackResult || callbackResult === "void" || callbackResult === "auto") && callback &&
              (callback.kind === NodeKind.ArrowFunctionExpression || callback.kind === NodeKind.FunctionExpression)) {
            const callable = callback as ArrowFunctionExpression | FunctionExpression;
            const previousParameters = activeExpectedLambdaParameterCppTypes;
            activeExpectedLambdaParameterCppTypes = elementType
              ? [elementType, "double", receiverType]
              : null;
            try {
              callbackResult = callableExpressionResultCppType(callable);
            } finally {
              activeExpectedLambdaParameterCppTypes = previousParameters;
            }
          }
          if (callbackResult && callbackResult !== "void" && callbackResult !== "auto") {
            const mappedElement = member.propertyName === "flatMap"
              ? managedArrayElementType(callbackResult) ?? callbackResult
              : callbackResult;
            return `vexa::ArrayObject<${mappedElement}>*`;
          }
          return `vexa::ArrayObject<${elementType ?? "vexa::Value"}>*`;
        }
        if (member.propertyName === "reduce") {
          const initial = callExpression.args[1];
          if (initial) return emittedCppTypeForExpression(initial) ?? cppTypeForExpression(initial);
        }
        if (elementType && new Set(["pop", "shift", "at", "find"]).has(member.propertyName)) {
          return elementType;
        }
        if (member.propertyName === "indexOf" || member.propertyName === "lastIndexOf" || member.propertyName === "findIndex") {
          return "double";
        }
      }
      const resolvedCalleeProperty: NativePropertyMember | null = resolvedNativePropertyMember(callExpression.callee);
      if (resolvedCalleeProperty?.kind === "dynamic") {
        return "vexa::Value";
      }
      if (member?.propertyName === "exec" && cppTypeForExpression(member.object) === "vexa::RegExp") {
        return "vexa::ArrayObject<vexa::Value>*";
      }
      if (member?.propertyName === "get" && nativeCollectionKind(member.object) === "map") {
        return "vexa::Value";
      }
      if (member?.propertyName === "get" && nativeCollectionKind(member.object) === "weakMap") {
        const mapTypes = cppTemplateArguments(
          emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object),
          "vexa::WeakMapObject<"
        );
        if (mapTypes?.[1]) return mapTypes[1];
      }
      const inferredFunctionResult = inferredFunctionCallCppType(expression as CallExpression);
      if (inferredFunctionResult) return inferredFunctionResult;
      const declaredResult = declaredCallResultType(expression as CallExpression);
      const mappedResult = declaredResult ? cppTypeForDeclaredName(declaredResult) : "";
      if (mappedResult) return mappedResult;
    }
  }
  if (expression.kind === NodeKind.MemberExpression) {
    const member = expression as MemberExpression;
    const generatorResultType = cppTemplateArguments(
      emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object),
      "vexa::GeneratorResult<"
    )?.[0];
    if (!member.computed && generatorResultType && member.property.kind === NodeKind.Identifier) {
      const propertyName = (member.property as Identifier).name;
      if (propertyName === "done") return "bool";
      if (propertyName === "value") return generatorResultType;
    }
    if (!member.computed && identifierName(member.property) === "length" &&
      (isManagedArrayExpression(member.object) || isStringExpression(member.object) ||
        nativeBinaryObjectKind(member.object) === "uint8")) {
      return member.optional ? "vexa::Value" : "double";
    }
    const nativeProperty = resolvedNativePropertyMember(expression);
    if (nativeProperty?.kind === "dynamic") return "vexa::Value";
    if (nativeProperty?.kind === "record") {
      const declaredResult = declaredTypeNameForExpression(expression);
      return declaredResult ? cppTypeForDeclaredNameOr(declaredResult, "vexa::Value") : "vexa::Value";
    }
    if (member.computed && isManagedArrayExpression(member.object)) {
      const arrayType = managedArrayCppTypeForExpression(member.object) ??
        emittedCppTypeForExpression(member.object) ??
        cppTypeForExpression(member.object);
      return managedArrayElementType(arrayType);
    }
    if (isDynamicValueExpression(member.object)) return "vexa::Value";
    if (!member.computed && member.property.kind === NodeKind.Identifier) {
      const property = interfacePropertyForMember(
        createMemberParts(member.object, (member.property as Identifier).name)
      );
      const propertyType = property ? interfacePropertyCppType(property) : null;
      if (propertyType) return propertyType;
    }
  }
  return cppTypeForExpression(expression);
}

function emitArguments(
  argumentsList: readonly Expr[],
  parameters?: readonly CallableParameter[],
  typeSubstitutions?: ReadonlyMap<string, string>
): string {
  if (!parameters) {
    return argumentsList.map((argument) => emitExpression(argument)).join(", ");
  }
  const ordered = orderedCallArguments(argumentsList, parameters);
  const restIndex = parameters.findIndex((parameter) => "rest" in parameter && parameter.rest);
  const fixedArgumentCount = restIndex >= 0 ? restIndex : ordered.length;
  const emitArgument = (argument: Expr, index: number): string => {
    const parameter = parameters[index];
    const declaredParameterType = parameter?.typeAnnotation?.name;
    const parameterType = declaredParameterType;
    const substitutedParameterType = declaredParameterType && typeSubstitutions?.size
      ? substituteTypeName(declaredParameterType, typeSubstitutions)
      : declaredParameterType;
    const parameterCppType = parameter
      ? emittedCallableParameterCppType(parameter, false, typeSubstitutions)
      : substitutedParameterType ? cppTypeForDeclaredName(substitutedParameterType) : null;
    const argumentCppType = hasValueBackedClassProperty(argument) || isDynamicValueExpression(argument)
      ? "vexa::Value"
      : emittedCppTypeForExpression(argument);
    const resolvedArgumentProperty: NativePropertyMember | null = resolvedNativePropertyMember(argument);
    const dynamicPropertyArgument = resolvedArgumentProperty?.kind === "dynamic";
    const parameterIsInterface = interfaceStatementForCppType(parameterCppType) !== null;
    if (parameterCppType?.startsWith("std::function<") &&
      (argument.kind === NodeKind.ArrowFunctionExpression || argument.kind === NodeKind.FunctionExpression)) {
      return parameterCppType
        ? emitExpressionWithExpectedCallableType(argument, parameterCppType)
        : emitExpression(argument);
    }
    if (parameterCppType === "vexa::Value") {
      return emitConvertedValue(argument, "vexa::Value");
    }
    return parameterCppType && argument.kind === NodeKind.ConditionalExpression
      ? emitConvertedValue(argument, parameterCppType)
      : parameterCppType && /^(?:vexa::)?(?:Map|Set|WeakMap|WeakSet)Object</.test(parameterCppType) &&
          (argument.kind === NodeKind.NewExpression || argument.kind === NodeKind.CallExpression)
        ? emitExpressionWithExpectedCppType(argument, parameterCppType)
      : parameterCppType && managedArrayElementType(parameterCppType) !== null &&
          (argument.kind === NodeKind.ArrayLiteral ||
            (managedArrayElementType(argumentCppType ?? "") !== null && parameterCppType !== argumentCppType))
        ? emitExpressionWithExpectedCppType(argument, parameterCppType)
      : parameterType && activeInterfaceNames.has(parameterType) && isRecordExpression(argument)
      ? emitRecordInterfaceAdaptation(argument, parameterType)
      : parameterIsInterface && parameterCppType !== argumentCppType
        ? emitConvertedValue(argument, parameterCppType!)
      : argument.kind === NodeKind.UndefinedLiteral && parameterCppType?.endsWith("*")
        ? "nullptr"
      : parameterCppType?.endsWith("*") && argumentCppType?.endsWith("*") &&
          parameterCppType !== argumentCppType &&
          classStatementForCppType(parameterCppType) !== null &&
          classStatementForCppType(argumentCppType) !== null
        ? emitConvertedValue(argument, parameterCppType)
      : parameterCppType && parameterCppType !== argumentCppType &&
          (parameterCppType === "vexa::Value" || argumentCppType === "vexa::Value")
        ? emitConvertedValue(argument, parameterCppType)
      : dynamicPropertyArgument && parameterCppType && parameterCppType !== "vexa::Value"
        ? emitConvertedValue(argument, parameterCppType)
        : emitExpression(argument);
  };
  const emitted: string[] = ordered.slice(0, fixedArgumentCount).map((argument, index): string => {
    const parameter = parameters[index];
    if (!parameter?.defaultValue || argument !== parameter.defaultValue) {
      return emitArgument(argument, index);
    }
    const previous = activeDefaultArgumentExpressions;
    const bindings = new Map<string, Expr>();
    for (const [name, expression] of previous) bindings.set(name, expression);
    for (let parameterIndex = 0; parameterIndex < index; parameterIndex += 1) {
      const name = callableParameterName(parameters[parameterIndex]!);
      if (name) bindings.set(name, ordered[parameterIndex]!);
    }
    activeDefaultArgumentExpressions = bindings;
    let result: string;
    try {
      result = emitArgument(argument, index);
    } finally {
      activeDefaultArgumentExpressions = previous;
    }
    return result;
  });
  if (restIndex >= 0) {
    const restParameter = parameters[restIndex]!;
    const restCppType = cppTypeForDeclaredName(restParameter.typeAnnotation?.name ?? "");
    const elementType = restCppType ? managedArrayElementType(restCppType) : null;
    if (!elementType) throw new CppEmitError("C++ rest parameters require a supported array type");
    const restArguments = ordered.slice(restIndex).filter((argument) =>
      !(argument.kind === NodeKind.ArrayLiteral && (argument as ArrayLiteral).__vexaEmptyRest));
    emitted.push(emitArrayElements(restArguments, elementType));
  }
  return emitted.join(", ");
}

function orderedCallArguments(
  argumentsList: readonly Expr[],
  parameters: readonly CallableParameter[]
): Expr[] {
  const ordered: Array<Expr | undefined> = new Array(parameters.length);
  let positionalIndex = 0;
  for (const argument of argumentsList) {
    if (argument.kind === NodeKind.NamedArgument) {
      const named = argument as NamedArgument;
      const parameterIndex = parameters.findIndex((parameter) => callableParameterName(parameter) === named.name.name);
      if (parameterIndex >= 0) ordered[parameterIndex] = named.value;
      continue;
    }
    while (ordered[positionalIndex]) positionalIndex += 1;
    ordered[positionalIndex] = argument;
    positionalIndex += 1;
  }
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!;
    if (!ordered[index] && parameter.defaultValue) {
      ordered[index] = parameter.defaultValue;
    } else if (!ordered[index] && callableParameterIsOptional(parameter)) {
      ordered[index] = new UndefinedLiteral();
    } else if (!ordered[index] && "rest" in parameter && parameter.rest) {
      ordered[index] = new ArrayLiteral([], true);
    }
  }
  if (ordered.some((argument) => argument === undefined)) {
    throw new CppEmitError("C++ emission could not resolve every required call argument");
  }
  return ordered as Expr[];
}

function emitCallArguments(call: CallExpression, parameters?: readonly CallableParameter[]): string {
  return emitArguments(call.args, parameters);
}

function emitAnalyzedCallArguments(call: CallExpression): string {
  const callable = activeExpressionTypes.get(call.callee as Node) ??
    activeCallableTypes.get(call.callee as Node) ??
    activeExpressionTypes.get(call as Node);
  if (callable?.kind !== AnalysisTypeKind.Function) return emitCallArguments(call);
  return call.args.map((argument, index) => {
    const value = argument.kind === NodeKind.NamedArgument ? (argument as NamedArgument).value : argument;
    const parameter = callable.parameters[index] ?? callable.parameters.at(-1);
    let expected = parameter ? cppTypeForAnalysisType(parameter.type) : null;
    if (parameter?.rest && expected) expected = managedArrayElementType(expected) ?? expected;
    const actual = hasValueBackedClassProperty(value) || isDynamicValueExpression(value)
      ? "vexa::Value"
      : emittedCppTypeForExpression(value);
    if (!expected || expected === actual) return emitExpression(value);
    if (managedArrayElementType(expected) !== null || /^(?:vexa::)?(?:Map|Set|WeakMap|WeakSet)Object</.test(expected)) {
      return emitExpressionWithExpectedCppType(value, expected);
    }
    return emitExpressionWithExpectedCallableType(value, expected);
  }).join(", ");
}

function emitExpressionWithExpectedCallableType(expression: Expr, expectedCppType: string): string {
  const match = /^std::function<(.+)\([^()]*\)>$/.exec(expectedCppType);
  if (!match || (expression.kind !== NodeKind.ArrowFunctionExpression && expression.kind !== NodeKind.FunctionExpression)) {
    return emitConvertedValue(expression, expectedCppType);
  }
  const previous = activeExpectedLambdaResultCppType;
  activeExpectedLambdaResultCppType = match[1]!;
  let result: string;
  try {
    result = emitExpression(expression);
  } finally {
    activeExpectedLambdaResultCppType = previous;
  }
  return result;
}

function withRuntimeArgument(argumentsText: string): string {
  return argumentsText;
}

function classNameForExpression(expression: Expr): string | null {
  if (expression.kind === NodeKind.Identifier) {
    const name = (expression as Identifier).name;
    const defaultArgument = resolvedDefaultArgument(name);
    if (defaultArgument) return classNameForExpression(defaultArgument);
    if (name === "this") return activeCurrentClassName;
    const tracked = activeGcObjectTypes.get(name);
    if (tracked) return canonicalNativeObjectName(tracked) ?? parseTypeNameShape(tracked).baseName;
    const declared = activeLocalDeclaredTypeNames.get(name);
    const declaredObjectName = declared ? canonicalNativeObjectName(declared) : null;
    if (declaredObjectName) return declaredObjectName;
    if (isNativeObjectTypeName(name)) return null;
  }
  if (expression.kind === NodeKind.MemberExpression) {
    const propertyTypeName = classStoredPropertyInfoForMember(expression as MemberExpression)?.typeName;
    const propertyClassName = propertyTypeName ? canonicalNativeObjectName(propertyTypeName) : null;
    if (propertyClassName) return propertyClassName;
  }
  const declaredTypeName = declaredTypeNameForExpression(expression);
  const declaredObjectName = declaredTypeName ? canonicalNativeObjectName(declaredTypeName) : null;
  if (declaredObjectName) return declaredObjectName;
  if (expression.kind === NodeKind.CallExpression) {
    const calleeName = identifierName((expression as CallExpression).callee);
    if (calleeName && activeClassNames.has(calleeName)) return calleeName;
  }
  if (expression.kind === NodeKind.NewExpression) {
    const calleeName = identifierName((expression as NewExpression).callee);
    if (calleeName && activeClassNames.has(calleeName)) return calleeName;
  }
  const mappedType = emittedCppTypeForExpression(expression);
  if (mappedType?.endsWith("*")) {
    const classStatement = classStatementForCppType(mappedType);
    if (classStatement) return classStatement.name.name;
    const interfaceStatement = interfaceStatementForCppType(mappedType);
    if (interfaceStatement) return interfaceStatement.name.name;
  }
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === AnalysisTypeKind.Named && isNativeObjectTypeName(type.name)
    ? canonicalNativeObjectName(type.name)
    : null;
}

function declaredTypeNameForExpression(expression: Expr): string | null {
  if (expression.kind === NodeKind.AsExpression) {
    return (expression as AsExpression).typeAnnotation.name;
  }
  if (expression.kind === NodeKind.SatisfiesExpression || expression.kind === NodeKind.NonNullExpression) {
    return declaredTypeNameForExpression((expression as SatisfiesExpression | NonNullExpression).expression);
  }
  if (expression.kind === NodeKind.Identifier) {
    const name = (expression as Identifier).name;
    const defaultArgument = resolvedDefaultArgument(name);
    if (defaultArgument) return declaredTypeNameForExpression(defaultArgument);
    if (name === "this") return activeCurrentClassName;
    return activeLocalDeclaredTypeNames.get(name) ?? activeGlobalDeclaredTypeNames.get(name) ?? null;
  }
  if (expression.kind === NodeKind.CallExpression) {
    return declaredCallResultType(expression as CallExpression);
  }
  if (expression.kind !== NodeKind.MemberExpression) return null;
  const member = expression as MemberExpression;
  if (member.computed) {
    const receiverTypeName = declaredTypeNameForExpression(member.object);
    if (!receiverTypeName) return null;
    const receiverShape = parseTypeNameShape(receiverTypeName);
    if (receiverShape.baseName !== "Record") return null;
    return receiverShape.typeArguments[1] ?? null;
  }
  if (member.property.kind !== NodeKind.Identifier) return null;
  const receiverTypeName = declaredTypeNameForExpression(member.object);
  if (!receiverTypeName) return null;
  const receiverShape = parseTypeNameShape(receiverTypeName);
  const objectMembers = parseObjectTypeAnnotation(receiverTypeName);
  if (objectMembers) {
    for (const objectMember of objectMembers) {
      if (objectMember.name === (member.property as Identifier).name) return objectMember.typeName;
    }
  }
  const canonicalReceiverName = canonicalNativeObjectName(receiverTypeName) ?? receiverShape.baseName;
  const statement = activeClassStatements.get(canonicalReceiverName) ?? activeInterfaceStatements.get(canonicalReceiverName);
  if (!statement) return null;
  const bindings = new Map<string, string>();
  const typeParameters = statement.typeParameters ?? [];
  for (let index = 0; index < typeParameters.length; index += 1) {
    const parameter = typeParameters[index]!;
    const argument = receiverShape.typeArguments[index] ?? parameter.defaultType?.name;
    if (argument) bindings.set(parameter.name.name, argument);
  }
  if (statement.kind === NodeKind.ClassStatement) {
    const field = statement.members.find((candidate): candidate is ClassFieldMember =>
      candidate.kind === NodeKind.ClassFieldMember && candidate.name.name === (member.property as Identifier).name);
    if (field?.typeAnnotation) return substituteTypeName(field.typeAnnotation.name, bindings);
    const propertyName = (member.property as Identifier).name;
    let primaryProperty: ClassPrimaryConstructorParameter | undefined;
    for (const parameter of statement.primaryConstructorParameters ?? []) {
      if (parameter.name.name === propertyName) {
        primaryProperty = parameter;
        break;
      }
    }
    if (primaryProperty?.typeAnnotation) return substituteTypeName(primaryProperty.typeAnnotation.name, bindings);
    const constructor = classConstructorMethod(statement);
    if (!constructor) return null;
    const constructorProperty = constructor.parameters.find((parameter) =>
      parameter.name.kind === NodeKind.Identifier &&
      (parameter.name as Identifier).name === propertyName &&
      (parameter.accessModifier !== undefined || parameter.isReadonly === true));
    if (!constructorProperty?.typeAnnotation) return null;
    return substituteTypeName(constructorProperty.typeAnnotation.name, bindings);
  }
  const property = interfacePropertyForName(statement, (member.property as Identifier).name);
  return property ? substituteTypeName(property.typeAnnotation.name, bindings) : null;
}

function optionalCppValueType(declaredType: string, typeName: string): string {
  return declaredType.endsWith("*") ||
    declaredType.startsWith("std::function<") ||
    activeCppTypeParameters.has(typeName)
    ? declaredType
    : "vexa::Value";
}

function classFieldValueCppType(field: ClassFieldMember): string | null {
  if (field.typeAnnotation) {
    const declaredType = cppTypeForDeclaredName(field.typeAnnotation.name);
    return field.optional
      ? optionalCppValueType(declaredType, field.typeAnnotation.name)
      : declaredType;
  }
  if (field.optional) return "vexa::Value";
  const inferredType = field.initializer ? emittedCppTypeForExpression(field.initializer) : null;
  return inferredType && inferredType !== "auto" ? inferredType : null;
}

interface ClassStoredPropertyInfo {
  typeName: string | null;
  valueType: string;
}

function classStoredPropertyInfo(statement: ClassStatement, propertyName: string): ClassStoredPropertyInfo | null {
  const cacheKey = `${activeCppTypeParameterCacheKey}\u0000${statement.name.name}\u0000${propertyName}`;
  if (activeClassStoredPropertyInfoCache.has(cacheKey)) {
    return activeClassStoredPropertyInfoCache.get(cacheKey)!;
  }
  for (const candidateClass of classHierarchy(statement)) {
    const field = candidateClass.members.find((candidate): candidate is ClassFieldMember =>
      candidate.kind === NodeKind.ClassFieldMember && !candidate.declared && candidate.name.name === propertyName);
    const fieldType = field
      ? classFieldValueCppType(field) ?? (field.typeAnnotation ? "vexa::Value" : null)
      : null;
    if (field && fieldType) {
      const typeName: string | null = field.typeAnnotation ? field.typeAnnotation.name : null;
      const result = { typeName, valueType: fieldType };
      activeClassStoredPropertyInfoCache.set(cacheKey, result);
      return result;
    }

    let primaryProperty: ClassPrimaryConstructorParameter | undefined;
    for (const parameter of candidateClass.primaryConstructorParameters ?? []) {
      if (parameter.name.name === propertyName) {
        primaryProperty = parameter;
        break;
      }
    }
    const primaryTypeName = primaryProperty?.typeAnnotation?.name;
    const primaryType = primaryTypeName ? cppTypeForDeclaredNameOr(primaryTypeName, "vexa::Value") : null;
    if (primaryTypeName && primaryType) {
      const result = { typeName: primaryTypeName, valueType: primaryType };
      activeClassStoredPropertyInfoCache.set(cacheKey, result);
      return result;
    }

    const constructorMethod = classConstructorMethod(candidateClass);
    const constructorProperty = constructorMethod
      ? constructorMethod.parameters.find((parameter) =>
          parameter.name.kind === NodeKind.Identifier &&
          (parameter.name as Identifier).name === propertyName &&
          (parameter.accessModifier !== undefined || parameter.isReadonly === true))
      : undefined;
    const constructorTypeName = constructorProperty?.typeAnnotation?.name;
    const rawConstructorType = constructorProperty
      ? emittedCallableParameterCppType(constructorProperty, false) ?? "vexa::Value"
      : null;
    const constructorType = constructorProperty?.optional && rawConstructorType && constructorTypeName
      ? optionalCppValueType(rawConstructorType, constructorTypeName)
      : rawConstructorType;
    if (constructorTypeName && constructorType) {
      const result = { typeName: constructorTypeName, valueType: constructorType };
      activeClassStoredPropertyInfoCache.set(cacheKey, result);
      return result;
    }
  }
  activeClassStoredPropertyInfoCache.set(cacheKey, null);
  return null;
}

function classStoredPropertyInfoForMember(member: MemberExpression): ClassStoredPropertyInfo | null {
  if (member.computed || member.property.kind !== NodeKind.Identifier) return null;
  const className = classNameForExpression(member.object);
  const statement = className ? activeClassStatements.get(className) : undefined;
  const info = statement ? classStoredPropertyInfo(statement, (member.property as Identifier).name) : null;
  if (!info?.typeName || !statement) return info;
  const typeParameters: TypeParameter[] | undefined = statement.typeParameters;
  if (!typeParameters || typeParameters.length === 0) return info;
  const receiverTypeName = declaredTypeNameForExpression(member.object);
  if (!receiverTypeName) return info;
  const receiverShape = parseTypeNameShape(receiverTypeName);
  const bindings = new Map<string, string>();
  for (let index = 0; index < typeParameters.length; index += 1) {
    const parameter = typeParameters[index]!;
    const argument = receiverShape.typeArguments[index] ?? parameter.defaultType?.name;
    if (argument) bindings.set(parameter.name.name, argument);
  }
  if (bindings.size === 0) return info;
  const typeName = substituteTypeName(info.typeName, bindings);
  return {
    typeName,
    valueType: cppTypeForDeclaredNameOr(typeName, info.valueType),
  };
}

function hasValueBackedClassProperty(expression: Expr): boolean {
  if (expression.kind === NodeKind.MemberExpression) {
    const member = expression as MemberExpression;
    if (classStoredPropertyInfoForMember(member)?.valueType === "vexa::Value") return true;
    return hasValueBackedClassProperty(member.object);
  }
  if (expression.kind === NodeKind.AsExpression ||
      expression.kind === NodeKind.SatisfiesExpression ||
      expression.kind === NodeKind.NonNullExpression) {
    return hasValueBackedClassProperty((expression as AsExpression | SatisfiesExpression | NonNullExpression).expression);
  }
  return false;
}

function classHierarchy(statement: ClassStatement): ClassStatement[] {
  const hierarchy: ClassStatement[] = [];
  const visited = new Set<string>();
  let current: ClassStatement | undefined = statement;
  while (current && !visited.has(current.name.name)) {
    hierarchy.push(current);
    visited.add(current.name.name);
    const baseTypeName: string | undefined = current.extendsType?.name;
    const baseName: string | null = baseTypeName
      ? canonicalNativeObjectName(baseTypeName) ?? parseTypeNameShape(baseTypeName).baseName
      : null;
    current = baseName ? activeClassStatements.get(baseName) : undefined;
  }
  return hierarchy;
}

function commonClassPointerType(leftType: string, rightType: string): string | null {
  const leftClass = classStatementForCppType(leftType);
  const rightClass = classStatementForCppType(rightType);
  if (!leftClass || !rightClass) return null;
  const leftNames = new Set(classHierarchy(leftClass).map((statement) => statement.name.name));
  const commonClass = classHierarchy(rightClass).find((statement) => leftNames.has(statement.name.name));
  return commonClass ? cppTypeForDeclaredName(commonClass.name.name) : null;
}

function canStaticallyConvertClassPointer(expression: Expr, resultType: string): boolean {
  if (!resultType.endsWith("*")) return false;
  const sourceType = emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
  return commonClassPointerType(sourceType, resultType) === resultType;
}

function isClassStoredPropertyMember(member: MemberExpression): boolean {
  return classStoredPropertyInfoForMember(member) !== null;
}

function usesDynamicClassProperty(member: MemberExpression): boolean {
  const className = classNameForExpression(member.object);
  return Boolean(className && activeClassStatements.has(className) && !isClassStoredPropertyMember(member));
}

function declaredCallResultType(call: CallExpression): string | null {
  if (call.callee.kind === NodeKind.Identifier) {
    const functionStatement = activeFunctionStatements.get((call.callee as Identifier).name);
    if (!functionStatement?.returnType) return null;
    return functionStatement.returnType.name;
  }
  if (call.callee.kind !== NodeKind.MemberExpression) return null;
  const member = call.callee as MemberExpression;
  if (member.computed || member.property.kind !== NodeKind.Identifier) return null;
  const receiverTypeName = declaredTypeNameForExpression(member.object);
  if (!receiverTypeName) return null;
  const receiverShape = parseTypeNameShape(receiverTypeName);
  const canonicalReceiverName = canonicalNativeObjectName(receiverTypeName) ?? receiverShape.baseName;
  const statement = activeClassStatements.get(canonicalReceiverName) ?? activeInterfaceStatements.get(canonicalReceiverName);
  if (!statement) return null;
  let method: ClassMethodMember | InterfaceMethodMember | null;
  if (statement.kind === NodeKind.ClassStatement) {
    method = classMethodForName(statement, (member.property as Identifier).name);
  } else {
    method = interfaceMethodForName(statement, (member.property as Identifier).name);
  }
  if (!method?.returnType) return null;
  const bindings = new Map<string, string>();
  const typeParameters = statement.typeParameters ?? [];
  for (let index = 0; index < typeParameters.length; index += 1) {
    const parameter = typeParameters[index]!;
    const argument = receiverShape.typeArguments[index] ?? parameter.defaultType?.name;
    if (argument) bindings.set(parameter.name.name, argument);
  }
  return substituteTypeName(method.returnType.name, bindings);
}

function cppTypeForBoundDeclaredName(typeName: string, bindings: ReadonlyMap<string, string>): string | null {
  const direct = bindings.get(typeName);
  if (direct) return cppTypeForDeclaredNameOr(direct, direct);
  const unionMembers = splitTopLevelTypeText(typeName, "|");
  if (unionMembers.length > 1) {
    const presentMembers = unionMembers.filter((member) => {
      const trimmed = member.trim();
      return trimmed !== "undefined" && trimmed !== "null";
    });
    if (presentMembers.length === 1) {
      return cppTypeForBoundDeclaredName(presentMembers[0]!.trim(), bindings);
    }
  }
  const array = splitArraySuffixTypeName(typeName);
  if (array) {
    let result = cppTypeForBoundDeclaredName(array.elementTypeName, bindings);
    if (!result || result === "void") return null;
    for (let depth = 0; depth < array.arrayDepth; depth += 1) {
      result = `vexa::ArrayObject<${result}>*`;
    }
    return result;
  }
  const shape = parseTypeNameShape(typeName);
  if (shape.typeArguments.length === 0) return cppTypeForDeclaredName(typeName);
  const argumentsList = shape.typeArguments.map((argument) =>
    cppTypeForBoundDeclaredName(argument, bindings) ?? "vexa::Value");
  if (isNativeArrayTypeName(shape.baseName)) {
    return `vexa::ArrayObject<${argumentsList[0]}>*`;
  }
  if (isNativeMapTypeName(shape.baseName)) {
    return `vexa::MapObject<${argumentsList[0]}, ${argumentsList[1]}>*`;
  }
  if (isNativeSetTypeName(shape.baseName)) {
    return `vexa::SetObject<${argumentsList[0]}>*`;
  }
  if (shape.baseName === "Promise") return `vexa::Task<${argumentsList[0]}>`;
  if (activeClassNames.has(shape.baseName) || activeInterfaceNames.has(shape.baseName)) {
    return `${cppName(shape.baseName)}<${argumentsList.join(", ")}>*`;
  }
  return cppTypeForDeclaredName(typeName);
}

function inferredFunctionCallCppType(call: CallExpression): string | null {
  if (call.callee.kind !== NodeKind.Identifier) return null;
  const statement = activeFunctionStatements.get((call.callee as Identifier).name);
  if (!statement?.returnType) return null;
  if (!statement.typeParameters?.length) return cppTypeForDeclaredName(statement.returnType.name);
  return cppTypeForBoundDeclaredName(statement.returnType.name, methodTemplateBindings(call, statement));
}

function staticClassNameForExpression(expression: Expr): string | null {
  if (expression.kind !== NodeKind.Identifier) return null;
  const name = (expression as Identifier).name;
  return activeClassNames.has(name) && !activeLocalNames.has(name) ? name : null;
}

function cppPointeeBase(pointee: string): string {
  if (pointee.includes("<")) return pointee.slice(0, pointee.indexOf("<"));
  return pointee;
}

function interfaceStatementForCppType(cppType: string | null): InterfaceStatement | null {
  if (!cppType?.endsWith("*")) return null;
  const pointee = cppType.slice(0, -1);
  const base = cppPointeeBase(pointee);
  return activeInterfaceStatementsByCppBase.get(base) ?? null;
}

function classStatementForCppType(cppType: string | null): ClassStatement | null {
  if (!cppType?.endsWith("*")) return null;
  const pointee = cppType.slice(0, -1);
  const base = cppPointeeBase(pointee);
  return activeClassStatementsByCppBase.get(base) ?? null;
}

function interfaceMemberForName(
  statement: InterfaceStatement,
  memberName: string,
  visited = new Set<string>()
): InterfaceMember | null {
  if (visited.has(statement.name.name)) return null;
  visited.add(statement.name.name);
  const ownMember = statement.members.find((candidate) => candidate.name.name === memberName);
  if (ownMember) return ownMember;
  for (const extendedType of statement.extendsTypes ?? []) {
    const parent = activeInterfaceStatements.get(parseTypeNameShape(extendedType.name).baseName);
    const inheritedMember = parent ? interfaceMemberForName(parent, memberName, visited) : null;
    if (inheritedMember) return inheritedMember;
  }
  return null;
}

function interfaceMethodForName(statement: InterfaceStatement, methodName: string): InterfaceMethodMember | null {
  const member = interfaceMemberForName(statement, methodName);
  return member?.kind === NodeKind.InterfaceMethodMember ? member : null;
}

function interfacePropertyForName(statement: InterfaceStatement, propertyName: string): InterfacePropertyMember | null {
  const member = interfaceMemberForName(statement, propertyName);
  return member?.kind === NodeKind.InterfacePropertyMember ? member : null;
}

function interfacePropertyForMember(member: MemberParts): InterfacePropertyMember | null {
  const mappedObjectType = cppTypeForExpression(member.object);
  const mappedStatement = interfaceStatementForCppType(mappedObjectType) ?? undefined;
  const typeName = mappedStatement ? null : classNameForExpression(member.object);
  const statement = mappedStatement ?? (typeName ? activeInterfaceStatements.get(typeName) : undefined);
  return statement ? interfacePropertyForName(statement, member.propertyName) : null;
}

class NativePropertyMember {
  constructor(
    public kind: "method" | "record" | "dynamic" | "extension",
    public expression: Expr,
    public receiver: Expr,
    public implicitReceiver: boolean,
    public propertyName: string,
    public getterName: string | null,
    public setterName: string | null,
    public valueType: string | null,
    public keyExpression?: Expr
  ) {}
}

function dynamicStructuralCastSource(expression: Expr): Expr | null {
  if (expression.kind !== NodeKind.AsExpression || cppTypeForExpression(expression) !== "vexa::RecordObject*") {
    return null;
  }
  const source = (expression as AsExpression).expression;
  const sourceType = emittedCppTypeForExpression(source);
  return sourceType === "vexa::Value" || Boolean(sourceType && classStatementForCppType(sourceType))
    ? source
    : null;
}

function resolvedNativePropertyMember(expression: Expr): NativePropertyMember | null {
  if (expression.kind === NodeKind.Identifier) {
    const identifier = expression as Identifier;
    const receiverName = activeImplicitReceiverExtensionIdentifiers.get(identifier as Node);
    const declaration = receiverName
      ? activeExtensionProperties.get(`${receiverName}.${identifier.name}`)
      : undefined;
    if (declaration) {
      let getter = Boolean(declaration.initializer);
      let setter = false;
      for (const accessor of declaration.accessors ?? []) {
        if (accessor.accessorKind === "get") getter = true;
        if (accessor.accessorKind === "set") setter = true;
      }
      return new NativePropertyMember(
        "extension",
        expression,
        expression,
        true,
        identifier.name,
        getter ? extensionPropertyCppName(declaration) : null,
        setter ? extensionPropertyCppName(declaration, true) : null,
        declaration.typeAnnotation ? cppTypeForDeclaredName(declaration.typeAnnotation.name) : null
      );
    }
  }
  if (expression.kind === NodeKind.Identifier && activeImplicitReceiverIdentifiers.has(expression as Node)) {
    const propertyName = (expression as Identifier).name;
    const statement = activeCurrentClassStatement ?? (activeCurrentClassName
      ? activeClassStatements.get(activeCurrentClassName)
      : undefined);
    if (!statement || activeCurrentMethodStatic) return null;
    const getter = classGetterForName(statement, propertyName);
    const setter = classSetterForName(statement, propertyName);
    let valueType = currentClassPropertyCppType(propertyName);
    if (!valueType && getter?.returnType) {
      const mapped = cppTypeForDeclaredName(getter.returnType.name);
      if (mapped.length > 0) valueType = mapped;
    }
    if (!valueType && setter?.parameters[0]?.typeAnnotation) {
      const mapped = cppTypeForDeclaredName(setter.parameters[0].typeAnnotation.name);
      if (mapped.length > 0) valueType = mapped;
    }
    return getter || setter
      ? new NativePropertyMember(
          "method",
          expression,
          expression,
          true,
          propertyName,
          getter ? cppName(propertyName) : null,
          setter ? cppName(propertyName) : null,
          valueType
        )
      : null;
  }
  if (expression.kind !== NodeKind.MemberExpression) return null;
  const member = expression as MemberExpression;
  const extensionResolution = activeExtensionPropertyResolutions.get(member as Node);
  if (extensionResolution) {
    const declaration = extensionResolution.declaration;
    let getter = Boolean(declaration.initializer);
    let setter = false;
    for (const accessor of declaration.accessors ?? []) {
      if (accessor.accessorKind === "get") getter = true;
      if (accessor.accessorKind === "set") setter = true;
    }
    return new NativePropertyMember(
      "extension",
      expression,
      member.object,
      false,
      (declaration.name as Identifier).name,
      getter ? extensionPropertyCppName(declaration) : null,
      setter ? extensionPropertyCppName(declaration, true) : null,
      declaration.typeAnnotation ? cppTypeForDeclaredName(declaration.typeAnnotation.name) : null
    );
  }
  const propertyName = !member.computed ? identifierName(member.property) : null;
  if (propertyName) {
    for (const receiverName of extensionReceiverNamesForExpression(member.object)) {
      const declaration = activeExtensionProperties.get(`${receiverName}.${propertyName}`);
      if (!declaration) continue;
      let getter = Boolean(declaration.initializer);
      let setter = false;
      for (const accessor of declaration.accessors ?? []) {
        if (accessor.accessorKind === "get") getter = true;
        if (accessor.accessorKind === "set") setter = true;
      }
      return new NativePropertyMember(
        "extension",
        expression,
        member.object,
        false,
        propertyName,
        getter ? extensionPropertyCppName(declaration) : null,
        setter ? extensionPropertyCppName(declaration, true) : null,
        declaration.typeAnnotation ? cppTypeForDeclaredName(declaration.typeAnnotation.name) : null
      );
    }
  }
  const structuralSource = dynamicStructuralCastSource(member.object);
  if (structuralSource) {
    if (!member.computed && !propertyName) return null;
    const resolvedPropertyName: string = propertyName ?? "<computed>";
    return new NativePropertyMember(
      "dynamic",
      expression,
      structuralSource,
      false,
      resolvedPropertyName,
      resolvedPropertyName,
      resolvedPropertyName,
      null,
      member.computed ? member.property : undefined
    );
  }
  if (emittedCppTypeForExpression(member.object) === "vexa::Value") {
    if (!member.computed && !propertyName) return null;
    const resolvedPropertyName: string = propertyName ?? "<computed>";
    return new NativePropertyMember(
      "dynamic",
      expression,
      member.object,
      false,
      resolvedPropertyName,
      resolvedPropertyName,
      resolvedPropertyName,
      null,
      member.computed ? member.property : undefined
    );
  }
  if (activeExpressionTypes.get(member.object as Node)?.kind === AnalysisTypeKind.Object ||
    cppTypeForExpression(member.object) === "vexa::RecordObject*" ||
    emittedCppTypeForExpression(member.object) === "vexa::RecordObject*") {
    if (!member.computed && !propertyName) return null;
    const resolvedPropertyName: string = propertyName ?? "<computed>";
    return new NativePropertyMember(
      "record",
      expression,
      member.object,
      false,
      resolvedPropertyName,
      resolvedPropertyName,
      resolvedPropertyName,
      declaredTypeNameForExpression(expression)
        ? cppTypeForDeclaredName(declaredTypeNameForExpression(expression)!)
        : null,
      member.computed ? member.property : undefined
    );
  }
  if (!propertyName) return null;
  const interfaceProperty = interfacePropertyForMember(createMemberParts(member.object, propertyName));
  if (interfaceProperty) {
    return new NativePropertyMember(
      "method",
      expression,
      member.object,
      false,
      propertyName,
      interfacePropertyGetterName(propertyName),
      isMutableInterfaceProperty(interfaceProperty)
        ? interfacePropertySetterName(propertyName)
        : null,
      interfacePropertyCppType(interfaceProperty)
    );
  }
  const className = classNameForExpression(member.object);
  const statement = className ? activeClassStatements.get(className) : undefined;
  if (!statement) return null;
  const getter = classGetterForName(statement, propertyName);
  const setter = classSetterForName(statement, propertyName);
  const storedType = classStoredPropertyInfo(statement, propertyName)?.valueType ?? null;
  let valueType = storedType;
  if (!valueType && getter?.returnType) {
    const mapped = cppTypeForDeclaredName(getter.returnType.name);
    if (mapped.length > 0) valueType = mapped;
  }
  if (!valueType && setter?.parameters[0]?.typeAnnotation) {
    const mapped = cppTypeForDeclaredName(setter.parameters[0].typeAnnotation.name);
    if (mapped.length > 0) valueType = mapped;
  }
  return getter || setter
    ? new NativePropertyMember(
        "method",
        expression,
        member.object,
        false,
        propertyName,
        getter ? cppName(propertyName) : null,
        setter ? cppName(propertyName) : null,
        valueType
      )
    : null;
}

function emitNativePropertyKey(property: NativePropertyMember): string {
  return property.keyExpression
    ? `vexa::propertyKey(${emitExpression(property.keyExpression)})`
    : cppUtf16String(property.propertyName);
}

function emitNativePropertyGet(
  property: NativePropertyMember,
  receiver: string,
  key?: string
): string {
  if (property.kind === "record") {
    const declaredResult = declaredTypeNameForExpression(property.expression);
    const mappedResult = declaredResult ? cppTypeForDeclaredName(declaredResult) : "";
    const resultType = mappedResult.length > 0
      ? mappedResult
      : cppTypeForExpression(property.expression);
    return `vexa::recordGet<${resultType === "auto" ? "vexa::Value" : resultType}>(${activeRuntimeName}, ${receiver}, ${key ?? emitNativePropertyKey(property)})`;
  }
  if (property.kind === "dynamic") {
    const helper = property.keyExpression ? "dynamicIndexGet" : "dynamicGet";
    return `vexa::${helper}(${receiver}, ${key ?? emitNativePropertyKey(property)})`;
  }
  if (property.kind === "extension") {
    return `${property.getterName}(${receiver})`;
  }
  return `${receiver}->${property.getterName}()`;
}

function emitNativePropertySet(
  property: NativePropertyMember,
  receiver: string,
  value: string,
  key?: string
): string {
  if (property.kind === "record") {
    return `vexa::recordSet(${activeRuntimeName}, ${receiver}, ${key ?? emitNativePropertyKey(property)}, ${value})`;
  }
  if (property.kind === "dynamic") {
    const helper = property.keyExpression ? "dynamicIndexSet" : "dynamicSet";
    return `vexa::${helper}(${receiver}, ${key ?? emitNativePropertyKey(property)}, vexa::convertValue<vexa::Value>(${value}))`;
  }
  if (property.kind === "extension") {
    const converted = property.valueType && property.valueType !== "vexa::Value"
      ? `vexa::convertValue<${property.valueType}>(${value})`
      : value;
    return `${property.setterName}(${receiver}, ${converted})`;
  }
  const converted = property.valueType && property.valueType !== "vexa::Value"
    ? `vexa::convertValue<${property.valueType}>(${value})`
    : value;
  return `${receiver}->${property.setterName}(${converted})`;
}

function emitNativePropertyReceiverDeclaration(property: NativePropertyMember, receiver: string): string {
  return property.kind === "extension" || property.kind === "dynamic"
    ? `auto __vexa_property_receiver = ${receiver};`
    : `auto* __vexa_property_receiver = vexa::rawPointer(${receiver});`;
}

function emitExpressionWithExpectedCppType(expression: Expr, expectedCppType: string): string {
  const previous = activeExpectedExpressionCppType;
  activeExpectedExpressionCppType = expectedCppType;
  try {
    if (expectedCppType.endsWith("*") &&
        (expression.kind === NodeKind.UndefinedLiteral || expression.kind === NodeKind.NullLiteral)) {
      return "nullptr";
    }
    const emitted = emitExpression(expression);
    if (builtinCallCppType(expression) === expectedCppType) return emitted;
    const actual = emittedCppTypeForExpression(expression);
    if (managedArrayElementType(expectedCppType) !== null &&
      managedArrayElementType(actual ?? "") !== null &&
      (expression.kind === NodeKind.CallExpression || expression.kind === NodeKind.ArrayLiteral)) {
      return emitted;
    }
    if ((expression.kind === NodeKind.CallExpression || expression.kind === NodeKind.NewExpression) &&
        ["vexa::MapObject<", "vexa::SetObject<", "vexa::WeakMapObject<", "vexa::WeakSetObject<"]
          .some((prefix) => expectedCppType.startsWith(prefix))) {
      return emitted;
    }
    if (expectedCppType === "vexa::Value" && isStringExpression(expression)) {
      return emitConvertedValue(expression, expectedCppType);
    }
    return actual && actual !== expectedCppType
      ? emitConvertedValue(expression, expectedCppType)
      : emitted;
  } finally {
    activeExpectedExpressionCppType = previous;
  }
}

function emitPropertyAssignment(
  assignment: AssignmentExpression,
  property: NativePropertyMember,
  resultUsed = true
): string {
  if (!property.setterName) {
    throw new CppEmitError(`C++ cannot assign to read-only property '${property.propertyName}'`);
  }
  const receiver = property.implicitReceiver ? activeThisExpression : emitExpression(property.receiver);
  const keyDeclaration = (property.kind === "record" || property.kind === "dynamic") && property.keyExpression
    ? ` auto __vexa_property_key = ${emitNativePropertyKey(property)};`
    : "";
  const key = (property.kind === "record" || property.kind === "dynamic") && property.keyExpression
    ? "__vexa_property_key"
    : undefined;
  if (assignment.operator === "=") {
    const interfaceProperty = !property.implicitReceiver
      ? interfacePropertyForMember(createMemberParts(property.receiver, property.propertyName))
      : null;
    const expectedType = interfaceProperty ? interfacePropertyCppType(interfaceProperty) : null;
    const assignedValue = expectedType
      ? emitExpressionWithExpectedCppType(assignment.right, expectedType)
      : (property.kind === "dynamic" || property.kind === "record") &&
          (activeExpressionTypes.get(assignment.right as Node)?.kind === AnalysisTypeKind.Function ||
            assignment.right.kind === NodeKind.ArrowFunctionExpression ||
            assignment.right.kind === NodeKind.FunctionExpression)
        ? emitConvertedValue(assignment.right, "vexa::Value")
        : emitExpression(assignment.right);
    const body = `${emitNativePropertyReceiverDeclaration(property, receiver)}${keyDeclaration} auto __vexa_property_value = ${assignedValue}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)};`;
    return resultUsed
      ? `([&]() { ${body} return __vexa_property_value; }())`
      : `{ ${body} }`;
  }
  const binaryOperator = compoundAssignmentBinaryOperator(assignment.operator);
  if (!binaryOperator || !new Set(["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"]).has(binaryOperator)) {
    throw new CppEmitError(`C++ properties do not support '${assignment.operator}' assignment yet`);
  }
  if (!property.getterName) {
    throw new CppEmitError(`C++ cannot apply '${assignment.operator}' to write-only property '${property.propertyName}'`);
  }
  const mappedPropertyType = cppTypeForExpression(property.expression);
  const propertyType = property.kind === "record" && mappedPropertyType === "auto"
    ? "vexa::Value"
    : mappedPropertyType;
  const value = !activeHasExpressionTypes || property.kind === "dynamic" || property.kind === "record" ||
    propertyType === "vexa::Value"
    ? emitDynamicBinaryText(binaryOperator, "__vexa_property_current", "__vexa_property_operand") ??
      `(__vexa_property_current ${binaryOperator} __vexa_property_operand)`
    : `(__vexa_property_current ${binaryOperator} __vexa_property_operand)`;
  const body = `${emitNativePropertyReceiverDeclaration(property, receiver)}${keyDeclaration} auto __vexa_property_current = ${emitNativePropertyGet(property, "__vexa_property_receiver", key)}; auto __vexa_property_operand = ${emitExpression(assignment.right)}; auto __vexa_property_value = ${value}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)};`;
  return resultUsed
    ? `([&]() { ${body} return __vexa_property_value; }())`
    : `{ ${body} }`;
}

function emitPropertyUpdate(
  update: UpdateExpression,
  property: NativePropertyMember,
  resultUsed = true
): string {
  if (!property.setterName) {
    throw new CppEmitError(`C++ cannot update read-only property '${property.propertyName}'`);
  }
  if (!property.getterName) {
    throw new CppEmitError(`C++ cannot update write-only property '${property.propertyName}'`);
  }
  const delta = update.operator === "++" ? "+" : "-";
  const returned = update.prefix ? "__vexa_property_value" : "__vexa_property_current";
  const receiver = property.implicitReceiver ? activeThisExpression : emitExpression(property.receiver);
  const keyDeclaration = (property.kind === "record" || property.kind === "dynamic") && property.keyExpression
    ? ` auto __vexa_property_key = ${emitNativePropertyKey(property)};`
    : "";
  const key = (property.kind === "record" || property.kind === "dynamic") && property.keyExpression
    ? "__vexa_property_key"
    : undefined;
  const mappedPropertyType = cppTypeForExpression(property.expression);
  const propertyType = property.kind === "record" && mappedPropertyType === "auto"
    ? "vexa::Value"
    : mappedPropertyType;
  const updated = !activeHasExpressionTypes || property.kind === "dynamic" || property.kind === "record" ||
    propertyType === "vexa::Value"
    ? emitDynamicBinaryText(delta, "__vexa_property_current", "1") ?? `(__vexa_property_current ${delta} 1)`
    : `(__vexa_property_current ${delta} 1)`;
  const body = `${emitNativePropertyReceiverDeclaration(property, receiver)}${keyDeclaration} auto __vexa_property_current = ${emitNativePropertyGet(property, "__vexa_property_receiver", key)}; auto __vexa_property_value = ${updated}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)};`;
  return resultUsed
    ? `([&]() { ${body} return ${returned}; }())`
    : `{ ${body} }`;
}

function classMethodForMember(
  member: MemberParts
): CallableMember | null {
  if (member.object.kind === NodeKind.Identifier &&
      (member.object as Identifier).name === "this" &&
      activeCurrentClassStatement) {
    const method = classMethodForName(activeCurrentClassStatement, member.propertyName);
    if (method) return method;
  }
  const objectType = cppTypeForExpression(member.object);
  const mappedClass = classStatementForCppType(objectType);
  if (mappedClass) {
    const method = classMethodForName(mappedClass, member.propertyName);
    if (method) return method;
  }
  const mappedInterface = interfaceStatementForCppType(objectType);
  if (mappedInterface) {
    const method = interfaceMethodForName(mappedInterface, member.propertyName);
    if (method) return method;
  }
  const staticClassName = staticClassNameForExpression(member.object);
  if (!staticClassName && !objectType.endsWith("*")) return null;
  const className = staticClassName ?? classNameForExpression(member.object);
  if (!className) return null;
  const classStatement = activeClassStatements.get(className);
  const classMethod = classStatement ? classMethodForName(classStatement, member.propertyName) : null;
  if (classMethod) return classMethod;
  const interfaceStatement = activeInterfaceStatements.get(className);
  return interfaceStatement ? interfaceMethodForName(interfaceStatement, member.propertyName) : null;
}

function emitBoundMethodValue(
  member: MemberParts,
  method: CallableMember
): string {
  const receiverType = cppTypeForExpression(member.object);
  if (!receiverType.endsWith("*")) {
    throw new CppEmitError(`C++ cannot bind method '${member.propertyName}' on a non-object receiver`);
  }
  const parameters = method.parameters.filter((parameter) => !parameter.thisParameter);
  const lambdaParameters = parameters.map((_, index) => `auto&& __vexa_bound_argument_${index}`);
  const callArguments = parameters.map((parameter, index) => {
    const parameterType = cppTypeForCallableParameter(parameter, false) ?? "vexa::Value";
    return `vexa::convertValue<${parameterType}>(__vexa_bound_argument_${index})`;
  });
  const receiver = `cppgc::Persistent<${receiverType.slice(0, -1)}>(vexa::rawPointer(${emitExpression(member.object)}))`;
  return `[__vexa_bound_receiver = ${receiver}](${lambdaParameters.join(", ")}) mutable { return __vexa_bound_receiver->${cppName(member.propertyName)}(${withRuntimeArgument(callArguments.join(", "))}); }`;
}

function classMethodForName(
  statement: ClassStatement,
  methodName: string
): ClassMethodMember | null {
  const cacheKey = `${statement.name.name}\u0000${methodName}`;
  if (activeClassMethodCache.has(cacheKey)) return activeClassMethodCache.get(cacheKey)!;
  const visited = new Set<string>();
  let current: ClassStatement | undefined = statement;
  while (current && !visited.has(current.name.name)) {
    visited.add(current.name.name);
    const own = current.members.find((candidate): candidate is ClassMethodMember =>
      candidate.kind === NodeKind.ClassMethodMember && candidate.name.name === methodName);
    if (own) {
      activeClassMethodCache.set(cacheKey, own);
      return own;
    }
    current = current.extendsType
      ? activeClassStatements.get(parseTypeNameShape(current.extendsType.name).baseName)
      : undefined;
  }
  activeClassMethodCache.set(cacheKey, null);
  return null;
}

function inheritedClassMethodForName(statement: ClassStatement, methodName: string): ClassMethodMember | null {
  const parent = statement.extendsType
    ? activeClassStatements.get(parseTypeNameShape(statement.extendsType.name).baseName)
    : undefined;
  return parent ? classMethodForName(parent, methodName) : null;
}

function classGetterForName(
  statement: ClassStatement,
  propertyName: string
): ClassMethodMember | null {
  const cacheKey = `${statement.name.name}\u0000${propertyName}`;
  if (activeClassGetterCache.has(cacheKey)) return activeClassGetterCache.get(cacheKey)!;
  const result = statement.members.find((member): member is ClassMethodMember =>
    member.kind === NodeKind.ClassMethodMember &&
    member.name.name === propertyName &&
    (member.getterShorthand === true || member.accessorKind === "get")) ?? null;
  activeClassGetterCache.set(cacheKey, result);
  return result;
}

function classSetterForName(
  statement: ClassStatement,
  propertyName: string
): ClassMethodMember | null {
  const cacheKey = `${statement.name.name}\u0000${propertyName}`;
  if (activeClassSetterCache.has(cacheKey)) return activeClassSetterCache.get(cacheKey)!;
  const result = statement.members.find((member): member is ClassMethodMember =>
    member.kind === NodeKind.ClassMethodMember &&
    member.name.name === propertyName &&
    member.accessorKind === "set") ?? null;
  activeClassSetterCache.set(cacheKey, result);
  return result;
}

function classGetterForMember(
  member: MemberParts
): ClassMethodMember | null {
  const mapped = classStatementForCppType(cppTypeForExpression(member.object));
  const className = mapped ? null : classNameForExpression(member.object);
  const statement = mapped ?? (className ? activeClassStatements.get(className) : undefined);
  return statement ? classGetterForName(statement, member.propertyName) : null;
}

function classUsesRuntimeConstructor(statement: ClassStatement | undefined): boolean {
  if (!statement) return false;
  if (statement.members.some((member) => member.kind === NodeKind.ClassFieldMember && !member.isStatic)) return true;
  return classConstructorMethod(statement) !== null;
}

function classConstructorMethod(statement: ClassStatement | undefined): ClassMethodMember | null {
  if (!statement) return null;
  return statement.members.find((member): member is ClassMethodMember =>
    member.kind === NodeKind.ClassMethodMember && member.name.name === "constructor") ?? null;
}

function classConstructorParameters(statement: ClassStatement | undefined): readonly CallableParameter[] | undefined {
  const constructor = classConstructorMethod(statement);
  if (constructor) return constructor.parameters;
  return statement ? statement.primaryConstructorParameters : undefined;
}

function classRequiresConstructorArguments(statement: ClassStatement | undefined): boolean {
  const parameters = classConstructorParameters(statement);
  return Boolean(parameters && parameters.length > 0);
}

function nativeConstructorParameters(sourceParameters: string): string {
  return sourceParameters;
}

function nativeLambdaCapture(
  selfName: string,
  referenceEntryLocals: boolean,
  captureNames?: ReadonlySet<string>
): {
  text: string;
  thisExpression: string;
} {
  if (!activeFunctionObjectCapture && referenceEntryLocals && activeRuntimeName === "runtime") {
    return { text: "[&]", thisExpression: activeThisExpression };
  }
  const captures = ["="];
  for (const [sourceName, className] of activeGcObjectTypes) {
    if (activeSharedBindingNames.has(sourceName)) continue;
    if (captureNames && !captureNames.has(sourceName)) continue;
    if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
    const name = cppName(sourceName);
    const localType = activeLocalCppTypes.get(sourceName);
    if (localType && managedArrayElementType(localType) !== null) {
      captures.push(activeFunctionObjectCapture
        ? `${name} = vexa::arrayPointer(${name})`
        : `${name} = cppgc::Persistent<${localType.slice(0, -1)}>(vexa::arrayPointer(${name}))`);
      continue;
    }
    if (activeGcArrayTypes.has(sourceName)) continue;
    captures.push(activeFunctionObjectCapture
      ? `${name} = vexa::rawPointer(${name})`
      : `${name} = cppgc::Persistent<${cppName(className)}>(${name})`);
  }
  for (const [sourceName, pointeeType] of activeGcArrayTypes) {
    if (activeSharedBindingNames.has(sourceName)) continue;
    if (captureNames && !captureNames.has(sourceName)) continue;
    if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
    const name = cppName(sourceName);
    const localType = activeLocalCppTypes.get(sourceName);
    if (activeGcObjectTypes.has(sourceName) && localType && managedArrayElementType(localType) !== null) continue;
    let arrayPointeeType: string = pointeeType;
    if (localType && managedArrayElementType(localType) !== null) {
      arrayPointeeType = localType.slice(0, -1);
    }
    captures.push(activeFunctionObjectCapture
      ? `${name} = vexa::arrayPointer(${name})`
      : `${name} = cppgc::Persistent<${arrayPointeeType}>(vexa::arrayPointer(${name}))`);
  }
  for (const [sourceName, type] of activeLocalCppTypes) {
    if (!type.endsWith("*") || activeGcObjectTypes.has(sourceName) || activeGcArrayTypes.has(sourceName)) continue;
    if (activeSharedBindingNames.has(sourceName)) continue;
    if (captureNames && !captureNames.has(sourceName)) continue;
    if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
    const name = cppName(sourceName);
    const pointeeType = type.slice(0, -1);
    captures.push(activeFunctionObjectCapture
      ? `${name} = vexa::rawPointer(${name})`
      : `${name} = cppgc::Persistent<${pointeeType}>(vexa::rawPointer(${name}))`);
  }
  if (activeFunctionObjectCapture) {
    for (const sourceName of activeDynamicValueNames) {
      if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
      const name = cppName(sourceName);
      captures.push(`${name} = vexa::StoredValue(${name})`);
    }
  }
  const rootThis = activeThisExpression === "this" && activeCurrentClassName !== null && !activeCurrentMethodStatic &&
    (!captureNames || captureNames.has("this")) &&
    (!activeFunctionObjectCaptureNames || activeFunctionObjectCaptureNames.has("this"));
  if (rootThis) {
    captures.push(activeFunctionObjectCapture
      ? `${selfName} = this`
      : `${selfName} = cppgc::Persistent<${cppName(activeCurrentClassName!)}>(this)`);
  }
  if (activeRuntimeName === "runtime") captures.push("&runtime");
  return {
    text: `[${captures.join(", ")}]`,
    thisExpression: rootThis ? selfName : activeThisExpression,
  };
}

function callableExpressionBody(expression: CallableExpression): Node {
  if (expression.kind === NodeKind.ArrowFunctionExpression) {
    return (expression as ArrowFunctionExpression).body as Node;
  }
  return (expression as FunctionExpression).body;
}

function nativeFunctionCaptureNames(expression: Expr): ReadonlySet<string> {
  if (expression.kind !== NodeKind.ArrowFunctionExpression && expression.kind !== NodeKind.FunctionExpression) return new Set();
  const cached = activeNativeFunctionCaptureNamesCache.get(expression as Node);
  if (cached) return cached;
  const callable = expression as CallableExpression;
  const declared = new Set<string>();
  for (const parameter of callable.parameters) {
    if ((parameter.name as Node).kind === NodeKind.Identifier) {
      const identifier = parameter.name as Identifier;
      declared.add(identifier.name);
    } else {
      for (const rawName of bindingIdentifiers(parameter.name)) {
        const name = rawName as Identifier;
        declared.add(name.name);
      }
    }
  }
  const used = new Set<string>();
  const pending: Node[] = [callableExpressionBody(callable)];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === NodeKind.VarStatement) {
      const variable = node as VarStatement;
      for (const rawName of bindingIdentifiers(variable.declarations?.[0]?.name ?? variable.name)) {
        const name = rawName as Identifier;
        declared.add(name.name);
      }
    }
    if (node.kind === NodeKind.Identifier) {
      const identifier = node as Identifier;
      used.add(identifier.name);
      if (identifier.name === "this" && identifier.receiverLabel) {
        const labeledReceiver = activeReceiverLabels.get(identifier.receiverLabel);
        if (labeledReceiver) used.add(labeledReceiver);
      }
      if (activeImplicitReceiverIdentifiers.has(node)) used.add("this");
    }
    for (const child of childNodes(node)) pending.push(child);
  }
  for (const name of declared) used.delete(name);
  activeNativeFunctionCaptureNamesCache.set(expression as Node, used);
  return used;
}

function nestedClosureCaptureNames(root: Node): ReadonlySet<string> {
  const cached = activeNestedClosureCaptureNamesCache.get(root);
  if (cached) return cached;
  const captures = new Set<string>();
  const pending: Node[] = [...childNodes(root)];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === NodeKind.ArrowFunctionExpression || node.kind === NodeKind.FunctionExpression) {
      for (const name of nativeFunctionCaptureNames(node as Expr)) captures.add(name);
    }
    for (const child of childNodes(node)) pending.push(child);
  }
  activeNestedClosureCaptureNamesCache.set(root, captures);
  return captures;
}

function nativeLambdaRootValues(captureNames: ReadonlySet<string>): string[] {
  const roots: string[] = [];
  for (const sourceName of activeGcObjectTypes.keys()) {
    if (captureNames.has(sourceName) && !activeGcArrayTypes.has(sourceName)) {
      roots.push(`vexa::convertValue<vexa::Value>(vexa::rawPointer(${cppName(sourceName)}))`);
    }
  }
  for (const sourceName of activeGcArrayTypes.keys()) {
    if (captureNames.has(sourceName)) {
      roots.push(`vexa::convertValue<vexa::Value>(vexa::arrayPointer(${cppName(sourceName)}))`);
    }
  }
  for (const sourceName of activeDynamicValueNames) {
    if (captureNames.has(sourceName)) {
      roots.push(`vexa::convertValue<vexa::Value>(${cppName(sourceName)})`);
    }
  }
  for (const [sourceName, type] of activeLocalCppTypes) {
    if (!type.endsWith("*") || activeGcObjectTypes.has(sourceName) || activeGcArrayTypes.has(sourceName)) continue;
    if (captureNames.has(sourceName)) {
      roots.push(`vexa::convertValue<vexa::Value>(vexa::rawPointer(${cppName(sourceName)}))`);
    }
  }
  if (activeCurrentClassName !== null && !activeCurrentMethodStatic && captureNames.has("this")) {
    roots.push(`vexa::convertValue<vexa::Value>(this)`);
  }
  return roots;
}

function emitNativeLambda(
  expression: ArrowFunctionExpression | FunctionExpression,
  parametersList: readonly FunctionParameter[],
  body: Expr | BlockStatement
): string {
  const receiverInfo = activeReceiverLambdas.get(expression as Node);
  const receiverParameterName = receiverInfo
    ? `__vexa_receiver_${cppName(receiverInfo.label)}_${activeReceiverSymbolCounter++}`
    : null;
  const receiverParameter = receiverParameterName
    ? new FunctionParameter(new Identifier(receiverParameterName))
    : null;
  const valueParameters = receiverInfo?.implicitReceiverAlias ? parametersList.slice(1) : parametersList;
  const effectiveParameters = receiverParameter
    ? [receiverParameter, ...valueParameters]
    : parametersList;
  const capture = nativeLambdaCapture("__vexa_callback_self", true, nativeFunctionCaptureNames(expression));
  const parameters = callableParameters(effectiveParameters, undefined, false, true);
  const expectedLambdaResult = activeExpectedLambdaResultCppType;
  const expectedLambdaParameters = activeExpectedLambdaParameterCppTypes;
  const expectedLambdaExpression = activeExpectedExpressionCppType;
  const expectedResultType = expectedLambdaResult ??
    (expectedLambdaExpression ? managedArrayElementType(expectedLambdaExpression) : null);
  const previousLocalNames = activeLocalNames;
  const previousLocalCppTypes = activeLocalCppTypes;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousGcArrayTypes = activeGcArrayTypes;
  const previousDynamicValueNames = activeDynamicValueNames;
  const previousSharedBindingNames = activeSharedBindingNames;
  const previousSharedBindingCandidates = activeSharedBindingCandidates;
  const previousThisExpression = activeThisExpression;
  const previousReceiverLabels = activeReceiverLabels;
  const previousCurrentClassName = activeCurrentClassName;
  const previousCurrentClassStatement = activeCurrentClassStatement;
  const previousCurrentMethodStatic = activeCurrentMethodStatic;
  const previousCallableResultType = activeCallableResultType;
  const previousCallableUsesReturnSignal = activeCallableUsesReturnSignal;
  const previousFinallyProtectedDepth = activeFinallyProtectedDepth;
  const previousBreakBoundaries = activeBreakBoundaries;
  const previousContinueBoundaries = activeContinueBoundaries;
  activeLocalNames = copyStringSetWithValues(activeLocalNames, parameters.names);
  activeLocalCppTypes = new Map(activeLocalCppTypes);
  activeGcObjectTypes = new Map([...activeGcObjectTypes, ...parameters.gcTypes]);
  activeGcArrayTypes = new Map([...activeGcArrayTypes, ...parameters.gcArrayTypes]);
  activeDynamicValueNames = new Set([...activeDynamicValueNames, ...parameters.dynamicNames]);
  activeSharedBindingNames = new Set(activeSharedBindingNames);
  activeSharedBindingCandidates = new Set([
    ...activeSharedBindingCandidates,
    ...nestedClosureCaptureNames(callableExpressionBody(expression)),
  ]);
  for (const name of parameters.names) activeSharedBindingNames.delete(name);
  effectiveParameters.forEach((parameter, index) => {
    if (parameter.name.kind !== NodeKind.Identifier) return;
    const expected = expectedLambdaParameters?.[index];
    if (expected) {
      activeLocalCppTypes.set(parameter.name.name, expected);
      if (expected === "vexa::Value") activeDynamicValueNames.add(parameter.name.name);
    }
  });
  activeThisExpression = receiverParameterName !== null ? receiverParameterName : capture.thisExpression;
  let labeledReceiverName: string | null = null;
  const implicitReceiverAlias = receiverInfo?.implicitReceiverAlias === true &&
    parametersList[0]?.name.kind === NodeKind.Identifier
    ? (parametersList[0]!.name as Identifier).name
    : null;
  if (receiverInfo && receiverParameterName) {
    labeledReceiverName = `__vexa_labeled_receiver_${cppName(receiverInfo.label)}_${activeReceiverSymbolCounter++}`;
    activeReceiverLabels = new Map(previousReceiverLabels).set(receiverInfo.label, labeledReceiverName);
    const receiverCppType = cppTypeForAnalysisType(receiverInfo.receiverType) ?? "vexa::Value";
    activeLocalNames.add(labeledReceiverName);
    activeLocalCppTypes.set(labeledReceiverName, receiverCppType);
    if (receiverCppType.endsWith("*") && receiverInfo.receiverType.kind === AnalysisTypeKind.Named) {
      activeGcObjectTypes.set(labeledReceiverName, receiverInfo.receiverType.name);
    }
    if (receiverInfo.receiverType.kind === AnalysisTypeKind.Named) {
      activeCurrentClassName = receiverInfo.receiverType.name;
      activeCurrentClassStatement = activeClassStatements.get(receiverInfo.receiverType.name) ?? null;
      activeCurrentMethodStatic = false;
    }
    if (implicitReceiverAlias) {
      activeLocalNames.add(implicitReceiverAlias);
      activeLocalCppTypes.set(implicitReceiverAlias, receiverCppType);
      if (receiverCppType.endsWith("*") && receiverInfo.receiverType.kind === AnalysisTypeKind.Named) {
        activeGcObjectTypes.set(implicitReceiverAlias, receiverInfo.receiverType.name);
      }
    }
  }
  activeCallableResultType = expectedResultType;
  activeCallableUsesReturnSignal = false;
  activeFinallyProtectedDepth = 0;
  activeBreakBoundaries = [];
  activeContinueBoundaries = [];
  activeExpectedLambdaResultCppType = null;
  activeExpectedLambdaParameterCppTypes = null;
  activeExpectedExpressionCppType = null;
  clearExpressionTypeCaches();
  try {
    const prefix = `${capture.text}(${parameters.text})${activeRuntimeName === "runtime" ? "" : " mutable"}${expectedResultType ? ` -> ${expectedResultType}` : ""}`;
    const receiverPreamble = labeledReceiverName && receiverParameterName
      ? [`  auto ${labeledReceiverName} = ${receiverParameterName};`]
      : [];
    if (implicitReceiverAlias && receiverParameterName) {
      receiverPreamble.push(`  auto ${cppName(implicitReceiverAlias)} = ${receiverParameterName};`);
    }
    const destructuringPreamble = emitParameterDestructuring(parameters, "  ");
    const preamble = [...receiverPreamble, ...destructuringPreamble];
    const rawBody = body.kind === NodeKind.BlockStatement
      ? emitBlock(
          body as BlockStatement,
          "",
          expectedResultType && expectedResultType !== "void"
            ? `return vexa::defaultValue<${expectedResultType}>();`
            : undefined
        )
      : expectedResultType === "void"
        ? `{ ${emitExpression(body as Expr)}; }`
      : `{ return ${expectedResultType
        ? emitExpressionWithExpectedCppType(body as Expr, expectedResultType)
        : emitExpression(body as Expr)}; }`;
    const emittedBody = expectedResultType
      ? emitCallableReturnBoundary(rawBody, "", expectedResultType, false)
      : rawBody;
    return `${prefix} ${injectBlockPreamble(emittedBody, preamble)}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeLocalCppTypes = previousLocalCppTypes;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeSharedBindingNames = previousSharedBindingNames;
    activeSharedBindingCandidates = previousSharedBindingCandidates;
    activeThisExpression = previousThisExpression;
    activeReceiverLabels = previousReceiverLabels;
    activeCurrentClassName = previousCurrentClassName;
    activeCurrentClassStatement = previousCurrentClassStatement;
    activeCurrentMethodStatic = previousCurrentMethodStatic;
    activeCallableResultType = previousCallableResultType;
    activeCallableUsesReturnSignal = previousCallableUsesReturnSignal;
    activeFinallyProtectedDepth = previousFinallyProtectedDepth;
    activeBreakBoundaries = previousBreakBoundaries;
    activeContinueBoundaries = previousContinueBoundaries;
    activeExpectedLambdaResultCppType = expectedLambdaResult;
    activeExpectedLambdaParameterCppTypes = expectedLambdaParameters;
    activeExpectedExpressionCppType = expectedLambdaExpression;
    clearExpressionTypeCaches();
  }
}

function emitAsyncNativeLambda(
  expression: ArrowFunctionExpression | FunctionExpression,
  parametersList: readonly FunctionParameter[],
  body: Expr | BlockStatement
): string {
  const contextualReturn = activeExpectedLambdaResultCppType ??
    (activeExpectedExpressionCppType ? stdFunctionResultCppType(activeExpectedExpressionCppType) : null);
  let contextualTaskResult = contextualReturn;
  if (contextualTaskResult?.startsWith("vexa::Task<") && contextualTaskResult.endsWith(">")) {
    contextualTaskResult = contextualTaskResult.slice("vexa::Task<".length, -1);
  }
  const functionType = activeExpressionTypes.get(expression as Node);
  const analyzedReturn = functionType?.kind === AnalysisTypeKind.Function ? (functionType as FunctionType).returnType : null;
  const declaredReturn = expression.returnType ? cppTypeForDeclaredName(expression.returnType.name) : "";
  const taskType = declaredReturn.length > 0
    ? declaredReturn
    : analyzedReturn ? cppTypeForAnalysisType(analyzedReturn) : null;
  let resultType = contextualTaskResult ?? "vexa::Value";
  if (!contextualTaskResult && taskType?.startsWith("vexa::Task<") && taskType.endsWith(">")) {
    resultType = taskType.slice("vexa::Task<".length, -1);
  } else if (!contextualTaskResult && analyzedReturn) {
    resultType = cppTypeForAnalysisType(analyzedReturn) ?? "vexa::Value";
  }
  const capture = nativeLambdaCapture(
    "__vexa_async_callback_self",
    true,
    nativeFunctionCaptureNames(expression)
  );
  const parameters = callableParameters(parametersList, undefined, false, true);
  const previousLocalNames = activeLocalNames;
  const previousLocalCppTypes = activeLocalCppTypes;
  const previousCallableParameterPointerTypes = activeCallableParameterPointerTypes;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousGcArrayTypes = activeGcArrayTypes;
  const previousDynamicValueNames = activeDynamicValueNames;
  const previousSharedBindingNames = activeSharedBindingNames;
  const previousSharedBindingCandidates = activeSharedBindingCandidates;
  const previousThisExpression = activeThisExpression;
  const previousAsyncResultType = activeAsyncResultType;
  const previousCallableResultType = activeCallableResultType;
  const previousCallableUsesReturnSignal = activeCallableUsesReturnSignal;
  const previousFinallyProtectedDepth = activeFinallyProtectedDepth;
  const previousBreakBoundaries = activeBreakBoundaries;
  const previousContinueBoundaries = activeContinueBoundaries;
  activeLocalNames = copyStringSetWithValues(activeLocalNames, parameters.names);
  activeLocalCppTypes = new Map(activeLocalCppTypes);
  activeCallableParameterPointerTypes = new Map(parameters.pointerTypes);
  activeGcObjectTypes = new Map([...activeGcObjectTypes, ...parameters.gcTypes]);
  activeGcArrayTypes = new Map([...activeGcArrayTypes, ...parameters.gcArrayTypes]);
  activeDynamicValueNames = new Set([...activeDynamicValueNames, ...parameters.dynamicNames]);
  activeSharedBindingNames = new Set(activeSharedBindingNames);
  activeSharedBindingCandidates = new Set([
    ...activeSharedBindingCandidates,
    ...nestedClosureCaptureNames(callableExpressionBody(expression)),
  ]);
  for (const name of parameters.names) activeSharedBindingNames.delete(name);
  activeThisExpression = capture.thisExpression;
  activeAsyncResultType = resultType;
  activeCallableResultType = resultType;
  activeCallableUsesReturnSignal = false;
  activeFinallyProtectedDepth = 0;
  activeBreakBoundaries = [];
  activeContinueBoundaries = [];
  parametersList.forEach((parameter, index) => {
    if (parameter.name.kind !== NodeKind.Identifier) return;
    const expected = activeExpectedLambdaParameterCppTypes?.[index];
    if (!expected) return;
    activeLocalCppTypes.set(parameter.name.name, expected);
    if (expected === "vexa::Value") activeDynamicValueNames.add(parameter.name.name);
  });
  clearExpressionTypeCaches();
  try {
    const preamble = emitParameterDestructuring(parameters, "  ");
    const rawBody = body.kind === NodeKind.BlockStatement
      ? emitAsyncCallableBlock(body as BlockStatement, "", resultType, false)
      : resultType === "void"
        ? `{ ${emitExpression(body as Expr)}; co_return; }`
        : `{ co_return ${emitAsyncResultValue(body as Expr, resultType)}; }`;
    const emittedBody = emitCallableReturnBoundary(rawBody, "", resultType, true);
    return `${capture.text}(${parameters.text}) mutable -> vexa::Task<${resultType}> ${injectBlockPreamble(emittedBody, preamble)}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeLocalCppTypes = previousLocalCppTypes;
    activeCallableParameterPointerTypes = previousCallableParameterPointerTypes;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeSharedBindingNames = previousSharedBindingNames;
    activeSharedBindingCandidates = previousSharedBindingCandidates;
    activeThisExpression = previousThisExpression;
    activeAsyncResultType = previousAsyncResultType;
    activeCallableResultType = previousCallableResultType;
    activeCallableUsesReturnSignal = previousCallableUsesReturnSignal;
    activeFinallyProtectedDepth = previousFinallyProtectedDepth;
    activeBreakBoundaries = previousBreakBoundaries;
    activeContinueBoundaries = previousContinueBoundaries;
    clearExpressionTypeCaches();
  }
}

function emitArrowFunction(expression: ArrowFunctionExpression): string {
  if (expression.async || expression.sync) {
    return emitAsyncNativeLambda(expression, expression.parameters, expression.body);
  }
  const previousResult = activeExpectedLambdaResultCppType;
  if (expression.returnType) {
    activeExpectedLambdaResultCppType = cppTypeForDeclaredName(expression.returnType.name);
  }
  let result: string;
  try {
    result = emitNativeLambda(expression, expression.parameters, expression.body);
  } finally {
    activeExpectedLambdaResultCppType = previousResult;
  }
  return result;
}

function emitFunctionExpression(expression: FunctionExpression): string {
  if (expression.generator || expression.typeParameters?.length) {
    throw new CppEmitError("C++ emission currently supports non-generic, non-generator function expressions only");
  }
  if (expression.async || expression.sync) {
    return emitAsyncNativeLambda(expression, expression.parameters, expression.body);
  }
  const previousResult = activeExpectedLambdaResultCppType;
  if (expression.returnType) {
    activeExpectedLambdaResultCppType = cppTypeForDeclaredName(expression.returnType.name);
  }
  let result: string;
  try {
    result = emitNativeLambda(expression, expression.parameters, expression.body);
  } finally {
    activeExpectedLambdaResultCppType = previousResult;
  }
  return result;
}

function classConstructionTypeSubstitutions(
  classStatement: ClassStatement,
  argumentsList: readonly Expr[],
  resultExpression?: Expr
): Map<string, string> {
  const typeSubstitutions = new Map<string, string>();
  if (classStatement.typeParameters?.length) {
    const typeArguments = resultExpression?.kind === NodeKind.NewExpression
      ? (resultExpression as NewExpression).typeArguments
      : resultExpression?.kind === NodeKind.CallExpression
        ? (resultExpression as CallExpression).typeArguments
        : undefined;
    for (let index = 0; index < classStatement.typeParameters.length; index += 1) {
      const typeArgument = typeArguments?.[index]?.name ?? classStatement.typeParameters[index]?.defaultType?.name;
      if (typeArgument) typeSubstitutions.set(classStatement.typeParameters[index]!.name.name, typeArgument);
    }
    const parameters = classConstructorParameters(classStatement) ?? [];
    for (let index = 0; index < parameters.length; index += 1) {
      const parameterType = parameters[index]?.typeAnnotation?.name;
      const argument = argumentsList[index];
      if (!parameterType || !argument || typeSubstitutions.has(parameterType)) continue;
      const argumentType = emittedCppTypeForExpression(argument) ?? cppTypeForExpression(argument);
      bindCppTypePattern(
        classStatement.typeParameters,
        typeSubstitutions,
        parameterType,
        argumentType === "auto" ? "vexa::Value" : argumentType
      );
    }
  }
  return typeSubstitutions;
}

function classConstructionCppType(
  classStatement: ClassStatement,
  argumentsList: readonly Expr[],
  resultExpression?: Expr
): string | null {
  if (!classStatement.typeParameters?.length) return `${cppName(classStatement.name.name)}*`;
  const substitutions = classConstructionTypeSubstitutions(classStatement, argumentsList, resultExpression);
  if (!classStatement.typeParameters.every((parameter) => substitutions.has(parameter.name.name))) return null;
  return `${cppName(classStatement.name.name)}<${classStatement.typeParameters.map((parameter) => {
    const binding = substitutions.get(parameter.name.name)!;
    return cppTypeForDeclaredNameOr(binding, binding);
  }).join(", ")}>*`;
}

function emitClassConstruction(
  callee: Expr,
  argumentsList: readonly Expr[],
  resultExpression?: Expr
): string {
  const className = identifierName(callee);
  if (!className || !activeClassNames.has(className)) {
    throw new CppEmitError(
      `C++ explicit construction does not support '${className ?? callee.kind}' yet${activeSourceFilePath ? ` in ${activeSourceFilePath}` : ""}`
    );
  }
  const classStatement = activeClassStatements.get(className)!;
  const typeSubstitutions = classConstructionTypeSubstitutions(classStatement, argumentsList, resultExpression);
  const constructorArguments = emitArguments(
    argumentsList,
    classConstructorParameters(classStatement),
    typeSubstitutions
  );
  const nativeArguments = classUsesRuntimeConstructor(classStatement)
    ? withRuntimeArgument(constructorArguments)
    : constructorArguments;
  const mappedResultType = classConstructionCppType(classStatement, argumentsList, resultExpression);
  let constructedType = cppName(className);
  if (mappedResultType?.endsWith("*")) constructedType = mappedResultType.slice(0, -1);
  return `${activeRuntimeName}.make<${constructedType}>(${nativeArguments})`;
}

function emitTimerCallback(expression: Expr, argumentsList: readonly Expr[]): string {
  const functionName = identifierName(expression);
  const statement = functionName ? activeFunctionStatements.get(functionName) : undefined;
  const orderedArguments = statement
    ? orderedCallArguments(argumentsList, statement.parameters)
    : [...argumentsList];
  const captures = orderedArguments.map((argument, index) =>
    `__vexa_timer_argument_${index} = ${emitExpression(argument)}`);
  if (statement) {
    const capture = [...(activeRuntimeName === "runtime" ? ["&runtime"] : []), ...captures].join(", ");
    const argumentsText = orderedArguments.map((_, index) => `__vexa_timer_argument_${index}`).join(", ");
    return `[${capture}]() mutable { ${cppName(functionName!)}(${argumentsText}); }`;
  }
  const callback = emitExpression(expression);
  const dynamic = cppTypeForExpression(expression) === "vexa::Value";
  const capture = [...(activeRuntimeName === "runtime" ? ["&runtime"] : []), `__vexa_timer_callback = ${callback}`, ...captures].join(", ");
  const argumentsText = orderedArguments.map((_, index) => `__vexa_timer_argument_${index}`);
  const invocation = dynamic
    ? `vexa::call(${activeRuntimeName}, __vexa_timer_callback, {${argumentsText.map((argument) =>
        `vexa::convertValue<vexa::Value>(${argument})`).join(", ")}})`
    : `__vexa_timer_callback(${argumentsText.join(", ")})`;
  return `[${capture}]() mutable { ${invocation}; }`;
}

function emitPromiseCall(call: CallExpression): string {
  if (call.args.length !== 1 || call.args[0]?.kind !== NodeKind.ArrowFunctionExpression) {
    throw new CppEmitError("C++ Promise construction expects one executor callback");
  }
  const executor = call.args[0] as ArrowFunctionExpression;
  if (
    executor.parameters.length !== 2 ||
    executor.parameters.some((parameter) => parameter.name.kind !== NodeKind.Identifier)
  ) {
    throw new CppEmitError("C++ Promise executors require resolve and reject identifier parameters");
  }

  const promiseType = activeExpressionTypes.get(call as Node);
  const valueType = promiseType?.kind === AnalysisTypeKind.Named && promiseType.name === "Promise"
    ? cppTypeForAnalysisType(promiseType.typeArguments?.[0] ?? builtinType("unknown")) ?? "vexa::Value"
    : "vexa::Value";
  const parameterNames = executor.parameters.map((parameter) => (parameter.name as Identifier).name);
  const previousLocalNames = activeLocalNames;
  const previousThisExpression = activeThisExpression;
  activeLocalNames = copyStringSetWithValues(activeLocalNames, parameterNames);
  try {
    const capture = nativeLambdaCapture("__vexa_promise_self", true);
    activeThisExpression = capture.thisExpression;
    const body = executor.body.kind === NodeKind.BlockStatement
      ? emitBlock(executor.body as BlockStatement, "")
      : `{ ${emitExpression(executor.body as Expr)}; }`;
    return `vexa::Task<${valueType}>::create(${activeRuntimeName}, ${capture.text}(auto ${cppName(parameterNames[0]!)}, auto ${cppName(parameterNames[1]!)}) mutable ${body})`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeThisExpression = previousThisExpression;
  }
}

function extensionReceiverNamesForExpression(expression: Expr): string[] {
  const type = activeExpressionTypes.get(expression as Node);
  if (!type) {
    if (isManagedArrayExpression(expression) || expression.kind === NodeKind.ArrayLiteral) return ["Array"];
    if (expression.kind === NodeKind.IntLiteral) return ["int", "number"];
    if (expression.kind === NodeKind.FloatLiteral) return ["number"];
    if (expression.kind === NodeKind.StringLiteral) return ["string"];
    if (expression.kind === NodeKind.BooleanLiteral) return ["boolean"];
    const className = classNameForExpression(expression);
    return className ? [className] : [];
  }
  if (type?.kind === AnalysisTypeKind.Array || type?.kind === AnalysisTypeKind.Tuple) return ["Array"];
  if (type?.kind === AnalysisTypeKind.Builtin) return type.name === "int" ? ["int", "number"] : [type.name];
  if (type?.kind !== AnalysisTypeKind.Named) return [];
  const names: string[] = [];
  const pending = [type.name];
  while (pending.length > 0) {
    const name = pending.pop()!;
    const baseName = parseTypeNameShape(name).baseName;
    if (names.includes(baseName)) continue;
    names.push(baseName);
    const classStatement = activeClassStatements.get(baseName);
    if (classStatement?.extendsType) pending.push(classStatement.extendsType.name);
    for (const implementedType of classStatement?.implementsTypes ?? []) pending.push(implementedType.name);
    const interfaceStatement = activeInterfaceStatements.get(baseName);
    for (const extendedType of interfaceStatement?.extendsTypes ?? []) pending.push(extendedType.name);
  }
  return names;
}

function extensionFunctionForCall(member: ReturnType<typeof memberParts>): FunctionStatement | null {
  if (!member) return null;
  for (const receiverName of extensionReceiverNamesForExpression(member.object)) {
    const candidates = activeExtensionFunctions.get(receiverName);
    if (!candidates) continue;
    for (const candidate of candidates) {
      if (candidate.name.name === member.propertyName) return candidate;
    }
  }
  const resolvedAsExtension = member.property !== undefined &&
    activeImplicitReceiverExtensionIdentifiers.has(member.property as Node);
  if (!resolvedAsExtension) return null;
  for (const candidates of activeExtensionFunctions.values()) {
    for (const candidate of candidates) {
      const universal = (candidate.typeParameters ?? []).some(
        (parameter) => parameter.name.name === candidate.receiverType?.name
      );
      if (universal && candidate.name.name === member.propertyName) return candidate;
    }
  }
  return null;
}

function extensionTemplateArguments(
  statement: FunctionStatement,
  receiver: Expr,
  argumentsList: readonly Expr[]
): Map<string, string> {
  const bindings = new Map<string, string>();
  const receiverType = activeExpressionTypes.get(receiver as Node);
  const receiverParameters = statement.receiverTypeArguments ?? [];
  const receiverArguments = receiverType?.kind === AnalysisTypeKind.Array || receiverType?.kind === AnalysisTypeKind.Tuple
    ? [receiverType.kind === AnalysisTypeKind.Array
        ? receiverType.elementType
        : receiverType.elements[0] ?? builtinType("unknown")]
    : receiverType?.kind === AnalysisTypeKind.Named
      ? receiverType.typeArguments ?? []
      : [];
  const emittedReceiverElement = managedArrayElementType(
    emittedCppTypeForExpression(receiver) ?? cppTypeForExpression(receiver)
  );
  if ((statement.typeParameters ?? []).some((parameter) => parameter.name.name === statement.receiverType?.name)) {
    const receiverCppType = emittedCppTypeForExpression(receiver) ?? cppTypeForExpression(receiver);
    if (statement.receiverType && receiverCppType !== "auto") {
      bindings.set(statement.receiverType.name, receiverCppType);
    }
  }
  receiverParameters.forEach((parameter, index) => {
    const mapped = receiverArguments[index]
      ? (receiverType?.kind === AnalysisTypeKind.Array || receiverType?.kind === AnalysisTypeKind.Tuple
          ? cppArrayElementType(receiverArguments[index]!)
          : cppTypeForAnalysisType(receiverArguments[index]!))
      : index === 0 ? emittedReceiverElement : null;
    if (mapped) bindings.set(parameter.name, mapped);
  });
  const orderedArguments = orderedCallArguments(argumentsList, statement.parameters);
  statement.parameters.forEach((parameter, index) => {
    const typeName = parameter.typeAnnotation?.name;
    let isTypeParameter = false;
    for (const item of statement.typeParameters ?? []) {
      if (item.name.name === typeName) {
        isTypeParameter = true;
        break;
      }
    }
    if (!typeName || bindings.has(typeName) || !isTypeParameter) {
      return;
    }
    const mapped = cppTypeForExpression(orderedArguments[index]!);
    if (mapped !== "auto") bindings.set(typeName, mapped);
  });
  return bindings;
}

function emitExtensionFunctionCall(call: CallExpression, member: NonNullable<ReturnType<typeof memberParts>>): string | null {
  const statement = extensionFunctionForCall(member);
  if (!statement) return null;
  const receiver = isManagedArrayExpression(member.object)
    ? emitManagedArrayPointer(member.object)
    : emitExpression(member.object);
  const bindings = extensionTemplateArguments(statement, member.object, call.args);
  const argumentsText = emitArguments(call.args, statement.parameters, bindings);
  const explicitTemplateArguments = cppCallTemplateArguments(call);
  const templateArguments = explicitTemplateArguments || (statement.typeParameters?.length &&
    statement.typeParameters.every((parameter) => bindings.has(parameter.name.name))
      ? `<${statement.typeParameters.map((parameter) => bindings.get(parameter.name.name)).join(", ")}>`
      : "");
  return `${cppName(extensionCppName(statement))}${templateArguments}(${receiver}${argumentsText.length > 0 ? `, ${argumentsText}` : ""})`;
}

function cppCallTemplateArguments(call: CallExpression): string {
  if (!call.typeArguments?.length) return "";
  const argumentsList = call.typeArguments.map((argument) => {
    const mapped = cppTypeForDeclaredName(argument.name);
    if (!mapped || mapped === "void") {
      throw new CppEmitError(`C++ cannot map explicit type argument '${argument.name}'`, call);
    }
    return mapped;
  });
  return `<${argumentsList.join(", ")}>`;
}

function inferredMethodTemplateArguments(call: CallExpression, method: CallableMember): string {
  const typeParameters = method.typeParameters;
  if (!typeParameters?.length) return "";
  const bindings = methodTemplateBindings(call, method);
  if (!typeParameters.every((parameter) => bindings.has(parameter.name.name))) return "";
  if (method.name.name === "attachNodeBounds") return "";
  return `<${typeParameters.map((parameter) => {
    const binding = bindings.get(parameter.name.name)!;
    return cppTypeForDeclaredNameOr(binding, binding);
  }).join(", ")}>`;
}

function bindCppTypePattern(
  typeParameters: readonly TypeParameter[],
  bindings: Map<string, string>,
  pattern: string,
  actual: string
): void {
  const direct = typeParameters.find((candidate) => candidate.name.name === pattern);
  if (direct) {
    if (!bindings.has(direct.name.name)) bindings.set(direct.name.name, actual);
    return;
  }
  const shape = parseTypeNameShape(pattern);
  if (shape.typeArguments.length === 0 && shape.arrayDepth === 0) return;
  let actualArguments: string[] | null = null;
  if (isNativeMapTypeName(shape.baseName)) {
    actualArguments = cppTemplateArguments(actual, "vexa::MapObject<");
  } else if (shape.baseName === "WeakMap") {
    actualArguments = cppTemplateArguments(actual, "vexa::WeakMapObject<");
  } else if (isNativeSetTypeName(shape.baseName)) {
    actualArguments = cppTemplateArguments(actual, "vexa::SetObject<");
  } else if (shape.baseName === "WeakSet") {
    actualArguments = cppTemplateArguments(actual, "vexa::WeakSetObject<");
  } else if ((shape.baseName === "Array" || shape.baseName === "ReadonlyArray") || shape.arrayDepth > 0) {
    const elementType = managedArrayElementType(actual);
    if (elementType) actualArguments = [elementType];
  }
  if (!actualArguments) return;
  const patternArguments = shape.arrayDepth > 0 ? [shape.baseName] : shape.typeArguments;
  patternArguments.forEach((argument, index) => {
    const actualArgument = actualArguments[index];
    if (!actualArgument) return;
    const parameter = typeParameters.find((candidate) => candidate.name.name === argument);
    if (parameter && !bindings.has(parameter.name.name)) {
      bindings.set(parameter.name.name, actualArgument);
    }
  });
}

function methodTemplateBindings(
  call: CallExpression,
  method: CallableMember | FunctionStatement
): Map<string, string> {
  const typeParameters: TypeParameter[] = method.typeParameters ?? [];
  const parameters: FunctionParameter[] = method.parameters;
  const bindings = new Map<string, string>();
  if (call.typeArguments) {
    for (let index = 0; index < call.typeArguments.length; index += 1) {
      const argument = call.typeArguments[index]!;
      const parameter = typeParameters[index];
      if (parameter) bindings.set(parameter.name.name, argument.name);
    }
  }
  const resultType = cppTypeForExpression(call);
  const resultElementType = managedArrayElementType(resultType);
  const returnArray: ArraySuffixTypeName | null = method.returnType
    ? splitArraySuffixTypeName(method.returnType.name)
    : null;
  if (resultElementType && returnArray?.arrayDepth === 1) {
    const parameter = typeParameters.find((candidate) => candidate.name.name === returnArray.elementTypeName);
    if (parameter) bindings.set(parameter.name.name, resultElementType);
  }
  parameters.forEach((parameter, index) => {
    const argument = call.args[index];
    if (!argument || !parameter.typeAnnotation) return;
    const declaredArgumentType = cppTypeForExpression(argument);
    const argumentType = declaredArgumentType !== "auto"
      ? declaredArgumentType
      : emittedCppTypeForExpression(argument) ?? "vexa::Value";
    bindCppTypePattern(typeParameters, bindings, parameter.typeAnnotation.name, argumentType);
    const direct = typeParameters.find((candidate) => candidate.name.name === parameter.typeAnnotation!.name);
    if (direct && !bindings.has(direct.name.name)) bindings.set(direct.name.name, argumentType);
    const callback = parseFunctionTypeAnnotation(parameter.typeAnnotation.name);
    const callbackReturn = callback?.returnTypeName;
    const callbackParameter = callbackReturn
      ? typeParameters.find((candidate) => candidate.name.name === callbackReturn)
      : undefined;
    const analyzedArgumentType = activeExpressionTypes.get(argument as Node);
    if (callbackParameter && !bindings.has(callbackParameter.name.name)) {
      if (analyzedArgumentType?.kind === AnalysisTypeKind.Function) {
        const declaredResult = declaredTypeNameForExpression(argument);
        const analyzedResult = analyzedArgumentType.returnType.kind === AnalysisTypeKind.Named
          ? analyzedArgumentType.returnType.name
          : analyzedArgumentType.returnType.kind === AnalysisTypeKind.Builtin
            ? analyzedArgumentType.returnType.name
            : analyzedArgumentType.returnType.kind === AnalysisTypeKind.Literal
              ? analyzedArgumentType.returnType.base
            : null;
        bindings.set(
          callbackParameter.name.name,
          declaredResult ?? analyzedResult ?? cppTypeForAnalysisType(analyzedArgumentType.returnType) ?? "vexa::Value"
        );
      } else if (argument.kind === NodeKind.ArrowFunctionExpression || argument.kind === NodeKind.FunctionExpression) {
        const callbackResult = callableExpressionResultCppType(argument as ArrowFunctionExpression | FunctionExpression);
        if (callbackResult) bindings.set(callbackParameter.name.name, callbackResult);
      }
    }
  });
  return bindings;
}

function promiseCombinatorName(name: string): string | null {
  switch (name) {
    case "all": return "promiseAll";
    case "race": return "promiseRace";
    case "allSettled": return "promiseAllSettled";
    case "any": return "promiseAny";
    default: return null;
  }
}

function isArrayRuntimeMethod(name: string): boolean {
  switch (name) {
    case "push": case "pop": case "shift": case "unshift": case "includes":
    case "indexOf": case "join": case "reverse": case "slice": case "concat":
    case "map": case "filter": case "reduce": case "forEach": case "some":
    case "every": case "findIndex": case "find": case "at": case "lastIndexOf":
    case "splice": case "fill": case "copyWithin": case "flat": case "flatMap":
    case "sort":
      return true;
    default:
      return false;
  }
}

function isArrayCallbackMethod(name: string): boolean {
  switch (name) {
    case "map": case "flatMap": case "filter": case "reduce": case "forEach":
    case "some": case "every": case "findIndex": case "find": case "sort":
      return true;
    default:
      return false;
  }
}

function primitiveRuntimeMethodName(name: string): string | null {
  switch (name) {
    case "toString": case "valueOf": case "toFixed": case "toUpperCase":
    case "toLowerCase": case "trim": case "trimStart": case "trimEnd":
    case "startsWith": case "endsWith": case "charAt": case "charCodeAt":
    case "substring": case "split":
      return name;
    case "includes": return "stringIncludes";
    case "indexOf": return "stringIndexOf";
    case "lastIndexOf": return "stringLastIndexOf";
    case "replace": return "stringReplace";
    case "repeat": return "stringRepeat";
    case "slice": return "stringSlice";
    case "test": return "regexTest";
    case "exec": return "regexExec";
    default: return null;
  }
}

function emitCall(call: CallExpression, resultUsed = true): string {
  if (
    call.receiverBlockShorthand === true &&
    call.args[0]?.kind === NodeKind.ArrowFunctionExpression
  ) {
    const receiver = call.callee;
    const receiverCppType = emittedCppTypeForExpression(receiver) ?? cppTypeForExpression(receiver);
    const previousResult = activeExpectedLambdaResultCppType;
    const previousParameters = activeExpectedLambdaParameterCppTypes;
    activeExpectedLambdaResultCppType = "void";
    activeExpectedLambdaParameterCppTypes = [receiverCppType];
    let blockText: string;
    try {
      blockText = emitExpression(call.args[0]!);
    } finally {
      activeExpectedLambdaResultCppType = previousResult;
      activeExpectedLambdaParameterCppTypes = previousParameters;
    }
    const receiverText = emitExpression(receiver);
    return `([&](auto __vexa_receiver_block) { (${blockText})(__vexa_receiver_block); return __vexa_receiver_block; })(${receiverText})`;
  }
  const calleeName = identifierName(call.callee);
  if (calleeName === "Promise") return emitPromiseCall(call);
  if (calleeName === "Map" || calleeName === "Set" || calleeName === "WeakMap" || calleeName === "WeakSet") {
    return emitNativeCollectionConstruction(call, calleeName);
  }
  const localCallableType = calleeName && activeLocalNames.has(calleeName)
    ? activeLocalCppTypes.get(calleeName)
    : null;
  const localCallableParameters = localCallableType
    ? stdFunctionParameterCppTypes(localCallableType)
    : null;
  if (localCallableParameters && localCallableParameters.length === call.args.length) {
    const argumentsText = call.args.map((argument, index) =>
      emitConvertedValue(argument, localCallableParameters[index]!)).join(", ");
    return `${emitExpression(call.callee)}(${argumentsText})`;
  }
  let cachedArgumentsText: string | null = null;
  const argumentsText = (): string => cachedArgumentsText ??= emitAnalyzedCallArguments(call);
  const member = memberParts(call.callee);
  if (member?.objectName === "console") {
    const supported = new Set(["log", "info", "warn", "error"]);
    if (!supported.has(member.propertyName)) {
      throw new CppEmitError(`C++ emission does not support console.${member.propertyName} yet`);
    }
    const consoleArguments = call.args.map((argument) => emitConvertedValue(argument, "vexa::Value")).join(", ");
    // Braced initializer elements are evaluated left to right. Plain C++
    // function arguments have no corresponding order guarantee, which can
    // reverse observable VexaScript side effects on GCC.
    return `vexa::console.${member.propertyName}({${consoleArguments}})`;
  }
  if (member?.objectName === "Math") {
    return `vexa::Math::${cppName(member.propertyName)}(${argumentsText()})`;
  }
  if (member?.objectName === "Number" && member.propertyName === "isInteger") {
    if (call.args.length !== 1) throw new CppEmitError("C++ Number.isInteger expects one argument", call);
    return `vexa::numberIsInteger(${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "Number" && member.propertyName === "isNaN") {
    if (call.args.length !== 1) throw new CppEmitError("C++ Number.isNaN expects one argument", call);
    return `vexa::numberIsNaN(${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "Array" && member.propertyName === "isArray") {
    if (call.args.length !== 1) throw new CppEmitError("C++ Array.isArray expects one argument", call);
    return `vexa::arrayIsArray(${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "String" && member.propertyName === "fromCharCode") {
    if (call.args.length !== 1) throw new CppEmitError("C++ String.fromCharCode expects one argument", call);
    return `vexa::stringFromCharCode(${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "Object" &&
      (member.propertyName === "keys" || member.propertyName === "values" || member.propertyName === "entries")) {
    if (call.args.length !== 1) throw new CppEmitError(`C++ Object.${member.propertyName} expects one argument`, call);
    const helper = member.propertyName === "keys" ? "recordKeys" : member.propertyName === "values" ? "recordValues" : "recordEntries";
    return `vexa::${helper}(${activeRuntimeName}, ${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "Object" && member.propertyName === "fromEntries") {
    if (call.args.length !== 1) throw new CppEmitError("C++ Object.fromEntries expects one argument", call);
    return `vexa::recordFromEntries(${activeRuntimeName}, ${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "Number" && member.propertyName === "isFinite") {
    if (call.args.length !== 1) throw new CppEmitError("C++ Number.isFinite expects one argument", call);
    return `vexa::isFinite(vexa::Number(${emitExpression(call.args[0]!) }))`;
  }
  if (member?.objectName === "Date" && member.propertyName === "now") {
    if (call.args.length !== 0) throw new CppEmitError("C++ Date.now expects no arguments", call);
    return "vexa::dateNow()";
  }
  if (member?.objectName === "Date" && member.propertyName === "parse") {
    if (call.args.length !== 1) throw new CppEmitError("C++ Date.parse expects one string", call);
    return `vexa::dateParse(vexa::convertValue<std::u16string>(${emitExpression(call.args[0]!)}))`;
  }
  if (member?.objectName === "Object" &&
      (member.propertyName === "keys" || member.propertyName === "values")) {
    if (call.args.length !== 1) throw new CppEmitError(`C++ Object.${member.propertyName} expects one object`);
    return `vexa::record${member.propertyName === "keys" ? "Keys" : "Values"}(${activeRuntimeName}, ${emitExpression(call.args[0]!)})`;
  }
  if (member?.objectName === "Object" && member.propertyName === "defineProperty") {
    if (call.args.length !== 3) throw new CppEmitError("C++ Object.defineProperty expects three arguments", call);
    const target = call.args[0]!;
    const key = call.args[1]!;
    const value = objectLiteralPropertyValue(call.args[2]!, "value");
    const enumerable = objectLiteralPropertyValue(call.args[2]!, "enumerable");
    if (!value) {
      throw new CppEmitError(
        "C++ Object.defineProperty currently requires a literal value descriptor",
        call
      );
    }
    const receiver = emitExpression(target);
    const assigned = emitConvertedValue(value, "vexa::Value");
    const isEnumerable = enumerable ? emitCondition(enumerable) : "false";
    const body = `auto __vexa_define_receiver = ${receiver}; vexa::defineProperty(${activeRuntimeName}, __vexa_define_receiver, vexa::propertyKey(${emitExpression(key)}), ${assigned}, ${isEnumerable});`;
    return resultUsed
      ? `([&]() { ${body} return __vexa_define_receiver; }())`
      : `{ ${body} }`;
  }
  if (member?.objectName === "JSON" && (member.propertyName === "parse" || member.propertyName === "stringify")) {
    const validArgumentCount = member.propertyName === "parse"
      ? call.args.length === 1
      : call.args.length >= 1 && call.args.length <= 3;
    if (!validArgumentCount) {
      throw new CppEmitError(`C++ JSON.${member.propertyName} expects ${member.propertyName === "parse" ? "one argument" : "one to three arguments"}`, call);
    }
    const argument = emitConvertedValue(call.args[0]!, "vexa::Value");
    return member.propertyName === "parse"
      ? `vexa::jsonParse(${activeRuntimeName}, ${argument})`
      : `vexa::jsonStringify(${activeRuntimeName}, ${argument})`;
  }
  if (member?.objectName === "Promise") {
    if (member.propertyName === "resolve") {
      if (call.args.length > 1) throw new CppEmitError("C++ Promise.resolve expects zero or one argument");
      return call.args.length === 0
        ? `vexa::promiseResolve(${activeRuntimeName}, vexa::Value::undefined())`
        : `vexa::promiseResolve(${activeRuntimeName}, ${emitExpression(call.args[0]!)})`;
    }
    if (member.propertyName === "reject") {
      if (call.args.length !== 1) throw new CppEmitError("C++ Promise.reject expects one reason");
      const promiseType = activeExpressionTypes.get(call as Node);
      const contextualValueType = activeExpectedExpressionCppType
        ? cppTemplateArguments(activeExpectedExpressionCppType, "vexa::Task<")?.[0]
        : null;
      const valueType = contextualValueType ?? (promiseType?.kind === AnalysisTypeKind.Named && promiseType.name === "Promise"
        ? cppTypeForAnalysisType(promiseType.typeArguments?.[0] ?? builtinType("unknown")) ?? "vexa::Value"
        : "vexa::Value");
      return `vexa::rejectedTask<${valueType}>(${activeRuntimeName}, ${emitExpression(call.args[0]!)})`;
    }
    const promiseCombinator = promiseCombinatorName(member.propertyName);
    if (promiseCombinator) {
      if (call.args.length !== 1) {
        throw new CppEmitError(`C++ Promise.${member.propertyName} expects one task array`);
      }
      const taskArray = call.args[0]!;
      let expectedTaskArrayType: string | null = null;
      if (taskArray.kind === NodeKind.ArrayLiteral) {
        let fallbackTaskType: string | null = null;
        for (const element of (taskArray as ArrayLiteral).elements) {
          if (element.kind === NodeKind.SpreadExpression) continue;
          const elementType = emittedCppTypeForExpression(element);
          if (!elementType?.startsWith("vexa::Task<")) continue;
          fallbackTaskType ??= elementType;
          const resultType = cppTemplateArguments(elementType, "vexa::Task<")?.[0];
          if (resultType && resultType !== "void" && resultType !== "vexa::Value") {
            fallbackTaskType = elementType;
            break;
          }
        }
        if (fallbackTaskType) expectedTaskArrayType = `vexa::ArrayObject<${fallbackTaskType}>*`;
      }
      const tasks = expectedTaskArrayType
        ? emitExpressionWithExpectedCppType(taskArray, expectedTaskArrayType)
        : isManagedArrayExpression(taskArray)
          ? emitManagedArrayPointer(taskArray)
          : emitExpression(taskArray);
      return `vexa::${promiseCombinator}(${activeRuntimeName}, ${tasks})`;
    }
  }
  if (member && new Set(["then", "catch", "finally"]).has(member.propertyName)) {
    if (call.args.length !== 1) {
      throw new CppEmitError(`C++ Promise.${member.propertyName} expects one callback`);
    }
    const helper = member.propertyName === "then"
      ? "promiseThen"
      : member.propertyName === "catch"
        ? "promiseCatch"
        : "promiseFinally";
    const previousParameters = activeExpectedLambdaParameterCppTypes;
    const previousResult = activeExpectedLambdaResultCppType;
    const receiverType = emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object);
    const receiverResult = cppTemplateArguments(receiverType, "vexa::Task<")?.[0];
    const callType = emittedCppTypeForExpression(call) ?? cppTypeForExpression(call);
    const callbackResult = cppTemplateArguments(callType, "vexa::Task<")?.[0];
    if (member.propertyName === "then" && receiverResult) {
      activeExpectedLambdaParameterCppTypes = [receiverResult];
    } else if (member.propertyName === "catch") {
      activeExpectedLambdaParameterCppTypes = ["vexa::Value"];
    }
    if (member.propertyName !== "finally" && callbackResult) {
      activeExpectedLambdaResultCppType = callbackResult;
    }
    let result: string;
    try {
      result = `vexa::${helper}(${activeRuntimeName}, ${emitExpression(member.object)}, ${emitExpression(call.args[0]!)})`;
    } finally {
      activeExpectedLambdaParameterCppTypes = previousParameters;
      activeExpectedLambdaResultCppType = previousResult;
    }
    return result;
  }
  if (member) {
    const collection = nativeCollectionKind(member.object);
    const optionalReceiver = call.callee.kind === NodeKind.MemberExpression && (
      (call.callee as MemberExpression).optional === true ||
      isOptionalChainExpression((call.callee as MemberExpression).object)
    );
    if (collection === "map") {
      const receiver = emitNativePointerExpression(member.object, nativeCollectionPointerCppType(member.object));
      if (member.propertyName === "clear") {
        if (call.args.length !== 0) throw new CppEmitError("C++ Map.clear expects no arguments", call);
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) => `vexa::mapClear(${target})`);
      }
      if (member.propertyName === "get" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.args.length !== 1) throw new CppEmitError(`C++ Map.${member.propertyName} expects one key`, call);
        const getResultType = member.propertyName === "get" ? cppTypeForExpression(call) : null;
        const helper = member.propertyName === "get"
          ? getResultType?.endsWith("*") ? "mapGet" : "mapGetValue"
          : member.propertyName === "has" ? "mapHas" : "mapDelete";
        return emitNativeReceiverCall(
          optionalReceiver,
          receiver,
          (target) => `vexa::${helper}(${activeRuntimeName}, ${target}, ${emitExpression(call.args[0]!)})`
        );
      }
      if (member.propertyName === "set") {
        if (call.args.length !== 2) throw new CppEmitError("C++ Map.set expects a key and value", call);
        return emitNativeReceiverCall(
          optionalReceiver,
          receiver,
          (target) => `vexa::mapSet(${activeRuntimeName}, ${target}, ${emitExpression(call.args[0]!)}, ${emitExpression(call.args[1]!)})`
        );
      }
      if (member.propertyName === "forEach") {
        if (call.args.length !== 1) throw new CppEmitError("C++ Map.forEach expects one callback", call);
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::mapForEach(${target}, ${emitExpression(call.args[0]!)})`);
      }
      if (member.propertyName === "keys" || member.propertyName === "values" || member.propertyName === "entries") {
        if (call.args.length !== 0) throw new CppEmitError(`C++ Map.${member.propertyName} expects no arguments`, call);
        const helper = member.propertyName === "keys" ? "mapKeys" : member.propertyName === "values" ? "mapValues" : "mapEntries";
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::${helper}(${activeRuntimeName}, ${target})`);
      }
    }
    if (collection === "set") {
      const receiver = emitNativePointerExpression(member.object, nativeCollectionPointerCppType(member.object));
      if (member.propertyName === "clear") {
        if (call.args.length !== 0) throw new CppEmitError("C++ Set.clear expects no arguments", call);
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) => `vexa::setClear(${target})`);
      }
      if (member.propertyName === "add" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.args.length !== 1) throw new CppEmitError(`C++ Set.${member.propertyName} expects one value`, call);
        const helper = member.propertyName === "add" ? "setAdd" : member.propertyName === "has" ? "setHas" : "setDelete";
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::${helper}(${activeRuntimeName}, ${target}, ${emitExpression(call.args[0]!)})`);
      }
      if (member.propertyName === "forEach") {
        if (call.args.length !== 1) throw new CppEmitError("C++ Set.forEach expects one callback", call);
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::setForEach(${target}, ${emitExpression(call.args[0]!)})`);
      }
      if (member.propertyName === "keys" || member.propertyName === "values") {
        if (call.args.length !== 0) throw new CppEmitError(`C++ Set.${member.propertyName} expects no arguments`, call);
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::setValues(${activeRuntimeName}, ${target})`);
      }
    }
    if (collection === "weakMap") {
      const receiver = emitNativePointerExpression(member.object, nativeCollectionPointerCppType(member.object));
      if (member.propertyName === "get" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.args.length !== 1) throw new CppEmitError(`C++ WeakMap.${member.propertyName} expects one key`, call);
        const helper = member.propertyName === "get" ? "weakMapGet" : member.propertyName === "has" ? "weakMapHas" : "weakMapDelete";
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::${helper}(${activeRuntimeName}, ${target}, ${emitExpression(call.args[0]!)})`);
      }
      if (member.propertyName === "set") {
        if (call.args.length !== 2) throw new CppEmitError("C++ WeakMap.set expects a key and value", call);
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::weakMapSet(${activeRuntimeName}, ${target}, ${emitExpression(call.args[0]!)}, ${emitExpression(call.args[1]!)})`);
      }
    }
    if (collection === "weakSet") {
      const receiver = emitNativePointerExpression(member.object, nativeCollectionPointerCppType(member.object));
      if (member.propertyName === "add" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.args.length !== 1) throw new CppEmitError(`C++ WeakSet.${member.propertyName} expects one value`, call);
        const helper = member.propertyName === "add" ? "weakSetAdd" : member.propertyName === "has" ? "weakSetHas" : "weakSetDelete";
        return emitNativeReceiverCall(optionalReceiver, receiver, (target) =>
          `vexa::${helper}(${activeRuntimeName}, ${target}, ${emitExpression(call.args[0]!)})`);
      }
    }
  }
  if (member && isDateExpression(member.object)) {
    const supported = new Set([
      "getTime", "valueOf", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay",
      "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds",
      "toISOString", "toJSON", "toString",
    ]);
    if (supported.has(member.propertyName)) {
      if (call.args.length !== 0) throw new CppEmitError(`C++ Date.${member.propertyName} expects no arguments`, call);
      return `${emitExpression(member.object)}->${cppName(member.propertyName)}()`;
    }
  }
  if (member && nativeBinaryObjectKind(member.object) === "dataView") {
    const supported = new Set([
      "getUint8", "getInt8", "getUint16", "getInt16", "getUint32", "getInt32",
      "getFloat32", "getFloat64",
      "setUint8", "setInt8", "setUint16", "setInt16", "setUint32", "setInt32",
      "setFloat32", "setFloat64",
    ]);
    if (supported.has(member.propertyName)) {
      return `${emitExpression(member.object)}->${cppName(member.propertyName)}(${argumentsText()})`;
    }
  }
  if (member && isArrayExpression(member.object) && isArrayRuntimeMethod(member.propertyName)) {
    const expectedCallType = activeExpectedExpressionCppType;
    activeExpectedExpressionCppType = null;
    let receiver: string;
    try {
      receiver = isManagedArrayExpression(member.object)
        ? emitManagedArrayPointer(member.object)
        : emitExpression(member.object);
    } finally {
      activeExpectedExpressionCppType = expectedCallType;
    }
    const convertsValueArguments = new Set(["push", "unshift", "includes", "indexOf", "lastIndexOf", "concat", "splice", "fill"])
      .has(member.propertyName);
    const receiverElementType = managedArrayElementType(
      emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object)
    ) ?? (isDynamicValueExpression(member.object) ? "vexa::Value" : null);
    if (member.propertyName === "push" && call.args.some((argument) => argument.kind === NodeKind.SpreadExpression)) {
      const elementType = receiverElementType ?? "vexa::Value";
      const packed = emitArrayElements(call.args, elementType);
      const body = `auto* __vexa_receiver = ${receiver}; auto* __vexa_values = ${packed};`;
      return resultUsed
        ? `([&]() { ${body} return vexa::pushAll(__vexa_receiver, __vexa_values); }())`
        : `{ ${body} vexa::pushAll(__vexa_receiver, __vexa_values); }`;
    }
    if (member.propertyName === "splice" && call.args.slice(2).some((argument) => argument.kind === NodeKind.SpreadExpression)) {
      if (call.args.length < 2) throw new CppEmitError("C++ Array.splice expects a start and delete count before spread items", call);
      const elementType = receiverElementType ?? "vexa::Value";
      const packed = emitArrayElements(call.args.slice(2), elementType);
      const body = `auto* __vexa_receiver = ${receiver}; auto* __vexa_values = ${packed};`;
      const splice = `vexa::spliceAll(${activeRuntimeName}, __vexa_receiver, ${emitExpression(call.args[0]!)}, ${emitExpression(call.args[1]!)}, __vexa_values)`;
      return resultUsed ? `([&]() { ${body} return ${splice}; }())` : `{ ${body} ${splice}; }`;
    }
    const semanticCallType = cppTypeForExpression(call);
    const mappedCallType = activeExpectedExpressionCppType ??
      (semanticCallType !== "auto" ? semanticCallType : null) ??
      emittedCppTypeForExpression(call) ??
      semanticCallType;
    const contextualCallbackResult = new Set(["map", "flatMap"]).has(member.propertyName) &&
      managedArrayElementType(mappedCallType) !== null
      ? mappedCallType
      : null;
    const emitContextualArrayArguments = (): string => {
      const callbackMethod = isArrayCallbackMethod(member.propertyName);
      if (!contextualCallbackResult && !callbackMethod) return argumentsText();
      const previous = activeExpectedExpressionCppType;
      const previousParameters = activeExpectedLambdaParameterCppTypes;
      const previousResult = activeExpectedLambdaResultCppType;
      if (contextualCallbackResult) activeExpectedExpressionCppType = contextualCallbackResult;
      if (member.propertyName === "map" && contextualCallbackResult) {
        activeExpectedLambdaResultCppType = managedArrayElementType(contextualCallbackResult);
      } else if (member.propertyName === "flatMap" && contextualCallbackResult) {
        activeExpectedLambdaResultCppType = contextualCallbackResult;
      } else if (member.propertyName === "reduce") {
        const initial = call.args[1];
        activeExpectedLambdaResultCppType = initial
          ? emittedCppTypeForExpression(initial) ?? cppTypeForExpression(initial)
          : receiverElementType;
      } else if (new Set(["filter", "some", "every", "findIndex", "find"]).has(member.propertyName)) {
        activeExpectedLambdaResultCppType = "bool";
      } else if (member.propertyName === "forEach") {
        activeExpectedLambdaResultCppType = "void";
      } else if (member.propertyName === "sort") {
        activeExpectedLambdaResultCppType = "double";
      }
      activeExpectedLambdaParameterCppTypes = receiverElementType
        ? member.propertyName === "reduce"
          ? [activeExpectedLambdaResultCppType ?? receiverElementType, receiverElementType, "double", cppTypeForExpression(member.object)]
          : [receiverElementType, "double", cppTypeForExpression(member.object)]
        : null;
      let result: string;
      try {
        result = call.args.map((argument) => emitExpression(argument)).join(", ");
      } finally {
        activeExpectedExpressionCppType = previous;
        activeExpectedLambdaParameterCppTypes = previousParameters;
        activeExpectedLambdaResultCppType = previousResult;
      }
      return result;
    };
    let arrayArguments: string;
    if (member.propertyName === "concat") {
      arrayArguments = call.args.map((argument) => {
        if (isManagedArrayExpression(argument)) return emitManagedArrayPointer(argument);
        return receiverElementType === "vexa::Value"
          ? emitConvertedValue(argument, "vexa::Value")
          : emitExpression(argument);
      }).join(", ");
    } else if (receiverElementType && receiverElementType !== "vexa::Value" && convertsValueArguments) {
      arrayArguments = call.args.map((argument, index) => {
          const converts = member.propertyName === "splice"
            ? index >= 2
            : member.propertyName === "fill"
              ? index === 0
              : true;
          return converts
            ? emitConvertedValue(argument, receiverElementType)
            : emitConvertedValue(argument, "double");
        }).join(", ");
    } else if (receiverElementType === "vexa::Value" && convertsValueArguments) {
      arrayArguments = call.args.map((argument, index) => {
          const converts = member.propertyName === "splice"
            ? index >= 2
            : member.propertyName === "fill"
              ? index === 0
              : true;
          if (converts) return emitConvertedValue(argument, "vexa::Value");
          if (member.propertyName === "splice" || (member.propertyName === "fill" && index > 0)) {
            return emitConvertedValue(argument, "double");
          }
          return emitExpression(argument);
        }).join(", ");
    } else if (new Set(["slice", "copyWithin", "at"]).has(member.propertyName)) {
      arrayArguments = call.args.map((argument) => emitConvertedValue(argument, "double")).join(", ");
    } else if (member.propertyName === "splice") {
      arrayArguments = call.args.map((argument, index) => index < 2
        ? emitConvertedValue(argument, "double")
        : emitExpression(argument)).join(", ");
    } else if (member.propertyName === "fill") {
      arrayArguments = call.args.map((argument, index) => index === 0
        ? emitExpression(argument)
        : emitConvertedValue(argument, "double")).join(", ");
    } else {
      arrayArguments = emitContextualArrayArguments();
    }
    const allocatesArray = isManagedArrayExpression(member.object) &&
      new Set(["slice", "concat", "map", "filter", "splice", "flat", "flatMap"]).has(member.propertyName);
    return `vexa::${member.propertyName}(${allocatesArray ? `${activeRuntimeName}, ` : ""}${receiver}${arrayArguments ? `, ${arrayArguments}` : ""})`;
  }
  if (member?.propertyName === "return" && isGeneratorExpression(member.object)) {
    if (call.args.length > 1) {
      throw new CppEmitError("C++ generator return expects zero or one value");
    }
    return `${emitExpression(member.object)}.finish(${argumentsText()})`;
  }
  if (member) {
    const primitiveMethod = primitiveRuntimeMethodName(member.propertyName);
    if (primitiveMethod) {
      const receiver = emitExpression(member.object);
      const runtimeArgument = primitiveMethod === "split" || primitiveMethod === "regexExec"
        ? `${activeRuntimeName}, `
        : "";
      const numericArguments = new Set(["substring", "stringSlice", "charAt", "charCodeAt", "stringRepeat"])
        .has(primitiveMethod);
      let emittedArguments: string;
      if (numericArguments) {
        emittedArguments = call.args.map((argument) => emitConvertedValue(argument, "double")).join(", ");
      } else {
        emittedArguments = argumentsText();
      }
      return `vexa::${primitiveMethod}(${runtimeArgument}${receiver}${emittedArguments ? `, ${emittedArguments}` : ""})`;
    }
  }

  const resolvedClassMemberMethod = member ? classMethodForMember(member) : null;
  if (member && isDynamicValueExpression(member.object) && !resolvedClassMemberMethod) {
    const calleeMember = call.callee as MemberExpression;
    const key = calleeMember.computed
      ? `vexa::propertyKey(${emitExpression(calleeMember.property)})`
      : cppUtf16String(member.propertyName);
    const dynamicArguments = call.args.map(emitDynamicCallArgument);
    const optional = call.optional || calleeMember.optional;
    const getter = optional ? "dynamicGetOptional" : "dynamicGet";
    const callable = `vexa::${getter}(${emitConvertedValue(member.object, "vexa::Value")}, ${key})`;
    return `vexa::${optional ? "callOptional" : "call"}(${activeRuntimeName}, ${callable}, {${dynamicArguments.join(", ")}})`;
  }

  if (member) {
    const method = resolvedClassMemberMethod;
    if (method) {
      const methodArguments = emitArguments(call.args, method.parameters, methodTemplateBindings(call, method));
      const methodTemplateArguments = cppCallTemplateArguments(call) || inferredMethodTemplateArguments(call, method);
      const classMethod = method.kind === NodeKind.ClassMethodMember ? method as ClassMethodMember : null;
      if (classMethod?.isStatic) {
        const className = staticClassNameForExpression(member.object);
        if (!className) {
          throw new CppEmitError("C++ static methods must be called through their class name");
        }
        return `${cppName(className)}::${cppName(method.name.name)}${methodTemplateArguments}(${withRuntimeArgument(methodArguments)})`;
      }
      if (member.objectName === "super") {
        const currentClass = activeCurrentClassStatement ?? (activeCurrentClassName
          ? activeClassStatements.get(activeCurrentClassName)
          : undefined);
        const baseName = currentClass?.extendsType
          ? parseTypeNameShape(currentClass.extendsType.name).baseName
          : null;
        if (baseName === null) throw new CppEmitError("C++ super method call requires a generated base class");
        return `${cppName(baseName)}::${cppName(method.name.name)}${methodTemplateArguments}(${withRuntimeArgument(methodArguments)})`;
      }
      if (call.typeArguments?.length) {
        return `${emitExpression(member.object)}->${cppName(method.name.name)}${methodTemplateArguments}(${withRuntimeArgument(methodArguments)})`;
      }
      return `${emitExpression(member.object)}->${cppName(method.name.name)}${methodTemplateArguments}(${withRuntimeArgument(methodArguments)})`;
    }
  }

  if (member) {
    const extensionCall = emitExtensionFunctionCall(call, member);
    if (extensionCall) return extensionCall;
  }

  if (calleeName === "setTimeout" || calleeName === "setInterval") {
    if (call.args.length < 1) {
      throw new CppEmitError(`C++ ${calleeName} expects a callback, optional delay, and optional callback arguments`);
    }
    const callback = emitTimerCallback(call.args[0]!, call.args.slice(2));
    const delay = call.args[1] ? `, ${emitExpression(call.args[1])}` : "";
    return `${activeRuntimeName}.${calleeName}(${callback}${delay})`;
  }
  if (calleeName === "clearTimeout" || calleeName === "clearInterval") {
    if (call.args.length !== 1) {
      throw new CppEmitError(`C++ ${calleeName} expects one timer id`);
    }
    return `${activeRuntimeName}.${calleeName}(${emitExpression(call.args[0]!)})`;
  }
  if (calleeName === "readTextFile") {
    if (call.args.length !== 1) {
      throw new CppEmitError("C++ readTextFile expects one path");
    }
    return `vexa::readTextFile(${activeRuntimeName}, vexa::convertValue<std::u16string>(${emitExpression(call.args[0]!)}))`;
  }
  if (calleeName === "writeTextFile") {
    if (call.args.length !== 2) {
      throw new CppEmitError("C++ writeTextFile expects a path and contents");
    }
    return `vexa::writeTextFile(${activeRuntimeName}, vexa::convertValue<std::u16string>(${emitExpression(call.args[0]!)}), vexa::convertValue<std::u16string>(${emitExpression(call.args[1]!)}))`;
  }
  if (calleeName === "commandLineArguments") {
    if (call.args.length !== 0) {
      throw new CppEmitError("C++ commandLineArguments expects no arguments");
    }
    return `vexa::commandLineArguments(${activeRuntimeName})`;
  }
  if (calleeName === "import") {
    if (call.args.length !== 1) {
      throw new CppEmitError("C++ dynamic import expects one module specifier");
    }
    return `vexa::dynamicImportUnavailable(${activeRuntimeName}, vexa::toString(${emitExpression(call.args[0]!)}))`;
  }
  if (calleeName === "nativeStatPath" || calleeName === "nativeReadDirectory") {
    if (call.args.length !== 1) {
      throw new CppEmitError(`C++ ${calleeName} expects one path`);
    }
    return `vexa::${calleeName}(${activeRuntimeName}, vexa::convertValue<std::u16string>(${emitExpression(call.args[0]!)}))`;
  }
  if (calleeName === "nativeCreateDirectory" || calleeName === "nativeRemovePath") {
    if (call.args.length !== 2) {
      throw new CppEmitError(`C++ ${calleeName} expects a path and a recursive flag`);
    }
    return `vexa::${calleeName}(${activeRuntimeName}, vexa::convertValue<std::u16string>(${emitExpression(call.args[0]!)}), vexa::convertValue<bool>(${emitExpression(call.args[1]!)}))`;
  }
  if (calleeName === "nativeCopyFile") {
    if (call.args.length !== 2) {
      throw new CppEmitError("C++ nativeCopyFile expects source and target paths");
    }
    return `vexa::nativeCopyFile(${activeRuntimeName}, vexa::convertValue<std::u16string>(${emitExpression(call.args[0]!)}), vexa::convertValue<std::u16string>(${emitExpression(call.args[1]!)}))`;
  }
  if (calleeName === "nativeRunCommandCapture") {
    if (call.args.length !== 3) {
      throw new CppEmitError("C++ nativeRunCommandCapture expects a command, arguments, and working directory");
    }
    return `vexa::nativeRunCommandCapture(${activeRuntimeName}, vexa::toString(${emitExpression(call.args[0]!)}), vexa::convertValue<vexa::ArrayObject<vexa::Text>*>(${emitExpression(call.args[1]!)}), vexa::toString(${emitExpression(call.args[2]!)}))`;
  }
  if (calleeName === "nativeRunTask") {
    if (call.args.length !== 1) {
      throw new CppEmitError("C++ nativeRunTask expects one task");
    }
    return `vexa::nativeRunTask(${emitExpression(call.args[0]!)})`;
  }
  if (calleeName === "nativeEnvironmentVariable") {
    if (call.args.length !== 1) {
      throw new CppEmitError("C++ nativeEnvironmentVariable expects one name");
    }
    return `vexa::nativeEnvironmentVariable(${activeRuntimeName}, vexa::toString(${emitExpression(call.args[0]!)}))`;
  }
  const runtimeGlobals = new Set([
    "String", "Number", "Boolean", "BigInt", "Error", "parseInt", "parseFloat", "isNaN", "isFinite",
    "encodeURIComponent", "decodeURIComponent",
  ]);
  if (calleeName && runtimeGlobals.has(calleeName)) {
    if (calleeName === "BigInt") return `vexa::makeBigInt(${argumentsText()})`;
    return `vexa::${cppName(calleeName)}(${argumentsText()})`;
  }
  if (calleeName && activeImplicitReceiverExtensionIdentifiers.has(call.callee as Node)) {
    const receiverName = activeImplicitReceiverExtensionIdentifiers.get(call.callee as Node)!;
    let extension: FunctionStatement | undefined;
    for (const statement of activeExtensionFunctions.get(receiverName) ?? []) {
      if (statement.name.name === calleeName) {
        extension = statement;
        break;
      }
    }
    if (!extension) {
      throw new CppEmitError(`C++ cannot resolve implicit extension call '${calleeName}'`);
    }
    const methodArguments = emitCallArguments(call, extension.parameters);
    return `${cppName(extensionCppName(extension))}${cppCallTemplateArguments(call)}(${activeThisExpression}${methodArguments ? `, ${methodArguments}` : ""})`;
  }
  const currentClass = activeCurrentClassStatement ?? (activeCurrentClassName
    ? activeClassStatements.get(activeCurrentClassName)
    : undefined);
  const currentClassMethod = calleeName && currentClass && !activeLocalNames.has(calleeName)
    ? currentClass.members.find((candidate): candidate is ClassMethodMember =>
        candidate.kind === NodeKind.ClassMethodMember && candidate.name.name === calleeName) ??
      classMethodForName(currentClass, calleeName)
    : null;
  if (calleeName && (
    activeImplicitReceiverIdentifiers.has(call.callee as Node) ||
    activeStaticImplicitReceiverIdentifiers.has(call.callee as Node) ||
    currentClassMethod !== null
  )) {
    const method = currentClassMethod ?? (currentClass
      ? currentClass.members.find((candidate): candidate is ClassMethodMember =>
          candidate.kind === NodeKind.ClassMethodMember && candidate.name.name === calleeName)
      : undefined);
    const methodArguments = emitCallArguments(call, method?.parameters);
    if (method?.isStatic) {
      return `${cppName(activeCurrentClassName!)}::${cppName(calleeName)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(methodArguments)})`;
    }
    if (activeCurrentMethodStatic) {
      throw new CppEmitError("C++ static methods cannot make implicit instance method calls");
    }
    return `${activeThisExpression}->${cppName(calleeName)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(methodArguments)})`;
  }
  const functionStatement = calleeName ? activeFunctionStatements.get(calleeName) : undefined;
  if (calleeName && functionStatement) {
    const bindings = methodTemplateBindings(call, functionStatement);
    const functionArguments = emitArguments(call.args, functionStatement.parameters, bindings);
    const explicitTemplateArguments = cppCallTemplateArguments(call);
    let inferredTemplateArguments = "";
    const typeParameters: TypeParameter[] | undefined = functionStatement.typeParameters;
    if (typeParameters && typeParameters.length > 0) {
      const templateArgumentTypes: string[] = [];
      let hasEveryBinding = true;
      for (const parameter of typeParameters) {
        const binding = bindings.get(parameter.name.name);
        if (binding === undefined) {
          hasEveryBinding = false;
          break;
        }
        templateArgumentTypes.push(cppTypeForDeclaredNameOr(binding, binding));
      }
      if (hasEveryBinding) inferredTemplateArguments = `<${templateArgumentTypes.join(", ")}>`;
    }
    return `${cppName(calleeName)}${explicitTemplateArguments || inferredTemplateArguments}(${withRuntimeArgument(functionArguments)})`;
  }
  if (calleeName && activeClassNames.has(calleeName)) {
    return emitClassConstruction(call.callee, call.args, call);
  }
  const dynamicRecordCallable = call.callee.kind === NodeKind.MemberExpression &&
    activeExpressionTypes.get((call.callee as MemberExpression).object as Node)?.kind === AnalysisTypeKind.Object;
  const resolvedCallableProperty: NativePropertyMember | null = call.callee.kind === NodeKind.MemberExpression
    ? resolvedNativePropertyMember(call.callee)
    : null;
  const dynamicPropertyCallable = resolvedCallableProperty?.kind === "dynamic";
  if (isDynamicValueExpression(call.callee) || dynamicRecordCallable || dynamicPropertyCallable) {
    const dynamicArguments = call.args.map(emitDynamicCallArgument);
    const dynamicCallee = resolvedCallableProperty?.receiver
      ? `vexa::dynamicGet(vexa::convertValue<vexa::Value>(${emitExpression(resolvedCallableProperty.receiver)}), ${emitNativePropertyKey(resolvedCallableProperty)})`
      : emitExpression(call.callee);
    const invocation = `vexa::${call.optional ? "callOptional" : "call"}(${activeRuntimeName}, ${dynamicCallee}, {${dynamicArguments.join(", ")}})`;
    const resultType = emittedCppTypeForExpression(call);
    return resultType && resultType !== "auto" && resultType !== "void" && resultType !== "vexa::Value"
      ? `vexa::convertValue<${resultType}>(${invocation})`
      : invocation;
  }
  return `${emitExpression(call.callee)}(${argumentsText()})`;
}

function isGcObjectExpression(expression: Expr): boolean {
  const emittedType = emittedCppTypeForExpression(expression);
  return classNameForExpression(expression) !== null ||
    emittedType?.endsWith("*") === true ||
    cppTypeForExpression(expression).endsWith("*");
}

function resolvedClassOperator(expression: Expr): ClassMethodMember | null {
  const symbol = activeOperatorResolutions.get(expression as Node);
  return symbol ? activeOperatorMethodsByNameNode.get(symbol.node) ?? null : null;
}

function computedMemberArguments(member: MemberExpression): Expr[] {
  return member.property.kind === NodeKind.CommaExpression
    ? (member.property as CommaExpression).expressions
    : [member.property];
}

function emitClassOperatorCall(method: ClassMethodMember, receiver: Expr, argumentsList: readonly Expr[]): string {
  const argumentTexts: string[] = [];
  for (const argument of argumentsList) argumentTexts.push(emitExpression(argument));
  return emitClassOperatorCallText(method, emitExpression(receiver), argumentTexts);
}

function emitClassOperatorCallText(method: ClassMethodMember, receiverText: string, argumentTexts: readonly string[]): string {
  if (!method.operator) throw new CppEmitError("Resolved C++ operator method is missing its operator kind");
  return `${receiverText}->${cppOperatorMethodName(method.operator, method.parameters)}(${withRuntimeArgument(argumentTexts.join(", "))})`;
}

function emitResolvedBinaryOperator(expression: BinaryExpression): string | null {
  const method: ClassMethodMember | null = resolvedClassOperator(expression);
  if (!method?.operator) return null;
  const call = emitClassOperatorCall(method, expression.left, [expression.right]);
  if (method.operator === expression.operator) return call;
  if (method.operator === "<=>") {
    const operator = expression.operator === "===" ? "==" : expression.operator === "!==" ? "!=" : expression.operator;
    return `(${call} ${operator} 0)`;
  }
  if (method.operator === "==" && (expression.operator === "!=" || expression.operator === "!==")) {
    return `(!${call})`;
  }
  throw new CppEmitError(`C++ emission cannot derive '${expression.operator}' from operator '${method.operator}'`);
}

function emitPointerNullishEquality(expression: BinaryExpression): string | null {
  if (expression.operator !== "==" && expression.operator !== "!=" &&
      expression.operator !== "===" && expression.operator !== "!==") return null;
  const leftNullish = expression.left.kind === NodeKind.NullLiteral || expression.left.kind === NodeKind.UndefinedLiteral;
  const rightNullish = expression.right.kind === NodeKind.NullLiteral || expression.right.kind === NodeKind.UndefinedLiteral;
  if (leftNullish === rightNullish) return null;
  const pointer = leftNullish ? expression.right : expression.left;
  const pointerType = emittedCppTypeForExpression(pointer) ?? cppTypeForExpression(pointer);
  if (!pointerType.endsWith("*")) return null;
  const comparison = expression.operator === "!=" || expression.operator === "!==" ? "!=" : "==";
  return `(vexa::rawPointer(${emitExpression(pointer)}) ${comparison} nullptr)`;
}

function dynamicBinaryHelper(operator: string): string | null {
  switch (operator) {
    case "+": return "add";
    case "-": return "subtract";
    case "*": return "multiply";
    case "/": return "divide";
    case "%": return "remainder";
    case "**": return "power";
    case "&": return "bitwiseAnd";
    case "|": return "bitwiseOr";
    case "^": return "bitwiseXor";
    case "<<": return "shiftLeft";
    case ">>": return "shiftRight";
    case ">>>": return "unsignedShiftRight";
    default: return null;
  }
}

function syntacticDynamicBinaryResultType(operator: string, left: string, right: string): string | null {
  if (left === "vexa::BigInt" && right === "vexa::BigInt") return "vexa::BigInt";
  const leftNumeric = left === "std::int32_t" || left === "std::int64_t" || left === "double";
  const rightNumeric = right === "std::int32_t" || right === "std::int64_t" || right === "double";
  if (!leftNumeric || !rightNumeric) return null;
  if (operator === "&" || operator === "|" || operator === "^" ||
      operator === "<<" || operator === ">>" || operator === ">>>") return "std::int32_t";
  if (left === "double" || right === "double" || operator === "/" || operator === "**") return "double";
  if (left === "std::int64_t" || right === "std::int64_t") return "std::int64_t";
  return "std::int32_t";
}

function isNativeNumericCppType(type: string): boolean {
  return type === "std::int32_t" || type === "std::int64_t" || type === "double";
}

function isDirectNativePrimitiveExpression(operand: Expr): boolean {
  switch (operand.kind) {
    case NodeKind.Identifier:
    case NodeKind.IntLiteral:
    case NodeKind.LongLiteral:
    case NodeKind.FloatLiteral:
    case NodeKind.BooleanLiteral:
      return true;
    case NodeKind.MemberExpression:
    case NodeKind.CallExpression:
      return !isDynamicValueExpression(operand);
    case NodeKind.AsExpression:
    case NodeKind.SatisfiesExpression:
    case NodeKind.NonNullExpression:
      return isDirectNativePrimitiveExpression((operand as AsExpression | SatisfiesExpression | NonNullExpression).expression);
    case NodeKind.UnaryExpression:
      return isDirectNativePrimitiveExpression((operand as UnaryExpression).argument);
    default:
      return false;
  }
}

function isDirectNativeTextExpression(expression: Expr): boolean {
  const type = emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
  if (type !== "vexa::Text") return false;
  switch (expression.kind) {
    case NodeKind.StringLiteral:
    case NodeKind.Identifier:
      return true;
    case NodeKind.MemberExpression:
    case NodeKind.CallExpression:
      return !isDynamicValueExpression(expression);
    case NodeKind.AsExpression:
    case NodeKind.SatisfiesExpression:
    case NodeKind.NonNullExpression:
      return isDirectNativeTextExpression((expression as AsExpression | SatisfiesExpression | NonNullExpression).expression);
    case NodeKind.BinaryExpression: {
      const binary = expression as BinaryExpression;
      return binary.operator === "+" &&
        isDirectNativeTextExpression(binary.left) &&
        isDirectNativeTextExpression(binary.right);
    }
    default:
      return false;
  }
}

function hasStaticPrimitiveOperands(expression: BinaryExpression): boolean {
  const left = emittedCppTypeForExpression(expression.left) ?? cppTypeForExpression(expression.left);
  const right = emittedCppTypeForExpression(expression.right) ?? cppTypeForExpression(expression.right);
  const primitiveTypesMatch = (isNativeNumericCppType(left) && isNativeNumericCppType(right)) ||
    (left === "bool" && right === "bool") ||
    (left === "vexa::Text" && right === "vexa::Text");
  return primitiveTypesMatch &&
    isDirectNativePrimitiveExpression(expression.left) &&
    isDirectNativePrimitiveExpression(expression.right);
}

function emitDynamicBinaryText(operator: string, left: string, right: string): string | null {
  const helper = dynamicBinaryHelper(operator);
  if (!helper) return null;
  const convertedLeft = `vexa::convertValue<vexa::Value>(${left})`;
  const convertedRight = `vexa::convertValue<vexa::Value>(${right})`;
  return helper === "add"
    ? `vexa::add(${activeRuntimeName}, ${left}, ${right})`
    : `vexa::${helper}(${convertedLeft}, ${convertedRight})`;
}

function emitBinary(expression: BinaryExpression): string {
  const overloaded = emitResolvedBinaryOperator(expression);
  if (overloaded) return overloaded;
  const pointerNullishEquality = emitPointerNullishEquality(expression);
  if (pointerNullishEquality) return pointerNullishEquality;
  if (expression.operator === "+" &&
      isDirectNativeTextExpression(expression.left) &&
      isDirectNativeTextExpression(expression.right)) {
    return `(${emitExpression(expression.left)} + ${emitExpression(expression.right)})`;
  }
  if (expression.operator === "+") {
    const leftType = emittedCppTypeForExpression(expression.left) ?? cppTypeForExpression(expression.left);
    const rightType = emittedCppTypeForExpression(expression.right) ?? cppTypeForExpression(expression.right);
    if (leftType === "vexa::Text" || rightType === "vexa::Text") {
      return emitDynamicBinaryText(
        expression.operator,
        emitExpression(expression.left),
        emitExpression(expression.right)
      )!;
    }
  }
  if (expression.operator === "&" || expression.operator === "|" || expression.operator === "^" ||
      expression.operator === "<<" || expression.operator === ">>" || expression.operator === ">>>") {
    return emitDynamicBinaryText(
      expression.operator,
      emitExpression(expression.left),
      emitExpression(expression.right)
    )!;
  }
  const dynamicOperands = !activeHasExpressionTypes ||
    isDynamicValueExpression(expression.left) ||
    isDynamicValueExpression(expression.right) ||
    cppTypeForExpression(expression.left) === "vexa::Value" ||
    cppTypeForExpression(expression.right) === "vexa::Value";
  if (dynamicOperands && dynamicBinaryHelper(expression.operator)) {
    const dynamic = emitDynamicBinaryText(
      expression.operator,
      emitExpression(expression.left),
      emitExpression(expression.right)
    );
    if (dynamic) return dynamic;
  }
  if (isDateExpression(expression.left) && isDateExpression(expression.right)) {
    if (expression.operator === "<" || expression.operator === ">" ||
        expression.operator === "<=" || expression.operator === ">=") {
      return `(${emitExpression(expression.left)}->getTime() ${expression.operator} ${emitExpression(expression.right)}->getTime())`;
    }
    if (expression.operator === "<=>") {
      return `vexa::compare(${emitExpression(expression.left)}->getTime(), ${emitExpression(expression.right)}->getTime())`;
    }
  }
  if (expression.operator === "**") {
    if (cppTypeForExpression(expression) === "vexa::BigInt") {
      return `vexa::pow(${emitExpression(expression.left)}, ${emitExpression(expression.right)})`;
    }
    return `vexa::Math::pow(${emitExpression(expression.left)}, ${emitExpression(expression.right)})`;
  }
  if (expression.operator === "%") {
    return `vexa::remainder(${emitExpression(expression.left)}, ${emitExpression(expression.right)})`;
  }
  if (expression.operator === "??") {
    const leftType = hasValueBackedClassProperty(expression.left)
      ? "vexa::Value"
      : emittedCppTypeForExpression(expression.left) ?? cppTypeForExpression(expression.left);
    const left = emitExpression(expression.left);
    const resultType = emittedCppTypeForExpression(expression);
    if (leftType === "vexa::Value" || resultType === "vexa::Value") {
      const convertedLeft = leftType === "vexa::Value"
        ? left
        : emitConvertedValue(expression.left, "vexa::Value");
      const coalesced = `vexa::nullishCoalesce(${convertedLeft}, [&]() { return ${emitConvertedValue(expression.right, "vexa::Value")}; })`;
      return resultType && resultType !== "vexa::Value"
        ? `vexa::convertValue<${resultType}>(${coalesced})`
        : coalesced;
    }
    if (leftType.endsWith("*")) {
      const pointerType = resultType?.endsWith("*") ? resultType : leftType;
      const convertedLeft = pointerType === leftType
        ? `vexa::rawPointer(${left})`
        : emitConvertedValue(expression.left, pointerType);
      const fallback = emitExpressionWithExpectedCppType(expression.right, pointerType);
      return `vexa::nullishCoalesce(${convertedLeft}, [&]() { return ${fallback}; })`;
    }
    if (leftType === "auto") {
      return `vexa::nullishCoalesce(${left}, [&]() { return ${emitExpression(expression.right)}; })`;
    }
    return `(${left})`;
  }
  if (expression.operator === "&&" || expression.operator === "||") {
    const resultType = emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
    const leftType = emittedCppTypeForExpression(expression.left) ?? cppTypeForExpression(expression.left);
    const rightType = emittedCppTypeForExpression(expression.right) ?? cppTypeForExpression(expression.right);
    if (leftType === "bool" && rightType === "bool") {
      return `(${emitCondition(expression.left)} ${expression.operator} ${emitCondition(expression.right)})`;
    }
    const left = emitConvertedValue(expression.left, "vexa::Value");
    const right = emitConvertedValue(expression.right, "vexa::Value");
    const selectRight = expression.operator === "&&" ? "" : "!";
    const selected = `([&]() { auto __vexa_logical_left = ${left}; return ${selectRight}vexa::Boolean(__vexa_logical_left) ? ${right} : __vexa_logical_left; }())`;
    const logicalResultType = resultType === "bool"
      ? leftType === rightType ? leftType : "vexa::Value"
      : resultType;
    return logicalResultType !== "auto" && logicalResultType !== "vexa::Value"
      ? `vexa::convertValue<${logicalResultType}>(${selected})`
      : selected;
  }
  if (expression.operator === "<=>") {
    const dynamic = isDynamicValueExpression(expression.left) ||
      isDynamicValueExpression(expression.right);
    const left = dynamic ? emitConvertedValue(expression.left, "vexa::Value") : emitExpression(expression.left);
    const right = dynamic ? emitConvertedValue(expression.right, "vexa::Value") : emitExpression(expression.right);
    return `vexa::compare(${left}, ${right})`;
  }
  if (expression.operator === "in" && isArrayExpression(expression.right)) {
    const value = cppTypeForExpression(expression.right) === "vexa::ArrayObject<vexa::Value>*"
      ? emitConvertedValue(expression.left, "vexa::Value")
      : emitExpression(expression.left);
    const receiver = isManagedArrayExpression(expression.right)
      ? emitManagedArrayPointer(expression.right)
      : emitExpression(expression.right);
    return `vexa::includes(${receiver}, ${value})`;
  }
  if (expression.operator === "in" && isRecordExpression(expression.right)) {
    return `vexa::recordHas(${emitExpression(expression.right)}, vexa::propertyKey(${emitExpression(expression.left)}))`;
  }
  if (expression.operator === "in") {
    return `vexa::hasProperty(${activeRuntimeName}, ${emitExpression(expression.right)}, vexa::propertyKey(${emitExpression(expression.left)}))`;
  }
  if ((expression.operator === "is" || expression.operator === "instanceof") && expression.right.kind === NodeKind.Identifier) {
    const targetName = (expression.right as Identifier).name;
    if (targetName === "Error" || targetName === "TypeError" || targetName === "RangeError" || targetName === "SyntaxError") {
      return `vexa::isErrorLike(${emitExpression(expression.left)})`;
    }
    if (targetName === "Map") return `vexa::isMapLike(${emitExpression(expression.left)})`;
    if (targetName === "Set") return `vexa::isSetLike(${emitExpression(expression.left)})`;
    if (targetName === "WeakMap") return `vexa::isWeakMapLike(${emitExpression(expression.left)})`;
    if (targetName === "WeakSet") return `vexa::isWeakSetLike(${emitExpression(expression.left)})`;
    const targetType = cppTypeForDeclaredName(targetName);
    if (targetType?.endsWith("*") &&
      (activeClassNames.has(parseTypeNameShape(targetName).baseName) ||
        activeInterfaceNames.has(parseTypeNameShape(targetName).baseName))) {
      return `vexa::isInstance<${targetType.slice(0, -1)}>(${emitExpression(expression.left)})`;
    }
  }
  const operator = expression.operator === "==="
    ? "=="
    : expression.operator === "!=="
      ? "!="
      : expression.operator;
  if (
    new Set(["<", ">", "<=", ">=", "==", "!="]).has(operator)
  ) {
    if (hasStaticPrimitiveOperands(expression)) {
      return `(${emitExpression(expression.left)} ${operator} ${emitExpression(expression.right)})`;
    }
    const left = emitConvertedValue(expression.left, "vexa::Value");
    const right = emitConvertedValue(expression.right, "vexa::Value");
    if (operator === "==" || operator === "!=") {
      const strict = expression.operator === "===" || expression.operator === "!==";
      const equality = `vexa::${strict ? "strictEquals" : "looseEquals"}(${left}, ${right})`;
      return operator === "!=" ? `(!${equality})` : equality;
    }
    const relation = operator === "<" ? "< 0"
      : operator === ">" ? "> 0"
        : operator === "<=" ? "<= 0"
          : ">= 0";
    return `(vexa::compare(${left}, ${right}) ${relation})`;
  }
  if (operator === "is" || operator === "instanceof") {
    throw new CppEmitError(
      `C++ emission does not support '${operator} ${identifierName(expression.right) ?? expression.right.kind}' yet${activeSourceFilePath ? ` in ${activeSourceFilePath}` : ""}`
    );
  }
  return `(${emitExpression(expression.left)} ${operator} ${emitExpression(expression.right)})`;
}

function emitCondition(expression: Expr): string {
  const emitted = emitExpression(expression);
  const property = resolvedNativePropertyMember(expression);
  if (property?.kind === "dynamic" || property?.kind === "record") {
    return `vexa::Boolean(${emitted})`;
  }
  if (expression.kind === NodeKind.Identifier && activeDynamicValueNames.has((expression as Identifier).name)) {
    return `vexa::Boolean(${emitted})`;
  }
  const type = emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
  return type === "bool" || type === "auto" ? emitted : `vexa::Boolean(${emitted})`;
}

function emitParenthesizedCondition(expression: Expr): string {
  const condition = emitCondition(expression);
  return condition.startsWith("(") && condition.endsWith(")") ? condition : `(${condition})`;
}

function emitExpression(expression: Expr): string {
  return emitExpressionResult(expression, true);
}

function emitDiscardedExpression(expression: Expr): string {
  return emitExpressionResult(expression, false);
}

function emitExpressionResult(expression: Expr, resultUsed: boolean): string {
  switch (expression.kind) {
    case NodeKind.IntLiteral:
    case NodeKind.FloatLiteral:
      return String((expression as IntLiteral | FloatLiteral).value);
    case NodeKind.BigIntLiteral:
      return `vexa::BigInt(${cppString(String((expression as BigIntLiteral).value))})`;
    case NodeKind.LongLiteral:
      return `${String((expression as LongLiteral).value)}LL`;
    case NodeKind.BooleanLiteral:
      return (expression as BooleanLiteral).value ? "true" : "false";
    case NodeKind.StringLiteral:
      return cppText((expression as StringLiteral).value);
    case NodeKind.RegExpLiteral: {
      const literal = expression as RegExpLiteral;
      return `vexa::RegExp(${cppUtf16String(literal.pattern)}, ${cppUtf16String(literal.flags)})`;
    }
    case NodeKind.ArrayLiteral:
      return emitArrayLiteral(expression as unknown as ArrayLiteral);
    case NodeKind.ObjectLiteral:
      return emitObjectLiteral(expression as ObjectLiteral);
    case NodeKind.CommaExpression:
      return `(${(expression as CommaExpression).expressions.map((item) => emitExpression(item)).join(", ")})`;
    case NodeKind.RangeExpression: {
      const range = expression as RangeExpression;
      return `vexa::range(${emitExpression(range.start)}, ${emitExpression(range.end)}, ${range.exclusive ? "true" : "false"})`;
    }
    case NodeKind.NullLiteral:
      return "vexa::Value::null()";
    case NodeKind.UndefinedLiteral:
      return "vexa::Value::undefined()";
    case NodeKind.Identifier: {
      const identifier = expression as Identifier;
      if (identifier.name === "Boolean" && !activeLocalNames.has(identifier.name)) {
        return `[](const auto& __vexa_boolean_value) { return vexa::Boolean(__vexa_boolean_value); }`;
      }
      const functionStatement = !activeLocalNames.has(identifier.name)
        ? activeFunctionStatements.get(identifier.name)
        : undefined;
      if (functionStatement) {
        return emitTopLevelFunctionValue(functionStatement);
      }
      return emitIdentifier(identifier);
    }
    case NodeKind.BinaryExpression:
      return emitBinary(expression as BinaryExpression);
    case NodeKind.UnaryExpression: {
      const unary = expression as UnaryExpression;
      const overloaded: ClassMethodMember | null = resolvedClassOperator(unary);
      if (overloaded) {
        const noArguments: Expr[] = [];
        return emitClassOperatorCall(overloaded, unary.argument, noArguments);
      }
      if (unary.operator === "typeof") {
        if (usesPooledFunctionTypeof(unary)) return cppText("function");
        return `vexa::typeOf(${emitExpression(unary.argument)})`;
      }
      if (unary.operator === "void") return `(static_cast<void>(${emitExpression(unary.argument)}), vexa::Value::undefined())`;
      if (unary.operator === "!") return `(!${emitCondition(unary.argument)})`;
      if (unary.operator === "~") return `vexa::bitwiseNot(${emitConvertedValue(unary.argument, "vexa::Value")})`;
      if (unary.operator === "-" && isDynamicValueExpression(unary.argument)) {
        return `vexa::negate(${emitExpression(unary.argument)})`;
      }
      if (unary.operator === "await") {
        const awaited = emitWithoutAutoAwait(unary.argument);
        return activeAsyncResultType ? `(co_await ${awaited})` : `(${awaited}).get()`;
      }
      if (unary.operator === "go") return emitWithoutAutoAwait(unary.argument);
      if (unary.operator === "yield") {
        if (!activeGeneratorResultType) throw new CppEmitError("C++ yield emission requires a generator callable");
        return `co_yield ${emitExpression(unary.argument)}`;
      }
      if (unary.operator === "delete") {
        const property = resolvedNativePropertyMember(unary.argument);
        if (property?.kind === "record") {
          return `vexa::recordDelete(${emitExpression(property.receiver!)}, ${emitNativePropertyKey(property)})`;
        }
        if (property?.kind === "dynamic") {
          return `vexa::dynamicDelete(${emitExpression(property.receiver!)}, ${emitNativePropertyKey(property)})`;
        }
        throw new CppEmitError("C++ delete emission supports record properties only");
      }
      if (unary.operator === "yield*") {
        throw new CppEmitError(`C++ emission does not support unary '${unary.operator}' yet`);
      }
      return `(${unary.operator}${emitExpression(unary.argument)})`;
    }
    case NodeKind.UpdateExpression: {
      const update = expression as UpdateExpression;
      if (update.argument.kind === NodeKind.MemberExpression) {
        const member = update.argument as MemberExpression;
        if (member.computed && isManagedArrayExpression(member.object)) {
          const receiver = emitManagedArrayPointer(member.object);
          const index = emitExpression(member.property);
          const delta = update.operator === "++" ? "+" : "-";
          const returned = update.prefix ? "__vexa_array_value" : "__vexa_array_current";
          const elementType = managedArrayElementType(cppTypeForExpression(member.object));
          const updated = elementType === "vexa::Value"
            ? emitDynamicBinaryText(delta, "__vexa_array_current", "1") ?? `(__vexa_array_current ${delta} 1)`
            : `(__vexa_array_current ${delta} 1)`;
          const body = `auto* __vexa_array = ${receiver}; auto __vexa_array_index = ${index}; auto __vexa_array_current = vexa::arrayGet(__vexa_array, __vexa_array_index); auto __vexa_array_value = vexa::arraySet(__vexa_array, __vexa_array_index, ${updated});`;
          return resultUsed ? `([&]() { ${body} return ${returned}; }())` : `{ ${body} }`;
        }
      }
      const property = resolvedNativePropertyMember(update.argument);
      if (property) {
        return emitPropertyUpdate(update, property, resultUsed);
      }
      if (isDynamicValueExpression(update.argument)) {
        const current = emitExpression(update.argument);
        const delta = update.operator === "++" ? "+" : "-";
        const updated = emitDynamicBinaryText(delta, "__vexa_update_current", "1")!;
        const returned = update.prefix ? current : "__vexa_update_current";
        const body = `auto __vexa_update_current = ${current}; ${current} = ${updated};`;
        return resultUsed ? `([&]() { ${body} return ${returned}; }())` : `{ ${body} }`;
      }
      const text = `${emitExpression(update.argument)}${update.operator}`;
      return update.prefix ? `${update.operator}${emitExpression(update.argument)}` : text;
    }
    case NodeKind.AssignmentExpression: {
      const assignment = expression as AssignmentExpression;
      const overloaded: ClassMethodMember | null = resolvedClassOperator(assignment);
      if (overloaded?.operator === "[]=" && assignment.left.kind === NodeKind.MemberExpression) {
        const member = assignment.left as MemberExpression;
        return emitClassOperatorCall(overloaded, member.object, [assignment.right, ...computedMemberArguments(member)]);
      }
      if (assignment.left.kind === NodeKind.MemberExpression) {
        const member = assignment.left as MemberExpression;
        if (!member.computed && identifierName(member.property) === "length" && isManagedArrayExpression(member.object)) {
          if (assignment.operator !== "=") {
            throw new CppEmitError("C++ array length only supports direct assignment", assignment);
          }
          const receiver = emitManagedArrayPointer(member.object);
          const size = emitConvertedValue(assignment.right, "double");
          const body = `auto* __vexa_array = ${receiver}; auto __vexa_array_length = ${size}; __vexa_array->resize(static_cast<std::size_t>(__vexa_array_length));`;
          return resultUsed ? `([&]() { ${body} return __vexa_array_length; }())` : `{ ${body} }`;
        }
        if (member.computed && nativeBinaryObjectKind(member.object) === "uint8") {
          if (assignment.operator !== "=") throw new CppEmitError("C++ Uint8Array compound index assignment is not implemented yet", assignment);
          return `${emitExpression(member.object)}->set(${emitExpression(member.property)}, ${emitExpression(assignment.right)})`;
        }
        if (member.computed && isManagedArrayExpression(member.object)) {
          const receiver = emitManagedArrayPointer(member.object);
          const index = emitExpression(member.property);
          if (assignment.operator === "=") {
            return `vexa::arraySet(${receiver}, ${index}, ${emitExpression(assignment.right)})`;
          }
          const binaryOperator = compoundAssignmentBinaryOperator(assignment.operator);
          if (!binaryOperator) throw new CppEmitError(`C++ arrays do not support '${assignment.operator}' assignment yet`);
          const elementType = managedArrayElementType(cppTypeForExpression(member.object));
          const current = "vexa::arrayGet(__vexa_array, __vexa_array_index)";
          const operand = emitExpression(assignment.right);
          const value = elementType === "vexa::Value"
            ? emitDynamicBinaryText(binaryOperator, current, operand) ?? `(${current} ${binaryOperator} ${operand})`
            : `(${current} ${binaryOperator} ${operand})`;
          const body = `auto* __vexa_array = ${receiver}; auto __vexa_array_index = ${index}; auto __vexa_array_value = ${value};`;
          return resultUsed
            ? `([&]() { ${body} return vexa::arraySet(__vexa_array, __vexa_array_index, __vexa_array_value); }())`
            : `{ ${body} vexa::arraySet(__vexa_array, __vexa_array_index, __vexa_array_value); }`;
        }
        if (usesDynamicClassProperty(member) && !resolvedNativePropertyMember(member)) {
          const receiver = `vexa::rawPointer(${emitExpression(member.object)})`;
          const key = member.computed
            ? `vexa::propertyKey(${emitExpression(member.property)})`
            : cppUtf16String((member.property as Identifier).name);
          if (assignment.operator === "=") {
            return member.computed
              ? `vexa::dynamicIndexSet(${receiver}, ${key}, ${emitConvertedValue(assignment.right, "vexa::Value")})`
              : `${receiver}->dynamicSet(${key}, ${emitConvertedValue(assignment.right, "vexa::Value")})`;
          }
          const binaryOperator = compoundAssignmentBinaryOperator(assignment.operator);
          if (binaryOperator) {
            const current = `__vexa_receiver->dynamicGet(__vexa_key)`;
            const value = emitDynamicBinaryText(binaryOperator, current, emitExpression(assignment.right));
            if (value) {
              const body = `auto* __vexa_receiver = ${receiver}; auto __vexa_key = ${key};`;
              return resultUsed
                ? `([&]() { ${body} return __vexa_receiver->dynamicSet(__vexa_key, ${value}); }())`
                : `{ ${body} __vexa_receiver->dynamicSet(__vexa_key, ${value}); }`;
            }
          }
        }
      }
      const property = resolvedNativePropertyMember(assignment.left);
      if (property) {
        return emitPropertyAssignment(assignment, property, resultUsed);
      }
      const compoundOperator = compoundAssignmentBinaryOperator(assignment.operator);
      if (overloaded?.operator === compoundOperator) {
        const target = emitExpression(assignment.left);
        const call = emitClassOperatorCallText(overloaded, "__vexa_compound_target", [emitExpression(assignment.right)]);
        return `vexa::assignWith(${target}, [&](auto __vexa_compound_target) { return ${call}; })`;
      }
      if (assignment.operator === "+=" && isDynamicValueExpression(assignment.left)) {
        return `vexa::addAssign(${activeRuntimeName}, ${emitExpression(assignment.left)}, ${emitExpression(assignment.right)})`;
      }
      if (compoundOperator && isDynamicValueExpression(assignment.left)) {
        const target = emitExpression(assignment.left);
        const value = emitDynamicBinaryText(compoundOperator, "__vexa_compound_current", emitExpression(assignment.right));
        if (value) {
          return `vexa::assignWith(${target}, [&](const vexa::Value& __vexa_compound_current) { return ${value}; })`;
        }
      }
      if (compoundOperator) {
        const targetType = emittedCppTypeForExpression(assignment.left) ?? cppTypeForExpression(assignment.left);
        if (targetType === "vexa::Text") {
          const target = emitExpression(assignment.left);
          const value = emitDynamicBinaryText(
            compoundOperator,
            "__vexa_compound_current",
            emitExpression(assignment.right)
          );
          if (value) {
            return `vexa::assignWith(${target}, [&](const vexa::Text& __vexa_compound_current) { return vexa::convertValue<vexa::Text>(${value}); })`;
          }
        }
      }
      if (compoundOperator && !activeHasExpressionTypes) {
        const target = emitExpression(assignment.left);
        const targetType = assignment.left.kind === NodeKind.Identifier
          ? activeLocalCppTypes.get((assignment.left as Identifier).name) ?? cppTypeForExpression(assignment.left)
          : cppTypeForExpression(assignment.left);
        const value = emitDynamicBinaryText(
          compoundOperator,
          "__vexa_compound_current",
          emitExpression(assignment.right)
        );
        if (value) {
          const converted = targetType !== "auto" && targetType !== "vexa::Value"
            ? `vexa::convertValue<${targetType}>(${value})`
            : value;
          return `vexa::assignWith(${target}, [&](auto __vexa_compound_current) { return ${converted}; })`;
        }
      }
      if (assignment.operator === "=") {
        const targetType = assignment.left.kind === NodeKind.Identifier
          ? activeLocalCppTypes.get((assignment.left as Identifier).name) ?? cppTypeForExpression(assignment.left)
          : cppTypeForExpression(assignment.left);
        const value = targetType !== "auto"
          ? emitConvertedValue(assignment.right, targetType)
          : emitExpression(assignment.right);
        if (assignment.left.kind === NodeKind.Identifier) {
          const sourceName = (assignment.left as Identifier).name;
          const pointee = activeGlobalGcRootTypes.get(sourceName);
          if (pointee && !activeLocalNames.has(sourceName)) {
            const target = emitExpression(assignment.left);
            const body = `auto* __vexa_value = ${value}; ${target} = __vexa_value; ${cppName(sourceName)}__vexa_root = cppgc::Persistent<${pointee}>(${target});`;
            return resultUsed ? `([&]() { ${body} return ${target}; }())` : `{ ${body} }`;
          }
        }
        return `(${emitExpression(assignment.left)} = ${value})`;
      }
      if (assignment.operator === "??=") {
        const targetType = emittedCppTypeForExpression(assignment.left) ?? cppTypeForExpression(assignment.left);
        const fallback = targetType !== "auto"
          ? emitConvertedValue(assignment.right, targetType)
          : emitExpression(assignment.right);
        if (assignment.left.kind === NodeKind.Identifier) {
          const sourceName = (assignment.left as Identifier).name;
          const pointee = activeGlobalGcRootTypes.get(sourceName);
          if (pointee && !activeLocalNames.has(sourceName)) {
            const target = emitExpression(assignment.left);
            const body = `auto* __vexa_value = vexa::nullishAssign(${target}, [&]() { return ${fallback}; }); ${cppName(sourceName)}__vexa_root = cppgc::Persistent<${pointee}>(${target});`;
            return resultUsed ? `([&]() { ${body} return __vexa_value; }())` : `{ ${body} }`;
          }
        }
        return `vexa::nullishAssign(${emitExpression(assignment.left)}, [&]() { return ${fallback}; })`;
      }
      return `(${emitExpression(assignment.left)} ${assignment.operator} ${emitExpression(assignment.right)})`;
    }
    case NodeKind.ConditionalExpression: {
      const conditional = expression as ConditionalExpression;
      const hasNullishBranch = isNullishNodeKind(conditional.consequent.kind) ||
        isNullishNodeKind(conditional.alternate.kind);
      const presentBranch = isNullishNodeKind(conditional.consequent.kind)
        ? conditional.alternate
        : conditional.consequent;
      const presentBranchType = hasNullishBranch
        ? emittedCppTypeForExpression(presentBranch) ?? cppTypeForExpression(presentBranch)
        : null;
      const resultType = activeExpectedExpressionCppType ??
        (hasNullishBranch && presentBranchType === "vexa::Text"
          ? "vexa::Value"
          : emittedCppTypeForExpression(conditional) ?? cppTypeForExpression(conditional));
      const branch = (value: Expr): string => {
        const emittedType = emittedCppTypeForExpression(value);
        if (resultType !== "auto" && emittedType !== resultType) {
          return emitExpressionWithExpectedCppType(value, resultType);
        }
        const emitted = emitExpression(value);
        return resultType.endsWith("*") ? `vexa::rawPointer(${emitted})` : emitted;
      };
      return `(${emitCondition(conditional.test)} ? ${branch(conditional.consequent)} : ${branch(conditional.alternate)})`;
    }
    case NodeKind.CallExpression:
      return maybeAutoAwait(expression, emitCall(expression as CallExpression, resultUsed));
    case NodeKind.NewExpression: {
      const construction = expression as NewExpression;
      const collectionName = identifierName(construction.callee);
      if (collectionName === "Map" || collectionName === "Set" || collectionName === "WeakMap" || collectionName === "WeakSet") {
        return emitNativeCollectionConstruction(construction, collectionName);
      }
      if (collectionName === "Date") {
        if ((construction.args?.length ?? 0) > 1) throw new CppEmitError("C++ Date construction expects zero or one timestamp", construction);
        const argument = construction.args?.[0];
        const emittedArgument = argument
          ? cppTypeForExpression(argument) === "vexa::Value"
            ? `vexa::convertValue<std::u16string>(${emitExpression(argument)})`
            : emitExpression(argument)
          : "";
        return `${activeRuntimeName}.make<vexa::DateObject>(${emittedArgument})`;
      }
      if (collectionName === "URL") {
        if ((construction.args?.length ?? 0) !== 1) throw new CppEmitError("C++ URL construction expects one URL string", construction);
        return `${activeRuntimeName}.make<vexa::URLObject>(vexa::convertValue<std::u16string>(${emitExpression(construction.args![0] as Expr)}))`;
      }
      if (collectionName && isNativeErrorTypeName(collectionName)) {
        if ((construction.args?.length ?? 0) > 1) throw new CppEmitError(`C++ ${collectionName} construction expects zero or one message`, construction);
        const argument = construction.args?.[0];
        return argument ? `vexa::Error(${emitConvertedValue(argument, "vexa::Value")})` : `vexa::Error(std::u16string(u"Error"))`;
      }
      if (collectionName === "RegExp") {
        const args = construction.args ?? [];
        if (args.length < 1 || args.length > 2) throw new CppEmitError("C++ RegExp construction expects a pattern and optional flags", construction);
        const pattern = `vexa::toString(${emitExpression(args[0] as Expr)})`;
        const flags = args[1] ? `vexa::toString(${emitExpression(args[1] as Expr)})` : 'std::u16string(u"")';
        return `vexa::RegExp(${pattern}, ${flags})`;
      }
      if (collectionName === "ArrayBuffer") {
        if ((construction.args?.length ?? 0) !== 1) throw new CppEmitError("C++ ArrayBuffer construction expects a byte length", construction);
        return `${activeRuntimeName}.make<vexa::ArrayBufferObject>(static_cast<std::size_t>(${emitExpression(construction.args![0] as Expr)}))`;
      }
      if (collectionName === "Uint8Array") {
        if ((construction.args?.length ?? 0) !== 1) throw new CppEmitError("C++ Uint8Array construction expects a length, ArrayBuffer, or array", construction);
        const argument = construction.args![0] as Expr;
        const emitted = isManagedArrayExpression(argument) ? emitManagedArrayPointer(argument) : emitExpression(argument);
        return `vexa::makeUint8Array(${activeRuntimeName}, ${emitted})`;
      }
      if (collectionName === "DataView") {
        const args = construction.args ?? [];
        if (args.length < 1 || args.length > 3) throw new CppEmitError("C++ DataView construction expects a buffer and optional offset/length", construction);
        return `vexa::makeDataView(${activeRuntimeName}, ${args.map((argument) => emitExpression(argument)).join(", ")})`;
      }
      if (collectionName === "Array") {
        const args = construction.args ?? [];
        const explicitElementType = construction.typeArguments?.[0]
          ? cppTypeForDeclaredName(construction.typeArguments[0].name)
          : "";
        const expectedElementType = activeExpectedExpressionCppType
          ? managedArrayElementType(activeExpectedExpressionCppType)
          : null;
        let elementType = "vexa::Value";
        if (expectedElementType !== null) elementType = expectedElementType;
        if (explicitElementType.length > 0) elementType = explicitElementType;
        if (args.length === 0) return `${activeRuntimeName}.array<${elementType}>()`;
        if (args.length === 1) {
          return `vexa::arrayWithLength<${elementType}>(${activeRuntimeName}, ${emitExpression(args[0] as Expr)})`;
        }
        return `${activeRuntimeName}.array<${elementType}>({${emitArrayElements(args, elementType)}})`;
      }
      return emitClassConstruction(construction.callee, construction.args ?? [], construction);
    }
    case NodeKind.ArrowFunctionExpression:
      return emitArrowFunction(expression as ArrowFunctionExpression);
    case NodeKind.FunctionExpression:
      return emitFunctionExpression(expression as FunctionExpression);
    case NodeKind.MemberExpression: {
      const member = expression as MemberExpression;
      if (!member.computed && identifierName(member.object) === "process" && member.property.kind === NodeKind.Identifier) {
        return `vexa::process->${cppName((member.property as Identifier).name)}`;
      }
      if (!member.computed && identifierName(member.object) === "super" && member.property.kind === NodeKind.Identifier) {
        const currentClass = activeCurrentClassStatement ?? (activeCurrentClassName
          ? activeClassStatements.get(activeCurrentClassName)
          : undefined);
        const baseClassName = currentClass?.extendsType?.name;
        if (!baseClassName || !activeClassNames.has(baseClassName)) {
          throw new CppEmitError("C++ super member access requires a generated base class");
        }
        return `${activeThisExpression}->${cppName(baseClassName)}::${cppName((member.property as Identifier).name)}`;
      }
      const overloaded: ClassMethodMember | null = resolvedClassOperator(member);
      if (overloaded?.operator === "[]") {
        return emitClassOperatorCall(overloaded, member.object, computedMemberArguments(member));
      }
      const enumName = !member.computed ? identifierName(member.object) : null;
      if (enumName && activeEnumNames.has(enumName) && member.property.kind === NodeKind.Identifier) {
        return `${cppName(enumName)}::${cppName((member.property as Identifier).name)}`;
      }
      const staticField = staticClassFieldForMember(member);
      if (staticField) {
        return `${cppName(staticField.statement.name.name)}::${staticFieldAccessorName(staticField.field)}()`;
      }
      if (!member.computed && identifierName(member.object) === "Math" && member.property.kind === NodeKind.Identifier) {
        return `vexa::Math::${cppName((member.property as Identifier).name)}`;
      }
      if (!member.computed && cppTypeForExpression(member.object) === "vexa::URLObject*" && member.property.kind === NodeKind.Identifier) {
        const propertyName = (member.property as Identifier).name;
        if (new Set(["href", "protocol", "pathname"]).has(propertyName)) {
          return `${activeRuntimeName}.string(${emitExpression(member.object)}->${cppName(propertyName)})`;
        }
      }
      const messageReceiverIsStoredDynamic = member.object.kind === NodeKind.Identifier &&
        activeDynamicValueNames.has((member.object as Identifier).name);
      if (!member.computed && !messageReceiverIsStoredDynamic &&
          emittedCppTypeForExpression(member.object) === "vexa::Error" && identifierName(member.property) === "message") {
        return `${activeRuntimeName}.string(${emitExpression(member.object)}.messageText())`;
      }
      if (!member.computed && identifierName(member.property) === "message" &&
          (messageReceiverIsStoredDynamic || emittedCppTypeForExpression(member.object) === "vexa::Value" ||
            new Set(["auto", "vexa::Value"]).has(cppTypeForExpression(member.object)))) {
        return `vexa::dynamicGet(vexa::convertValue<vexa::Value>(${emitExpression(member.object)}), u"message")`;
      }
      if (!member.computed && identifierName(member.property) === "message") {
        const className = classNameForExpression(member.object);
        const statement = className ? activeClassStatements.get(className) : undefined;
        const baseName = statement?.extendsType ? parseTypeNameShape(statement.extendsType.name).baseName : null;
        if (baseName && isNativeErrorTypeName(baseName)) {
          return `${activeRuntimeName}.string(${emitExpression(member.object)}->messageText())`;
        }
      }
      if (!member.computed && isManagedArrayExpression(member.object) && identifierName(member.property) === "length") {
        const objectType = emittedCppTypeForExpression(member.object) ?? cppTypeForExpression(member.object);
        if (objectType === "vexa::Value") {
          return member.optional
            ? `vexa::dynamicGetOptional(${emitExpression(member.object)}, u"length")`
            : `vexa::arrayLength(${emitExpression(member.object)})`;
        }
        if (member.optional && isManagedArrayExpression(member.object)) {
          const receiver = emitManagedArrayPointer(member.object);
          return `([&]() { auto* __vexa_optional_array = ${receiver}; return __vexa_optional_array ? vexa::convertValue<vexa::Value>(static_cast<double>(__vexa_optional_array->size())) : vexa::Value::undefined(); }())`;
        }
        const receiver = isManagedArrayExpression(member.object)
          ? `${emitManagedArrayPointer(member.object)}->size()`
          : `${emitExpression(member.object)}.size()`;
        return `static_cast<double>(${receiver})`;
      }
      if (!member.computed && isStringExpression(member.object) && identifierName(member.property) === "length") {
        return `static_cast<double>(vexa::stringCodeUnitLength(${emitExpression(member.object)}))`;
      }
      if (member.computed && isStringExpression(member.object)) {
        return `vexa::stringIndex(${emitExpression(member.object)}, ${emitExpression(member.property)})`;
      }
      if (!member.computed && member.optional && identifierName(member.property) === "length") {
        return `vexa::dynamicGetOptional(vexa::convertValue<vexa::Value>(${emitExpression(member.object)}), u"length")`;
      }
      if (!member.computed && nativeCollectionKind(member.object) && identifierName(member.property) === "size") {
        const receiver = emitNativePointerExpression(member.object, nativeCollectionPointerCppType(member.object));
        if (member.optional || isOptionalChainExpression(member.object)) {
          return `([&]() { auto* __vexa_optional_collection = ${receiver}; return __vexa_optional_collection ? vexa::Value(static_cast<double>(__vexa_optional_collection->size())) : vexa::Value::undefined(); }())`;
        }
        return `static_cast<double>(${receiver}->size())`;
      }
      const binaryKind = nativeBinaryObjectKind(member.object);
      if (!member.computed && binaryKind && member.property.kind === NodeKind.Identifier) {
        const propertyName = (member.property as Identifier).name;
        if (propertyName === "byteLength") return `static_cast<double>(${emitExpression(member.object)}->byteLength())`;
        if ((binaryKind === "uint8") && propertyName === "length") return `static_cast<double>(${emitExpression(member.object)}->length())`;
        if ((binaryKind === "uint8" || binaryKind === "dataView") && propertyName === "byteOffset") {
          return `static_cast<double>(${emitExpression(member.object)}->byteOffset())`;
        }
        if ((binaryKind === "uint8" || binaryKind === "dataView") && propertyName === "buffer") {
          return `${emitExpression(member.object)}->buffer()`;
        }
      }
      if (member.computed && binaryKind === "uint8") {
        return `static_cast<double>(${emitExpression(member.object)}->get(static_cast<std::size_t>(${emitExpression(member.property)})))`;
      }
      if (!isOptionalChainExpression(member.object) && !member.optional && isDynamicValueExpression(member.object) && isClassStoredPropertyMember(member)) {
        const receiverClassName = classNameForExpression(member.object)!;
        const receiverType = cppTypeForDeclaredName(receiverClassName);
        if (receiverType?.endsWith("*")) {
          const receiver = `vexa::convertValue<${receiverType}>(${emitExpression(member.object)})`;
          return `${receiver}->${cppName((member.property as Identifier).name)}`;
        }
      }
      const propertyName = !member.computed ? identifierName(member.property) : null;
      const memberInfo: MemberParts | null = propertyName
        ? createMemberParts(member.object, propertyName)
        : null;
      const interfaceProperty: InterfacePropertyMember | null = memberInfo
        ? interfacePropertyForMember(memberInfo)
        : null;
      if (interfaceProperty && !isDynamicValueExpression(member.object)) {
        const receiver = emitExpression(member.object);
        const getter = (target: string) => `${target}->${interfacePropertyGetterName(interfaceProperty.name.name)}()`;
        if (member.optional || isOptionalChainExpression(member.object)) {
          const resultType = emittedCppTypeForExpression(member) ?? interfacePropertyCppType(interfaceProperty) ?? "vexa::Value";
          return emitOptionalPointerAccess(receiver, resultType, getter);
        }
        return getter(receiver);
      }
      if (isDynamicValueExpression(member.object)) {
        const key = member.computed
          ? `vexa::propertyKey(${emitExpression(member.property)})`
          : cppUtf16String((member.property as Identifier).name);
        return member.optional || isOptionalChainExpression(member.object)
          ? `vexa::dynamicGetOptional(${emitExpression(member.object)}, ${key})`
          : `vexa::${member.computed ? "dynamicIndexGet" : "dynamicGet"}(${emitExpression(member.object)}, ${key})`;
      }
      if (member.optional && member.computed && !isManagedArrayExpression(member.object)) {
        return `vexa::dynamicGetOptional(vexa::convertValue<vexa::Value>(${emitExpression(member.object)}), vexa::propertyKey(${emitExpression(member.property)}))`;
      }
      const boundMethod: CallableMember | null = memberInfo
        ? classMethodForMember(memberInfo)
        : null;
      const boundClassMethod = boundMethod?.kind === NodeKind.ClassMethodMember
        ? boundMethod as ClassMethodMember
        : null;
      if (boundMethod && !(boundClassMethod && (
        boundClassMethod.isStatic || boundClassMethod.getterShorthand || boundClassMethod.accessorKind
      ))) {
        return emitBoundMethodValue(memberInfo!, boundMethod);
      }
      const nativeProperty: NativePropertyMember | null = resolvedNativePropertyMember(expression);
      if (nativeProperty?.kind === "extension") {
        return emitNativePropertyGet(nativeProperty, emitExpression(nativeProperty.receiver ?? member.object));
      }
      if (nativeProperty?.kind === "record" || nativeProperty?.kind === "dynamic") {
        const receiver = emitExpression(nativeProperty.receiver ?? member.object);
        if (member.optional) {
          return nativeProperty.kind === "record"
            ? `vexa::recordGetOptional(${receiver}, ${emitNativePropertyKey(nativeProperty)})`
            : `vexa::dynamicGetOptional(${receiver}, ${emitNativePropertyKey(nativeProperty)})`;
        }
        return emitNativePropertyGet(nativeProperty, receiver);
      }
      const classGetter: ClassMethodMember | null = memberInfo
        ? classGetterForMember(memberInfo)
        : null;
      if (classGetter) {
        const receiver = emitExpression(member.object);
        const getter = (target: string) => `${target}->${cppName(classGetter.name.name)}()`;
        if (member.optional || isOptionalChainExpression(member.object)) {
          return emitOptionalPointerAccess(
            receiver,
            emittedCppTypeForExpression(member) ?? cppTypeForExpression(member),
            getter
          );
        }
        return getter(receiver);
      }
      const objectAnalysisType = activeExpressionTypes.get(member.object as Node);
      const enumerableInterface = objectAnalysisType?.kind === AnalysisTypeKind.Named &&
        activeInterfaceNames.has(parseTypeNameShape(objectAnalysisType.name).baseName);
      if (member.computed && (enumerableInterface || objectAnalysisType?.kind === AnalysisTypeKind.Object)) {
        return `vexa::enumerableGet(${activeRuntimeName}, vexa::rawPointer(${emitExpression(member.object)}), vexa::propertyKey(${emitExpression(member.property)}))`;
      }
      const declaredObjectType = declaredTypeNameForExpression(member.object);
      const nativeObjectName = classNameForExpression(member.object);
      const mappedInterface = interfaceStatementForCppType(cppTypeForExpression(member.object)) !== null;
      if (!member.computed && (
        (declaredObjectType && activeInterfaceNames.has(parseTypeNameShape(declaredObjectType).baseName)) ||
        (nativeObjectName && activeInterfaceStatements.has(nativeObjectName)) ||
        mappedInterface
      )) {
        return `vexa::enumerableGet(${activeRuntimeName}, vexa::rawPointer(${emitExpression(member.object)}), ${cppUtf16String((member.property as Identifier).name)})`;
      }
      if (nativeObjectName && activeClassStatements.has(nativeObjectName) && !isClassStoredPropertyMember(member)) {
        const key = member.computed
          ? `vexa::propertyKey(${emitExpression(member.property)})`
          : cppUtf16String((member.property as Identifier).name);
        const receiver = `vexa::rawPointer(${emitExpression(member.object)})`;
        return member.optional || isOptionalChainExpression(member.object)
          ? `vexa::dynamicGetOptional(${receiver}, ${key})`
          : `${receiver}->dynamicGet(${key})`;
      }
      if (!member.computed && (member.optional || isOptionalChainExpression(member.object))) {
        const resultType = emittedCppTypeForExpression(member) ?? cppTypeForExpression(member);
        if (resultType !== "auto") {
          const property = cppName((member.property as Identifier).name);
          return emitOptionalPointerAccess(
            emitExpression(member.object),
            resultType,
            (target) => resultType.endsWith("*")
              ? `vexa::rawPointer(${target}->${property})`
              : `${target}->${property}`
          );
        }
      }
      return member.computed
        ? isManagedArrayExpression(member.object)
          ? member.optional || isOptionalChainExpression(member.object)
            ? (() => {
                const arrayType = managedArrayCppTypeForExpression(member.object);
                const elementType = arrayType ? managedArrayElementType(arrayType) : null;
                const resultType = elementType?.endsWith("*") ? elementType : "vexa::Value";
                const value = `vexa::arrayGet(__vexa_optional_array, ${emitExpression(member.property)})`;
                const converted = resultType === "vexa::Value"
                  ? `vexa::convertValue<vexa::Value>(${value})`
                  : value;
                return `([&]() { auto* __vexa_optional_array = ${emitManagedArrayPointer(member.object)}; return __vexa_optional_array ? ${converted} : vexa::defaultValue<${resultType}>(); }())`;
              })()
            : `vexa::arrayGet(${emitManagedArrayPointer(member.object)}, ${emitExpression(member.property)})`
          : `${emitExpression(member.object)}[${emitExpression(member.property)}]`
        : `${emitExpression(member.object)}${isGcObjectExpression(member.object) ? "->" : "."}${cppName((member.property as Identifier).name)}`;
    }
    case NodeKind.NamedArgument:
      return emitExpression((expression as NamedArgument).value);
    case NodeKind.AsExpression: {
      const source = (expression as AsExpression).expression;
      const resultType = emittedCppTypeForExpression(expression) ?? cppTypeForExpression(expression);
      const sourceType = hasValueBackedClassProperty(source) || isDynamicValueExpression(source)
        ? "vexa::Value"
        : emittedCppTypeForExpression(source) ?? cppTypeForExpression(source);
      return resultType !== "auto" && resultType !== sourceType
        ? emitConvertedValue(source, resultType)
        : emitExpression(source);
    }
    case NodeKind.SatisfiesExpression:
    case NodeKind.NonNullExpression:
      return emitExpression((expression as SatisfiesExpression | NonNullExpression).expression);
    default:
      const sourceLine: number | null = expression.firstToken ? expression.firstToken.range.start.line + 1 : null;
      throw new CppEmitError(
        `C++ emission does not support ${expression.kind} expressions yet${expression.__vexaNativeSourcePath ? ` in ${expression.__vexaNativeSourcePath}` : activeSourceFilePath ? ` in ${activeSourceFilePath}` : ""}${sourceLine ? `:${sourceLine}` : ""}`
      );
  }
}

function bindingValueType(binding: BindingName): string {
  if (binding.kind === NodeKind.Identifier) {
    const mapped = cppTypeForExpression(binding as Identifier);
    return mapped === "auto" ? "vexa::Value" : mapped;
  }
  return binding.kind === NodeKind.ObjectBindingPattern ? "vexa::RecordObject*" : "auto";
}

function introducedBindingNames(binding: BindingName): string[] {
  if (binding.kind === NodeKind.Identifier) return [binding.name];
  const names: string[] = [];
  if (binding.kind === NodeKind.ArrayBindingPattern) {
    for (const element of (binding as ArrayBindingPattern).elements) {
      if (element.kind !== NodeKind.BindingHole) names.push(...introducedBindingNames(element.name));
    }
    return names;
  }
  for (const element of (binding as ObjectBindingPattern).elements) {
    names.push(...introducedBindingNames(element.name));
  }
  return names;
}

function emitDestructuredBindings(
  binding: BindingName,
  source: string,
  lines: string[],
  sourceType: string | null = null
): void {
  if (binding.kind === NodeKind.Identifier) {
    activeLocalNames.add(binding.name);
    if (sourceType && sourceType !== "auto") {
      activeLocalCppTypes.set(binding.name, sourceType);
      if (sourceType === "vexa::Value") activeDynamicValueNames.add(binding.name);
      if (managedArrayElementType(sourceType) !== null) {
        activeGcArrayTypes.set(binding.name, sourceType.slice(0, -1));
      }
    }
    lines.push(`auto ${cppName(binding.name)} = ${source}`);
    return;
  }
  if (binding.kind === NodeKind.ArrayBindingPattern) {
    (binding as ArrayBindingPattern).elements.forEach((element, index) => {
      if (element.kind === NodeKind.BindingHole) return;
      if (element.rest) {
        const restType = sourceType && managedArrayElementType(sourceType) !== null ? sourceType : null;
        emitDestructuredBindings(
          element.name,
          `vexa::slice(${activeRuntimeName}, vexa::arrayPointer(${source}), ${index})`,
          lines,
          restType
        );
      } else {
        const value = `vexa::arrayGet(vexa::arrayPointer(${source}), ${index})`;
        const initialized = element.initializer
          ? `vexa::destructureDefault(${activeRuntimeName}, ${value}, [&]() { return ${emitExpression(element.initializer)}; })`
          : value;
        emitDestructuredBindings(element.name, initialized, lines);
      }
    });
    return;
  }
  const objectElements = (binding as ObjectBindingPattern).elements;
  const excludedKeys = objectElements
    .filter((element) => !element.rest)
    .map((element) => bindingElementPropertyName(element as BindingElement))
    .filter((name): name is string => Boolean(name));
  for (const element of objectElements) {
    if (element.rest) {
      emitDestructuredBindings(
        element.name,
        `vexa::recordRest(${activeRuntimeName}, ${source}, {${excludedKeys.map(cppUtf16String).join(", ")}})`,
        lines,
        "vexa::RecordObject*"
      );
      continue;
    }
    const propertyName = bindingElementPropertyName(element as BindingElement);
    if (!propertyName) throw new CppEmitError("C++ object destructuring requires static property names");
    const annotatedType = element.typeAnnotation
      ? cppTypeForDeclaredName(element.typeAnnotation.name)
      : "";
    const type = annotatedType.length > 0 && annotatedType !== "void"
      ? annotatedType
      : bindingValueType(element.name);
    const propertyValue = sourceType === "vexa::Value"
      ? `vexa::dynamicGet(${source}, ${cppUtf16String(propertyName)})`
      : interfaceStatementForCppType(sourceType) !== null
        ? `vexa::enumerableGet(${activeRuntimeName}, vexa::rawPointer(${source}), ${cppUtf16String(propertyName)})`
        : `vexa::recordGet<vexa::Value>(${activeRuntimeName}, ${source}, ${cppUtf16String(propertyName)})`;
    const value = element.initializer
      ? `vexa::convertValue<${type}>(vexa::destructureDefault(${activeRuntimeName}, ${propertyValue}, [&]() { return ${emitExpression(element.initializer)}; }))`
      : `vexa::convertValue<${type}>(${propertyValue})`;
    emitDestructuredBindings(element.name, value, lines);
  }
}

function emitTypedArrayDestructuredBindings(
  binding: ArrayBindingPattern,
  source: string,
  elementTypes: readonly string[],
  lines: string[]
): void {
  let requiresDynamicBinding = false;
  for (const element of binding.elements) {
    if (element.kind !== NodeKind.BindingHole && (element.rest || element.name.kind !== NodeKind.Identifier)) {
      requiresDynamicBinding = true;
    }
  }
  if (requiresDynamicBinding) {
    emitDestructuredBindings(binding, source, lines);
    return;
  }
  let index = 0;
  for (const element of binding.elements) {
    const elementIndex = index;
    index += 1;
    if (element.kind === NodeKind.BindingHole) continue;
    if (element.name.kind !== NodeKind.Identifier) continue;
    const type = elementTypes[elementIndex] ?? "vexa::Value";
    const name = element.name.name;
    activeLocalNames.add(name);
    activeLocalCppTypes.set(name, type);
    if (type === "vexa::Value") activeDynamicValueNames.add(name);
    const arrayType = managedArrayElementType(type);
    if (arrayType !== null) activeGcArrayTypes.set(name, type.slice(0, -1));
    const interfaceStatement = interfaceStatementForCppType(type);
    let objectName: string | undefined = interfaceStatement ? interfaceStatement.name.name : undefined;
    if (!objectName) {
      for (const candidate of activeClassStatements.keys()) {
        if (cppTypeForDeclaredName(candidate) === type) {
          objectName = candidate;
          break;
        }
      }
    }
    if (objectName) activeGcObjectTypes.set(name, objectName);
    lines.push(`${type} ${cppName(name)} = vexa::convertValue<${type}>(vexa::arrayGet(vexa::arrayPointer(${source}), ${elementIndex}))`);
  }
}

function emitVariable(statement: VarStatement, forInitializer = false): string {
  if (statement.name.kind !== NodeKind.Identifier) {
    if (forInitializer || !statement.initializer) {
      throw new CppEmitError("C++ loop destructuring requires a separate declaration", statement);
    }
    const temporary = `__vexa_destructure_${activeDestructureTemporaryCounter++}`;
    const lines = [`auto ${temporary} = ${emitExpression(statement.initializer)}`];
    const sourceType = emittedCppTypeForExpression(statement.initializer) ?? cppTypeForExpression(statement.initializer);
    emitDestructuredBindings(statement.name, temporary, lines, sourceType);
    return lines.join("; ");
  }
  const sourceName = (statement.name as Identifier).name;
  const name = cppName(sourceName);
  const sharesMutableBinding = (statement.declarationKind === "let" || statement.declarationKind === "var") &&
    activeSharedBindingCandidates.has(sourceName);
  if (!statement.initializer) {
    const declaredTypeName = statement.typeAnnotation?.name;
    const declaredCppType = declaredTypeName ? cppTypeForDeclaredName(declaredTypeName) : "";
    activeLocalNames.add(sourceName);
    if (declaredTypeName) activeLocalDeclaredTypeNames.set(sourceName, declaredTypeName);
    if (declaredCppType.endsWith("*")) {
      const nativeObjectName = canonicalNativeObjectName(declaredTypeName!);
      if (nativeObjectName) activeGcObjectTypes.set(sourceName, nativeObjectName);
      if (managedArrayElementType(declaredCppType) !== null) {
        activeGcArrayTypes.set(sourceName, declaredCppType.slice(0, -1));
      }
    }
    const type = declaredCppType.length > 0 && declaredCppType !== "void" ? declaredCppType : "vexa::Value";
    activeSharedBindingNames.delete(sourceName);
    activeLocalCppTypes.set(sourceName, type);
    if (type === "vexa::Value") activeDynamicValueNames.add(sourceName);
    clearExpressionTypeCaches();
    const storesFunction: boolean = Boolean(type.startsWith("std::function<"));
    const storesSharedMutableValue: boolean = sharesMutableBinding && type !== "vexa::Value";
    if (storesFunction || storesSharedMutableValue) {
      activeSharedBindingNames.add(sourceName);
      const storesPointer: boolean = Boolean(type.endsWith("*"));
      if (storesPointer) {
        const pointeeType: string = String(type.slice(0, -1));
        return `auto ${name} = std::make_shared<cppgc::Persistent<${pointeeType}>>()`;
      }
      return `auto ${name} = std::make_shared<${type}>()`;
    }
    if (type.endsWith("*") && (activeAsyncResultType || activeGeneratorResultType)) {
      const pointeeType: string = String(type.slice(0, -1));
      return `cppgc::Persistent<${pointeeType}> ${name}`;
    }
    return `${type} ${name} = vexa::defaultValue<${type}>()`;
  }
  const declaredTypeName = statement.typeAnnotation?.name;
  const declaredCppType = declaredTypeName ? cppTypeForDeclaredName(declaredTypeName) : "";
  if (declaredTypeName && !declaredCppType) {
    const shape = parseTypeNameShape(declaredTypeName);
    const genericStatement = activeClassStatements.get(shape.baseName) ?? activeInterfaceStatements.get(shape.baseName);
    if (genericStatement?.typeParameters?.length) {
      throw new CppEmitError(
        `C++ emission requires concrete or defaulted type arguments for native generic '${declaredTypeName}'`,
        statement
      );
    }
  }
  let type: string;
  if (forInitializer) {
    type = cppTypeForExpression(statement.initializer);
  } else if (declaredCppType.length === 0) {
    type = "auto";
  } else {
    type = declaredCppType;
  }
  const emittedInitializer = declaredTypeName && activeInterfaceNames.has(parseTypeNameShape(declaredTypeName).baseName) && isRecordExpression(statement.initializer)
    ? emitRecordInterfaceAdaptation(statement.initializer, declaredTypeName)
    : emitExpression(statement.initializer);
  const initializerType = emittedCppTypeForExpression(statement.initializer) ??
    cppTypeForExpression(statement.initializer);
  const initializer = forInitializer && type !== "auto"
    ? `vexa::convertValue<${type}>(${emittedInitializer})`
    : declaredCppType && declaredCppType !== initializerType &&
    !(declaredTypeName && activeInterfaceNames.has(parseTypeNameShape(declaredTypeName).baseName) && isRecordExpression(statement.initializer))
    ? managedArrayElementType(declaredCppType) !== null &&
        (statement.initializer.kind === NodeKind.CallExpression || statement.initializer.kind === NodeKind.ArrayLiteral)
      ? emitExpressionWithExpectedCppType(statement.initializer, declaredCppType)
      : emitConvertedValue(statement.initializer, declaredCppType)
    : emittedInitializer;
  const inferredCallDeclaredType = statement.initializer.kind === NodeKind.CallExpression &&
    (statement.initializer as CallExpression).callee.kind === NodeKind.Identifier
    ? activeFunctionStatements.get(((statement.initializer as CallExpression).callee as Identifier).name)?.returnType?.name
    : undefined;
  const inferredCallCppType = statement.initializer.kind === NodeKind.CallExpression
    ? inferredFunctionCallCppType(statement.initializer as CallExpression)
    : inferredCallDeclaredType
      ? cppTypeForDeclaredName(inferredCallDeclaredType)
      : null;
  const className = declaredCppType && managedArrayElementType(declaredCppType) !== null
    ? null
    : declaredTypeName
    ? canonicalNativeObjectName(declaredTypeName)
    : inferredCallDeclaredType
      ? canonicalNativeObjectName(inferredCallDeclaredType)
      : classNameForExpression(statement.initializer);
  const inferredDeclaredTypeName = declaredTypeName ??
    inferredCallDeclaredType ??
    (statement.initializer.kind === NodeKind.CallExpression
      ? declaredCallResultType(statement.initializer as CallExpression)
      : declaredTypeNameForExpression(statement.initializer));
  activeLocalNames.add(sourceName);
  activeSharedBindingNames.delete(sourceName);
  const actualInitializerType = emittedCppTypeForExpression(statement.initializer);
  const emittedVariableType = declaredCppType.length > 0
    ? declaredCppType
    : actualInitializerType && actualInitializerType !== "auto" ? actualInitializerType : inferredCallCppType;
  if (emittedVariableType && emittedVariableType !== "auto") activeLocalCppTypes.set(sourceName, emittedVariableType);
  if (inferredDeclaredTypeName) activeLocalDeclaredTypeNames.set(sourceName, inferredDeclaredTypeName);
  if (emittedVariableType === "vexa::Value" || (!emittedVariableType && type === "vexa::Value")) {
    activeDynamicValueNames.add(sourceName);
  }
  if (className && emittedVariableType?.endsWith("*")) {
    activeGcObjectTypes.set(sourceName, className);
  }
  const arrayType = declaredCppType && managedArrayElementType(declaredCppType) !== null
    ? declaredCppType
    : actualInitializerType && managedArrayElementType(actualInitializerType) !== null
      ? actualInitializerType
    : inferredCallCppType && managedArrayElementType(inferredCallCppType) !== null
      ? inferredCallCppType
    : declaredTypeName
      ? null
      : managedArrayCppTypeForExpression(statement.initializer);
  if (arrayType && emittedVariableType?.endsWith("*")) {
    activeGcArrayTypes.set(sourceName, arrayType.slice(0, -1));
  }
  clearExpressionTypeCaches();
  if (sharesMutableBinding && emittedVariableType && emittedVariableType !== "vexa::Value") {
    activeSharedBindingNames.add(sourceName);
    const storesPointer: boolean = Boolean(emittedVariableType.endsWith("*"));
    if (storesPointer) {
      const pointeeType: string = String(emittedVariableType.slice(0, -1));
      return `auto ${name} = std::make_shared<cppgc::Persistent<${pointeeType}>>(${initializer})`;
    }
    return `auto ${name} = std::make_shared<std::remove_cvref_t<decltype(${initializer})>>(${initializer})`;
  }
  if (emittedVariableType?.endsWith("*") && (activeAsyncResultType || activeGeneratorResultType)) {
    return `cppgc::Persistent<${emittedVariableType.slice(0, -1)}> ${name}(${initializer})`;
  }
  return `${type} ${name} = ${initializer}`;
}

function emitBlock(block: BlockStatement, indent: string, trailingStatement?: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousDeclaredTypeNames = new Map(activeLocalDeclaredTypeNames);
  const previousLocalCppTypes = new Map(activeLocalCppTypes);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  const previousGcArrayTypes = new Map(activeGcArrayTypes);
  const previousDynamicValueNames = new Set(activeDynamicValueNames);
  const previousSharedBindingNames = new Set(activeSharedBindingNames);
  try {
    const childIndent = `${indent}  `;
    const lines: string[] = [];
    for (const statement of block.body) {
      const emitted = emitStatement(statement, childIndent);
      if (!emitted) continue;
      for (const preambleLine of emitStatementPreamble(statement, childIndent)) {
        lines.push(preambleLine);
      }
      lines.push(emitted);
    }
    if (trailingStatement) lines.push(`${childIndent}${trailingStatement}`);
    return lines.length > 0 ? `{\n${lines.join("\n")}\n${indent}}` : "{}";
  } finally {
    activeLocalNames = previousLocalNames;
    activeLocalDeclaredTypeNames = previousDeclaredTypeNames;
    activeLocalCppTypes = previousLocalCppTypes;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeSharedBindingNames = previousSharedBindingNames;
  }
}

function emitStatementPreamble(statement: Statement, indent: string): string[] {
  if (!activeEmitSourceLocations) return [];
  const position = statement.firstToken?.range.start;
  const statementSourcePath = statement.__vexaNativeSourcePath;
  const sourcePath = typeof statementSourcePath === "string" ? statementSourcePath : activeSourceFilePath;
  const file = sourcePath ? cppUtf16String(sourcePath) : 'u""';
  let line = 0.0;
  let column = 0.0;
  if (position) {
    line = position.line + 1.0;
    column = position.column + 1.0;
  }
  return [`${indent}VEXA_NATIVE_SOURCE(${activeRuntimeName}, ${file}, ${line}, ${column});`];
}

function emitBody(statement: Statement, indent: string): string {
  return statement.kind === NodeKind.BlockStatement
    ? emitBlock(statement as BlockStatement, indent)
    : emitBlock(new BlockStatement([statement]), indent);
}

function emitLoopBody(statement: Statement, indent: string, label?: string): string {
  const breakBoundary: ControlBoundary = { finallyDepth: activeFinallyProtectedDepth, usesSignal: false };
  const continueBoundary: ControlBoundary = { finallyDepth: activeFinallyProtectedDepth, usesSignal: false };
  activeBreakBoundaries.push(breakBoundary);
  activeContinueBoundaries.push(continueBoundary);
  try {
    const body = emitBody(statement, `${indent}  `);
    if (!breakBoundary.usesSignal && !continueBoundary.usesSignal && !label) return body;
    return [
      "{",
      `${indent}  try ${body}`,
      ...(continueBoundary.usesSignal
        ? [`${indent}  catch (const vexa::ContinueSignal&) { continue; }`]
        : []),
      ...(breakBoundary.usesSignal
        ? [`${indent}  catch (const vexa::BreakSignal&) { break; }`]
        : []),
      ...(label ? [
        `${indent}  catch (const vexa::LabeledContinueSignal& __vexa_signal) { if (__vexa_signal.label() == ${cppUtf16String(label)}) continue; throw; }`,
        `${indent}  catch (const vexa::LabeledBreakSignal& __vexa_signal) { if (__vexa_signal.label() == ${cppUtf16String(label)}) break; throw; }`,
      ] : []),
      `${indent}}`,
    ].join("\n");
  } finally {
    activeBreakBoundaries.pop();
    activeContinueBoundaries.pop();
  }
}

function emitFor(statement: ForStatement, indent: string, label?: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousLocalCppTypes = new Map(activeLocalCppTypes);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  const previousGcArrayTypes = new Map(activeGcArrayTypes);
  const previousDynamicValueNames = new Set(activeDynamicValueNames);
  try {
    if (statement.iterationKind || statement.iterator || statement.iterable) {
      if ((statement.iterationKind !== "of" && statement.iterationKind !== "in") || !statement.iterator || !statement.iterable) {
        throw new CppEmitError("C++ emission supports Vexa for-in/for-of loops only", statement);
      }
      const iteratorBinding = statement.iterator.kind === NodeKind.VarStatement
        ? (statement.iterator as VarStatement).name
        : statement.iterator as BindingName;
      if (statement.iterationKind === "in") {
        const iterable = emitExpression(statement.iterable);
        const iterableType = emittedCppTypeForExpression(statement.iterable) ?? cppTypeForExpression(statement.iterable);
        const range = iterableType === "vexa::Value"
          ? `vexa::objectKeys(${iterable})`
          : `vexa::objectKeys(vexa::rawPointer(${iterable}))`;
        if (iteratorBinding.kind !== NodeKind.Identifier) {
          throw new CppEmitError("C++ for-in object keys require an identifier binding", statement);
        }
        activeLocalNames.add(iteratorBinding.name);
        clearExpressionTypeCaches();
        return `${indent}for (auto ${cppName(iteratorBinding.name)} : ${range}) ${emitLoopBody(statement.body, indent, label)}`;
      }
      const iterableCppType = emittedCppTypeForExpression(statement.iterable) ??
        cppTypeForExpression(statement.iterable);
      const collection = nativeCollectionKind(statement.iterable) ??
        (iterableCppType.startsWith("vexa::MapObject<") ? "map" :
          iterableCppType.startsWith("vexa::SetObject<") ? "set" : null);
      const stringIterable = isStringExpression(statement.iterable);
      const deferredNativeArray = !stringIterable && (iterableCppType === "auto" || iterableCppType === "vexa::Value");
      if (!stringIterable && !isArrayExpression(statement.iterable) && !isGeneratorExpression(statement.iterable) && collection !== "map" && collection !== "set" && !deferredNativeArray) {
        const sourcePath = statement.__vexaNativeSourcePath;
        throw new CppEmitError(
          `C++ for-of emission does not support iterable '${statement.iterable.kind}' with type '${cppTypeForExpression(statement.iterable)}'${sourcePath ? ` in ${sourcePath}` : ""}`,
          statement
        );
      }
      const iterable = emitExpression(statement.iterable);
      const nativeCollectionReceiver = collection
        ? emitNativePointerExpression(statement.iterable, nativeCollectionPointerCppType(statement.iterable))
        : iterable;
      const range = stringIterable
        ? `vexa::stringCharacters(${activeRuntimeName}, ${iterable})`
        : collection === "map"
        ? `*vexa::mapEntries(${activeRuntimeName}, ${nativeCollectionReceiver})`
        : collection === "set"
          ? `*vexa::setValues(${activeRuntimeName}, ${nativeCollectionReceiver})`
          : deferredNativeArray
            ? `vexa::dynamicIterationRange(${activeRuntimeName}, ${iterable})`
            : isManagedArrayExpression(statement.iterable)
              ? `*vexa::arrayPointer(${iterable})`
            : iterable;
      if (iteratorBinding.kind === NodeKind.Identifier) {
        activeLocalNames.add(iteratorBinding.name);
        const elementType = stringIterable
          ? "vexa::Text"
          : deferredNativeArray
            ? "vexa::Value"
            : managedArrayElementType(iterableCppType);
        if (elementType) activeLocalCppTypes.set(iteratorBinding.name, elementType);
        if (elementType === "vexa::Value") activeDynamicValueNames.add(iteratorBinding.name);
        clearExpressionTypeCaches();
        return `${indent}for (auto ${cppName(iteratorBinding.name)} : ${range}) ${emitLoopBody(statement.body, indent, label)}`;
      }
      const temporary = `__vexa_loop_binding_${activeDestructureTemporaryCounter++}`;
      const bindingLines: string[] = [];
      const mapTypes: string[] | null = collection === "map"
        ? cppTemplateArguments(iterableCppType, "vexa::MapObject<")
        : null;
      if (mapTypes && iteratorBinding.kind === NodeKind.ArrayBindingPattern) {
        const arrayBinding = iteratorBinding as ArrayBindingPattern;
        emitTypedArrayDestructuredBindings(arrayBinding, temporary, mapTypes, bindingLines);
      } else {
        emitDestructuredBindings(iteratorBinding, temporary, bindingLines);
      }
      if (deferredNativeArray) {
        for (const name of introducedBindingNames(iteratorBinding)) {
          activeLocalCppTypes.set(name, "vexa::Value");
          activeDynamicValueNames.add(name);
        }
      }
      clearExpressionTypeCaches();
      const body = emitStatement(statement.body, `${indent}  `);
      return [
        `${indent}for (auto ${temporary} : ${range}) {`,
        ...bindingLines.map((line) => `${indent}  ${line};`),
        body,
        `${indent}}`,
      ].join("\n");
    }
    const initializer = statement.initializer
      ? statement.initializer.kind === NodeKind.VarStatement
        ? emitVariable(statement.initializer as VarStatement, true)
        : emitExpression(statement.initializer as Expr)
      : "";
    const condition = statement.condition ? emitCondition(statement.condition) : "";
    const compactCondition = condition.startsWith("(") && condition.endsWith(")") ? condition.slice(1, -1) : condition;
    return `${indent}for (${initializer}; ${compactCondition}; ${statement.update ? emitExpression(statement.update) : ""}) ${emitLoopBody(statement.body, indent, label)}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeLocalCppTypes = previousLocalCppTypes;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
  }
}

function appendSwitchCases(
  lines: string[],
  statement: SwitchStatement,
  indent: string,
  label: (index: number) => string
): void {
  statement.cases.forEach((switchCase, index) => {
    lines.push(`${indent}  ${label(index)}:`);
    if (switchCase.consequent.length === 0) return;
    lines.push(`${indent}  {`);
    for (const consequent of switchCase.consequent) {
      lines.push(emitStatement(consequent, `${indent}    `));
    }
    lines.push(`${indent}  }`);
  });
}

function emitSwitchBody(statement: SwitchStatement, indent: string): string {
  const discriminantType = activeExpressionTypes.get(statement.discriminant as Node);
  const mappedType = discriminantType ? cppTypeForAnalysisType(discriminantType) : null;
  const switchType: string = mappedType ?? "";
  if (new Set(["std::int32_t", "std::int64_t", "bool"]).has(switchType)) {
    const lines = [`${indent}switch (${emitExpression(statement.discriminant)}) {`];
    appendSwitchCases(lines, statement, indent, (index) => {
      const switchCase = statement.cases[index]!;
      return switchCase.test ? `case ${emitExpression(switchCase.test)}` : "default";
    });
    lines.push(`${indent}}`);
    return lines.join("\n");
  }

  const stringCases: Array<{ key: string; body: string }> = [];
  let allCasesAreStrings = true;
  statement.cases.forEach((switchCase, index) => {
    if (!switchCase.test) return;
    if (switchCase.test.kind !== NodeKind.StringLiteral) {
      allCasesAreStrings = false;
      return;
    }
    stringCases.push({
      key: (switchCase.test as StringLiteral).value,
      body: `__VEXA_CASE_NAME__ = ${index};`,
    });
  });

  const temporaryIndex = activeSwitchTemporaryCounter++;
  const valueName = `__vexa_switch_value_${temporaryIndex}`;
  const caseName = `__vexa_switch_case_${temporaryIndex}`;
  const defaultIndex = statement.cases.findIndex((switchCase) => !switchCase.test);
  const lines = [
    `${indent}{`,
    `${indent}  auto ${valueName} = ${emitExpression(statement.discriminant)};`,
    `${indent}  std::int32_t ${caseName} = ${defaultIndex};`,
  ];
  if (allCasesAreStrings && stringCases.length > 0) {
    const dispatchedCases: Array<{ key: string; body: string }> = [];
    for (const entry of stringCases) {
      dispatchedCases.push({
        key: entry.key,
        body: entry.body.replace("__VEXA_CASE_NAME__", caseName),
      });
    }
    lines.push(emitStringKeyDispatch(
      dispatchedCases,
      `${indent}  `,
      valueName,
      "value"
    ));
    lines.push(`${indent}  switch (${caseName}) {`);
    appendSwitchCases(lines, statement, `${indent}  `, (index) =>
      statement.cases[index]!.test ? `case ${index}` : "default"
    );
    lines.push(`${indent}  }`);
    lines.push(`${indent}}`);
    return lines.join("\n");
  }
  let conditionIndex = 0;
  statement.cases.forEach((switchCase, index) => {
    if (!switchCase.test) return;
    lines.push(
      `${indent}  ${conditionIndex++ === 0 ? "if" : "else if"} (${valueName} == ${emitExpression(switchCase.test)}) { ${caseName} = ${index}; }`
    );
  });
  lines.push(`${indent}  switch (${caseName}) {`);
  appendSwitchCases(lines, statement, `${indent}  `, (index) =>
    statement.cases[index]!.test ? `case ${index}` : "default"
  );
  lines.push(`${indent}  }`);
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function emitSwitch(statement: SwitchStatement, indent: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  const previousGcArrayTypes = new Map(activeGcArrayTypes);
  const breakBoundary: ControlBoundary = { finallyDepth: activeFinallyProtectedDepth, usesSignal: false };
  activeBreakBoundaries.push(breakBoundary);
  try {
    const body = emitSwitchBody(statement, `${indent}  `);
    if (!breakBoundary.usesSignal) return body;
    return [
      `${indent}{`,
      `${indent}  try {`,
      body,
      `${indent}  } catch (const vexa::BreakSignal&) {}`,
      `${indent}}`,
    ].join("\n");
  } finally {
    activeBreakBoundaries.pop();
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
  }
}

function emitTryCatch(statement: TryStatement, indent: string, temporaryIndex: number): string {
  const lines: string[] = [];
  if (!statement.catchClause) {
    lines.push(`${indent}${emitBlock(statement.tryBlock, indent)}`);
  } else {
    lines.push(`${indent}try ${emitBlock(statement.tryBlock, indent)}`);
    const caughtName = `__vexa_caught_error_${temporaryIndex}`;
    const parameter = statement.catchClause.parameter;
    const previousLocalNames = new Set(activeLocalNames);
    if (parameter) activeLocalNames.add(parameter.name);
    try {
      const catchBody = (binding: string): string => {
        const body = emitBlock(statement.catchClause!.body, indent);
        if (!parameter) return body;
        return body === "{}"
          ? `{ ${binding} }`
          : body.replace("{\n", `{\n${indent}  ${binding}\n`);
      };
      const rejectedBinding = parameter ? `auto ${cppName(parameter.name)} = ${caughtName}.reason();` : "";
      const nativeBinding = parameter
        ? `auto ${cppName(parameter.name)} = ${activeRuntimeName}.string(vexa::exceptionText(${caughtName}));`
        : "";
      lines.push(`${indent}catch (const vexa::RejectedValue& ${caughtName}) ${catchBody(rejectedBinding)}`);
      lines.push(`${indent}catch (const std::exception& ${caughtName}) ${catchBody(nativeBinding)}`);
    } finally {
      activeLocalNames = previousLocalNames;
    }
  }
  return lines.join("\n");
}

function emitTry(statement: TryStatement, indent: string): string {
  const temporaryIndex = activeExceptionTemporaryCounter++;
  if (!statement.finallyBlock) return emitTryCatch(statement, indent, temporaryIndex);

  const pendingName = `__vexa_pending_completion_${temporaryIndex}`;
  activeFinallyProtectedDepth++;
  let protectedBody: string;
  try {
    protectedBody = emitTryCatch(statement, `${indent}    `, temporaryIndex);
  } finally {
    activeFinallyProtectedDepth--;
  }
  const finallyBody = emitBlock(statement.finallyBlock, `${indent}  `);
  return [
    `${indent}{`,
    `${indent}  std::exception_ptr ${pendingName};`,
    `${indent}  try {`,
    protectedBody,
    `${indent}  } catch (...) {`,
    `${indent}    ${pendingName} = std::current_exception();`,
    `${indent}  }`,
    `${indent}  ${finallyBody}`,
    `${indent}  if (${pendingName}) std::rethrow_exception(${pendingName});`,
    `${indent}}`,
  ].join("\n");
}

function containsValueReturn(statement: Statement): boolean {
  switch (statement.kind) {
    case NodeKind.ReturnStatement:
      return Boolean((statement as ReturnStatement).expression);
    case NodeKind.BlockStatement:
      return (statement as BlockStatement).body.some(containsValueReturn);
    case NodeKind.IfStatement: {
      const branch = statement as IfStatement;
      return containsValueReturn(branch.thenBranch) || Boolean(branch.elseBranch && containsValueReturn(branch.elseBranch));
    }
    case NodeKind.ForStatement:
      return containsValueReturn((statement as ForStatement).body);
    case NodeKind.WhileStatement:
      return containsValueReturn((statement as WhileStatement).body);
    case NodeKind.DoWhileStatement:
      return containsValueReturn((statement as DoWhileStatement).body);
    default:
      return false;
  }
}

function returnExpressions(statement: Statement): Expr[] {
  switch (statement.kind) {
    case NodeKind.ReturnStatement: {
      const expression = (statement as ReturnStatement).expression;
      return expression ? [expression] : [];
    }
    case NodeKind.BlockStatement: {
      const expressions: Expr[] = [];
      for (const child of (statement as BlockStatement).body) {
        for (const expression of returnExpressions(child)) expressions.push(expression);
      }
      return expressions;
    }
    case NodeKind.IfStatement: {
      const branch = statement as IfStatement;
      const expressions = returnExpressions(branch.thenBranch);
      if (branch.elseBranch) {
        for (const expression of returnExpressions(branch.elseBranch)) expressions.push(expression);
      }
      return expressions;
    }
    case NodeKind.SwitchStatement: {
      const expressions: Expr[] = [];
      for (const switchCase of (statement as SwitchStatement).cases) {
        for (const child of switchCase.consequent) {
          for (const expression of returnExpressions(child)) expressions.push(expression);
        }
      }
      return expressions;
    }
    case NodeKind.TryStatement: {
      const tried = statement as TryStatement;
      const expressions = returnExpressions(tried.tryBlock);
      if (tried.catchClause) {
        for (const expression of returnExpressions(tried.catchClause.body)) expressions.push(expression);
      }
      return expressions;
    }
    default:
      return [];
  }
}

function inferredCallableReturnType(body: BlockStatement): string | null {
  const mapped = returnExpressions(body)
    .map((expression) => cppTypeForExpression(expression))
    .filter((type) => type !== "auto");
  if (mapped.length === 0) return null;
  return mapped.every((type) => type === mapped[0]) ? mapped[0]! : "vexa::Value";
}

function callableReturnType(
  returnType: Identifier | undefined,
  body: BlockStatement,
  owner: Statement,
  callableName: Identifier,
  asyncLike = false
): string {
  if (!returnType) {
    if (!containsValueReturn(body)) return "void";
    const inferred = activeCallableTypes.get(callableName as Node);
    if (inferred?.kind === AnalysisTypeKind.Function) {
      const inferredReturn = inferred.returnType;
      if (inferredReturn.kind === AnalysisTypeKind.Named && inferredReturn.name === "Promise") {
        const valueType = inferredReturn.typeArguments?.[0];
        return valueType ? cppTypeForAnalysisType(valueType) ?? "vexa::Value" : "vexa::Value";
      }
      const mapped = cppTypeForAnalysisType(inferredReturn);
      if (mapped) return mapped;
    }
    const syntacticInference = inferredCallableReturnType(body);
    if (syntacticInference) return syntacticInference;
    return "vexa::Value";
  }
  const returnTypeName = returnType.name;
  let promised = returnTypeName;
  if (returnTypeName.startsWith("Promise<") && returnTypeName.endsWith(">")) {
    promised = returnTypeName.slice("Promise<".length, -1).trim();
  } else {
    promised = "";
  }
  if (promised.length > 0 && !asyncLike) {
    throw new CppEmitError("C++ emission only supports Promise return annotations on async or sync callables", owner);
  }
  let declaredName = returnType.name;
  if (promised.length > 0) declaredName = promised;
  const mapped = cppTypeForDeclaredName(declaredName);
  if (!mapped) {
    throw new CppEmitError(`C++ emission does not support return type '${returnType.name}' yet`, owner);
  }
  return mapped;
}

function callableProducesTask(
  callableName: Identifier,
  returnType: Identifier | undefined,
  asyncLike: boolean,
  body?: BlockStatement
): boolean {
  if (asyncLike || returnType?.name.startsWith("Promise<") || returnType?.name === "Promise") return true;
  const inferred = activeCallableTypes.get(callableName as Node);
  if (inferred?.kind === AnalysisTypeKind.Function && inferred.returnType.kind === AnalysisTypeKind.Named && inferred.returnType.name === "Promise") {
    return true;
  }
  return Boolean(body && returnExpressions(body).some((expression) =>
    (expression.kind === NodeKind.CallExpression || expression.kind === NodeKind.NewExpression) &&
    identifierName((expression as CallExpression | NewExpression).callee) === "Promise"));
}

interface CallableGeneratorInfo {
  resultType: string;
  async: boolean;
}

function callableGeneratorInfo(
  callableName: Identifier,
  returnType: Identifier | undefined,
  generator: boolean,
  asyncLike: boolean,
  owner: Statement
): CallableGeneratorInfo | null {
  if (!generator) return null;
  const callableType = activeCallableTypes.get(callableName as Node);
  const analyzedReturn = callableType?.kind === AnalysisTypeKind.Function ? callableType.returnType : undefined;
  if (
    analyzedReturn?.kind === AnalysisTypeKind.Named &&
    (analyzedReturn.name === "Generator" || analyzedReturn.name === "AsyncGenerator")
  ) {
    const elementType = analyzedReturn.typeArguments?.[0];
    return {
      resultType: elementType ? cppTypeForAnalysisType(elementType) ?? "vexa::Value" : "vexa::Value",
      async: analyzedReturn.name === "AsyncGenerator",
    };
  }
  const fallback = returnType ? cppTypeForDeclaredName(returnType.name) : "";
  if (!fallback) {
    throw new CppEmitError("C++ emission could not map the analyzed generator element type", owner);
  }
  return { resultType: fallback, async: asyncLike };
}

interface DestructuredCallableParameter {
  binding: BindingName;
  source: string;
}

interface CallableParameterInfo {
  text: string;
  names: string[];
  gcTypes: Map<string, string>;
  gcArrayTypes: Map<string, string>;
  pointerTypes: Map<string, string>;
  dynamicNames: Set<string>;
  destructured: DestructuredCallableParameter[];
}

function callableParameters(
  parameters: readonly FunctionParameter[],
  owner: Statement | undefined,
  allowDefaults = true,
  allowInferredTypes = false
): CallableParameterInfo {
  const names: string[] = [];
  const gcTypes = new Map<string, string>();
  const gcArrayTypes = new Map<string, string>();
  const pointerTypes = new Map<string, string>();
  const dynamicNames = new Set<string>();
  const destructured: DestructuredCallableParameter[] = [];
  const text = parameters.map((parameter, parameterIndex) => {
    if (parameter.name.kind !== NodeKind.Identifier) {
      const source = `__vexa_parameter_${parameterIndex}`;
      names.push(source, ...bindingIdentifiers(parameter.name).map((identifier) => identifier.name));
      destructured.push({ binding: parameter.name, source });
      return `${allowInferredTypes ? "auto" : "vexa::Value"} ${source}`;
    }
    if (
      parameter.thisParameter
    ) {
      const reason = parameter.rest
          ? `rest parameter '${(parameter.name as Identifier).name}'`
          : parameter.thisParameter
            ? "explicit this parameter"
            : `optional parameter '${(parameter.name as Identifier).name}' without a default`;
      const ownerSourcePath = owner ? owner.__vexaNativeSourcePath : undefined;
      const sourcePath = ownerSourcePath ?? activeSourceFilePath;
      const sourceLine: number | null = parameter.firstToken ? parameter.firstToken.range.start.line + 1 : null;
      throw new CppEmitError(
        `C++ emission does not support ${reason} in this callable context yet${sourcePath ? ` in ${sourcePath}` : ""}${sourceLine ? `:${sourceLine}` : ""}`,
        owner
      );
    }
    if (parameter.defaultValue && !allowDefaults) {
      throw new CppEmitError("C++ emission does not support defaults in this callable context", owner);
    }
    const sourceName = (parameter.name as Identifier).name;
    const typeName = parameter.typeAnnotation?.name;
    const type = emittedCallableParameterCppType(parameter, allowInferredTypes);
    if (!type || type === "void") {
      throw new CppEmitError(
        `C++ emission does not support parameter '${sourceName}' with type '${typeName ?? "<inferred>"}' yet`,
        owner
      );
    }
    names.push(sourceName);
    const nativeObjectName = typeName ? canonicalNativeObjectName(typeName) : null;
    if (nativeObjectName) gcTypes.set(sourceName, nativeObjectName);
    if (managedArrayElementType(type) !== null) gcArrayTypes.set(sourceName, type.slice(0, -1));
    if (type.endsWith("*")) pointerTypes.set(sourceName, type.slice(0, -1));
    if (type === "vexa::Value") dynamicNames.add(sourceName);
    return `${type} ${cppName(sourceName)}`;
  }).join(", ");
  return { text, names, gcTypes, gcArrayTypes, pointerTypes, dynamicNames, destructured };
}

function emitParameterDestructuring(
  parameters: CallableParameterInfo,
  indent: string
): string[] {
  const lines: string[] = [];
  for (const rawParameter of parameters.destructured) {
    const parameter = rawParameter as DestructuredCallableParameter;
    const declarations: string[] = [];
    emitDestructuredBindings(parameter.binding, parameter.source, declarations);
    lines.push(...declarations.map((declaration) => `${indent}${declaration};`));
  }
  return lines;
}

function injectBlockPreamble(block: string, lines: readonly string[]): string {
  if (lines.length === 0) return block;
  return block.replace("{", `{\n${lines.join("\n")}\n`);
}

function callableSignature(
  name: Identifier,
  parameters: readonly FunctionParameter[],
  returnType: Identifier | undefined,
  body: BlockStatement,
  owner: Statement,
  taskResult: boolean,
  generatorInfo: CallableGeneratorInfo | null,
  emittedName = name.name
): string {
  const resultType = generatorInfo?.resultType ?? callableReturnType(returnType, body, owner, name, taskResult);
  const parameterText = callableParameters(parameters, owner).text;
  const emittedResultType = generatorInfo
    ? `vexa::${generatorInfo.async ? "AsyncGenerator" : "Generator"}<${resultType}>`
    : taskResult
      ? `vexa::Task<${resultType}>`
      : resultType;
  return `${emittedResultType} ${cppName(emittedName)}(${parameterText})`;
}

function withCallableContext(
  parameters: readonly FunctionParameter[],
  className: string | null,
  staticMethod: boolean,
  asyncResultType: string | null,
  generatorResultType: string | null,
  callableResultType: string,
  owner: Statement,
  emit: () => string
): string {
  const previousRuntimeName = activeRuntimeName;
  const previousThisExpression = activeThisExpression;
  const previousClassName = activeCurrentClassName;
  const previousClassStatement = activeCurrentClassStatement;
  const previousMethodStatic = activeCurrentMethodStatic;
  const previousLocalNames = activeLocalNames;
  const previousDeclaredTypeNames = activeLocalDeclaredTypeNames;
  const previousLocalCppTypes = activeLocalCppTypes;
  const previousCallableParameterPointerTypes = activeCallableParameterPointerTypes;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousGcArrayTypes = activeGcArrayTypes;
  const previousDynamicValueNames = activeDynamicValueNames;
  const previousSharedBindingNames = activeSharedBindingNames;
  const previousSharedBindingCandidates = activeSharedBindingCandidates;
  const previousAsyncResultType = activeAsyncResultType;
  const previousGeneratorResultType = activeGeneratorResultType;
  const previousCallableResultType = activeCallableResultType;
  const previousCallableUsesReturnSignal = activeCallableUsesReturnSignal;
  const previousFinallyProtectedDepth = activeFinallyProtectedDepth;
  const previousBreakBoundaries = activeBreakBoundaries;
  const previousContinueBoundaries = activeContinueBoundaries;
  const parameterInfo = callableParameters(parameters, owner);
  activeRuntimeName = currentRuntimeExpression;
  activeThisExpression = "this";
  activeCurrentClassName = className;
  activeCurrentClassStatement = className
    ? owner.kind === NodeKind.ClassStatement
      ? owner as ClassStatement
      : activeClassStatements.get(className) ?? null
    : null;
  activeCurrentMethodStatic = staticMethod;
  activeLocalNames = new Set(parameterInfo.names);
  const localDeclaredTypeNames = new Map<string, string>();
  const localCppTypes = new Map<string, string>();
  for (const parameter of parameters) {
    if (parameter.name.kind === NodeKind.Identifier && parameter.typeAnnotation) {
      localDeclaredTypeNames.set((parameter.name as Identifier).name, parameter.typeAnnotation.name);
    }
    if (parameter.name.kind !== NodeKind.Identifier) continue;
    const type = emittedCallableParameterCppType(parameter, false);
    if (type) localCppTypes.set((parameter.name as Identifier).name, type);
  }
  activeLocalDeclaredTypeNames = localDeclaredTypeNames;
  activeLocalCppTypes = localCppTypes;
  activeCallableParameterPointerTypes = new Map(parameterInfo.pointerTypes);
  activeGcObjectTypes = new Map(parameterInfo.gcTypes);
  activeGcArrayTypes = new Map(parameterInfo.gcArrayTypes);
  activeDynamicValueNames = new Set(parameterInfo.dynamicNames);
  activeSharedBindingNames = new Set();
  activeSharedBindingCandidates = nestedClosureCaptureNames(owner as Node);
  activeAsyncResultType = asyncResultType;
  activeGeneratorResultType = generatorResultType;
  activeCallableResultType = callableResultType;
  activeCallableUsesReturnSignal = false;
  activeFinallyProtectedDepth = 0;
  activeBreakBoundaries = [];
  activeContinueBoundaries = [];
  clearExpressionTypeCaches();
  let result: string;
  try {
    result = emit();
  } finally {
    activeRuntimeName = previousRuntimeName;
    activeThisExpression = previousThisExpression;
    activeCurrentClassName = previousClassName;
    activeCurrentClassStatement = previousClassStatement;
    activeCurrentMethodStatic = previousMethodStatic;
    activeLocalNames = previousLocalNames;
    activeLocalDeclaredTypeNames = previousDeclaredTypeNames;
    activeLocalCppTypes = previousLocalCppTypes;
    activeCallableParameterPointerTypes = previousCallableParameterPointerTypes;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeSharedBindingNames = previousSharedBindingNames;
    activeSharedBindingCandidates = previousSharedBindingCandidates;
    activeAsyncResultType = previousAsyncResultType;
    activeGeneratorResultType = previousGeneratorResultType;
    activeCallableResultType = previousCallableResultType;
    activeCallableUsesReturnSignal = previousCallableUsesReturnSignal;
    activeFinallyProtectedDepth = previousFinallyProtectedDepth;
    activeBreakBoundaries = previousBreakBoundaries;
    activeContinueBoundaries = previousContinueBoundaries;
    clearExpressionTypeCaches();
  }
  return result;
}

function emitCallableReturnBoundary(
  body: string,
  indent: string,
  resultType: string,
  coroutine: boolean
): string {
  if (!activeCallableUsesReturnSignal) {
    if (coroutine || resultType === "void") return body;
    return [
      "{",
      body,
      `${indent}  throw std::runtime_error("VexaScript function completed without returning a value");`,
      `${indent}}`,
    ].join("\n");
  }
  const completion = coroutine ? "co_return" : "return";
  const caughtCompletion = resultType === "void"
    ? `${completion};`
    : `${completion} __vexa_return.value();`;
  return [
    "{",
    `${indent}  try ${body}`,
    `${indent}  catch (const vexa::ReturnSignal<${resultType}>& __vexa_return) { ${caughtCompletion} }`,
    ...(!coroutine && resultType !== "void"
      ? [`${indent}  throw std::runtime_error("VexaScript function completed without returning a value");`]
      : []),
    `${indent}}`,
  ].join("\n");
}

function emitCoroutineCallableBlock(
  body: BlockStatement,
  indent: string,
  trailingStatement: string,
  rootThis: boolean
): string {
  const childIndent = `${indent}  `;
  const roots: string[] = [];
  for (const [sourceName, pointeeType] of activeCallableParameterPointerTypes) {
    roots.push(
      `${childIndent}cppgc::Persistent<${pointeeType}> __vexa_coroutine_root_${cppName(sourceName)}(vexa::rawPointer(${cppName(sourceName)}));`
    );
  }
  const previousThisExpression = activeThisExpression;
  if (rootThis && activeCurrentClassName && !activeCurrentMethodStatic) {
    roots.push(`${childIndent}cppgc::Persistent<${cppName(activeCurrentClassName)}> __vexa_coroutine_self(this);`);
    activeThisExpression = "__vexa_coroutine_self";
  }
  try {
    const emitted = emitBlock(body, indent, trailingStatement);
    return roots.length > 0
      ? emitted.replace("{\n", `{\n${roots.join("\n")}\n`)
      : emitted;
  } finally {
    activeThisExpression = previousThisExpression;
  }
}

function emitAsyncCallableBlock(
  body: BlockStatement,
  indent: string,
  resultType: string,
  rootThis = true
): string {
  const trailing = resultType === "void"
    ? "co_return;"
    : `co_return vexa::defaultValue<${resultType}>();`;
  return emitCoroutineCallableBlock(body, indent, trailing, rootThis);
}

function emitGeneratorCallableBlock(body: BlockStatement, indent: string, resultType: string): string {
  return emitCoroutineCallableBlock(
    body,
    indent,
    `co_return vexa::defaultValue<${resultType}>();`,
    true
  );
}

function validateFunction(statement: FunctionStatement): void {
  if (
    statement.declared ||
    statement.missingBody ||
    statement.operator
  ) {
    throw new CppEmitError(
      "C++ emission supports concrete top-level and extension functions",
      statement
    );
  }
}

function extensionCppName(statement: FunctionStatement): string {
  if (!statement.receiverType) return statement.name.name;
  return `__vexa_extension_${statement.receiverType.name}_${statement.name.name}`;
}

function extensionPropertyCppName(statement: VarStatement, setter = false): string {
  const propertyName = statement.name.kind === NodeKind.Identifier ? statement.name.name : "property";
  return `__vexa_extension_property_${statement.receiverType?.name ?? "Value"}_${propertyName}${setter ? "_set" : ""}`;
}

function extensionReceiverTypeName(statement: FunctionStatement | VarStatement): string | null {
  if (!statement.receiverType) return null;
  const argumentsText = statement.receiverTypeArguments?.length
    ? `<${statement.receiverTypeArguments.map((argument) => argument.name).join(", ")}>`
    : "";
  return `${statement.receiverType.name}${argumentsText}`;
}

function extensionReceiverCppType(statement: FunctionStatement | VarStatement): string | null {
  const typeName = extensionReceiverTypeName(statement);
  return typeName ? cppTypeForDeclaredName(typeName) : null;
}

function emitExtensionProperty(statement: VarStatement): string {
  if (!statement.receiverType || statement.name.kind !== NodeKind.Identifier) {
    throw new CppEmitError("C++ extension properties require an identifier name and receiver type", statement);
  }
  if (!statement.initializer && !statement.accessors?.length) {
    throw new CppEmitError("C++ extension properties require an expression or accessor block", statement);
  }
  return withCppTypeParameters(statement.typeParameters, () => {
    const receiverType = extensionReceiverCppType(statement);
    if (!receiverType || receiverType === "void") {
      throw new CppEmitError(`C++ cannot map extension receiver '${extensionReceiverTypeName(statement)}'`, statement);
    }
    const declaredResult = statement.typeAnnotation
      ? cppTypeForDeclaredName(statement.typeAnnotation.name)
      : "";
    let getter: ClassMethodMember | undefined;
    if (statement.accessors) {
      for (const accessor of statement.accessors) {
        if (accessor.accessorKind === "get") {
          getter = accessor;
          break;
        }
      }
    }
    const analyzedResult = statement.initializer
      ? cppTypeForExpression(statement.initializer)
      : getter?.returnType
        ? cppTypeForDeclaredNameOr(getter.returnType.name, "auto")
        : "auto";
    const resultType = declaredResult && declaredResult !== "void"
      ? declaredResult
      : analyzedResult !== "auto" ? analyzedResult : "auto";
    if (statement.initializer) {
      const noParameters: FunctionParameter[] = [];
      return withCallableContext(
      noParameters,
      statement.receiverType!.name,
      false,
      null,
      null,
      resultType,
      statement,
      () => {
        const previousThisExpression = activeThisExpression;
        activeThisExpression = "__vexa_extension_self";
        activeLocalCppTypes.set("this", receiverType);
        let result: string;
        try {
          result = `${cppTemplatePrefix(statement.typeParameters)}${resultType} ${extensionPropertyCppName(statement)}(${receiverType} __vexa_extension_self) { return ${emitConvertedValue(statement.initializer!, resultType)}; }`;
        } finally {
          activeThisExpression = previousThisExpression;
        }
        return result;
      }
      );
    }
    const emittedAccessors: string[] = [];
    for (const accessor of statement.accessors!) {
      const setter = accessor.accessorKind === "set";
      const accessorResultType = setter ? "void" : resultType;
      const parameterInfo = callableParameters(accessor.parameters, statement);
      emittedAccessors.push(withCallableContext(
        accessor.parameters,
        statement.receiverType!.name,
        false,
        null,
        null,
        accessorResultType,
        statement,
        () => {
          const previousThisExpression = activeThisExpression;
          activeThisExpression = "__vexa_extension_self";
          activeLocalCppTypes.set("this", receiverType);
          try {
            const signature = `${accessorResultType} ${extensionPropertyCppName(statement, setter)}(${receiverType} __vexa_extension_self${parameterInfo.text ? `, ${parameterInfo.text}` : ""})`;
            const body = emitBlock(accessor.body, "  ");
            return `${cppTemplatePrefix(statement.typeParameters)}${signature} ${emitCallableReturnBoundary(body, "", accessorResultType, false)}`;
          } finally {
            activeThisExpression = previousThisExpression;
          }
        }
      ));
    }
    return emittedAccessors.join("\n");
  });
}

function functionSignature(statement: FunctionStatement): string {
  return withCppTypeParameters(statement.typeParameters, () => {
    validateFunction(statement);
    const asyncLike = Boolean(statement.async || statement.sync);
    const generatorInfo = callableGeneratorInfo(
      statement.name,
      statement.returnType,
      Boolean(statement.generator),
      asyncLike,
      statement
    );
    const signature = callableSignature(
      statement.name,
      statement.parameters,
      statement.returnType,
      statement.body,
      statement,
      generatorInfo ? false : callableProducesTask(statement.name, statement.returnType, asyncLike, statement.body),
      generatorInfo,
      extensionCppName(statement)
    );
    if (!statement.receiverType) return signature;
    const receiverType = extensionReceiverCppType(statement);
    if (!receiverType || receiverType === "void") {
      throw new CppEmitError(`C++ cannot map extension receiver '${extensionReceiverTypeName(statement)}'`, statement);
    }
    return signature.replace(
      "(",
      `(${receiverType} __vexa_extension_self${statement.parameters.length > 0 ? ", " : ""}`
    );
  });
}

function emitFunction(statement: FunctionStatement): string {
  return withCppTypeParameters(statement.typeParameters, () => {
  const signature = functionSignature(statement);
  const asyncLike = Boolean(statement.async || statement.sync);
  const generatorInfo = callableGeneratorInfo(
    statement.name,
    statement.returnType,
    Boolean(statement.generator),
    asyncLike,
    statement
  );
  const producesTask = !generatorInfo && callableProducesTask(
    statement.name,
    statement.returnType,
    asyncLike,
    statement.body
  );
  const asyncResultType = !generatorInfo && (statement.async || statement.sync)
    ? callableReturnType(statement.returnType, statement.body, statement, statement.name, true)
    : null;
  const valueResultType = generatorInfo?.resultType ?? asyncResultType ??
    callableReturnType(statement.returnType, statement.body, statement, statement.name, producesTask);
  const callableResultType = producesTask && asyncResultType === null
    ? `vexa::Task<${valueResultType}>`
    : valueResultType;
  return withCallableContext(
    statement.parameters,
    statement.receiverType?.name ?? null,
    false,
    asyncResultType,
    generatorInfo?.resultType ?? null,
    callableResultType,
    statement,
    () => {
      const previousThisExpression = activeThisExpression;
      if (statement.receiverType) {
        activeThisExpression = "__vexa_extension_self";
        const receiverType = extensionReceiverCppType(statement);
        if (receiverType) activeLocalCppTypes.set("this", receiverType);
      }
      try {
      const body = generatorInfo
        ? emitGeneratorCallableBlock(statement.body, "  ", generatorInfo.resultType)
        : asyncResultType !== null
          ? emitAsyncCallableBlock(statement.body, "  ", asyncResultType)
          : emitBlock(statement.body, "  ");
      return `${cppTemplatePrefix(statement.typeParameters)}${signature} ${emitCallableReturnBoundary(body, "", callableResultType, Boolean(generatorInfo || asyncResultType))}`;
      } finally {
        activeThisExpression = previousThisExpression;
      }
    }
  );
  });
}

function primaryConstructorParameterType(parameter: ClassPrimaryConstructorParameter, statement: ClassStatement): string {
  const typeName = parameter.typeAnnotation?.name;
  const mapped = typeName ? cppTypeForDeclaredName(typeName) : null;
  if (mapped && mapped !== "void") return mapped;
  throw new CppEmitError(
    `C++ emission currently requires supported type annotations on class primary constructor properties`,
    statement
  );
}

interface ClassFieldTypeInfo {
  valueType: string;
  storageType: string;
  traced: boolean;
  genericTraced: boolean;
}

function classFieldType(field: ClassFieldMember, statement: ClassStatement): ClassFieldTypeInfo {
  if (
    field.abstract ||
    field.computed
  ) {
    const flags: string[] = [];
    if (field.abstract) flags.push("abstract");
    if (field.computed) flags.push("computed");
    throw new CppEmitError(
      `C++ emission cannot lower ${flags.join("/")} field '${field.name.name}' in class '${statement.name.name}' yet`,
      statement
    );
  }
  const declaredType = field.typeAnnotation?.name;
  const valueType = classFieldValueCppType(field);
  if (!valueType || valueType === "void") {
    throw new CppEmitError(
      declaredType
        ? `C++ emission does not support class field type '${declaredType}' yet`
        : `C++ emission cannot infer class field '${field.name.name}' from its initializer yet`,
      statement
    );
  }
  const genericTraced = Boolean(declaredType && activeCppTypeParameters.has(declaredType));
  const traced = valueType.endsWith("*");
  const storageType = traced ? `cppgc::Member<${valueType.slice(0, -1)}>` : valueType;
  return {
    valueType,
    storageType,
    traced,
    genericTraced,
  };
}

function emitClassFieldInitializer(
  expression: Expr,
  statement: ClassStatement,
  expectedCppType: string,
  staticField = false
): string {
  const previousRuntimeName = activeRuntimeName;
  const previousClassName = activeCurrentClassName;
  const previousMethodStatic = activeCurrentMethodStatic;
  const previousThisExpression = activeThisExpression;
  const previousExpectedExpressionCppType = activeExpectedExpressionCppType;
  activeRuntimeName = currentRuntimeExpression;
  activeCurrentClassName = statement.name.name;
  activeCurrentMethodStatic = staticField;
  activeThisExpression = staticField ? cppName(statement.name.name) : "this";
  activeExpectedExpressionCppType = expectedCppType;
  let result: string;
  try {
    result = emitExpressionWithExpectedCppType(expression, expectedCppType);
  } finally {
    activeRuntimeName = previousRuntimeName;
    activeCurrentClassName = previousClassName;
    activeCurrentMethodStatic = previousMethodStatic;
    activeThisExpression = previousThisExpression;
    activeExpectedExpressionCppType = previousExpectedExpressionCppType;
  }
  return result;
}

interface StaticClassField {
  statement: ClassStatement;
  field: ClassFieldMember;
}

function staticClassFieldForMember(member: MemberExpression): StaticClassField | null {
  if (member.computed || member.property.kind !== NodeKind.Identifier) return null;
  const className = identifierName(member.object);
  const statement = className ? activeClassStatements.get(className) : undefined;
  if (!statement) return null;
  const propertyName = (member.property as Identifier).name;
  const field = statement.members.find((candidate): candidate is ClassFieldMember =>
    candidate.kind === NodeKind.ClassFieldMember && candidate.isStatic === true && candidate.name.name === propertyName);
  return field ? { statement, field } : null;
}

function staticFieldAccessorName(field: ClassFieldMember): string {
  return `__vexa_static_${cppName(field.name.name)}`;
}

function validateClassMethod(method: ClassMethodMember, statement: ClassStatement): void {
  if (
    method.computed ||
    method.optional ||
    (method.missingBody && !method.abstract)
  ) {
    throw new CppEmitError(
      "C++ emission supports concrete, non-generic methods only",
      statement
    );
  }
  if ((method.accessorKind || method.getterShorthand) && (
    method.isStatic ||
    method.async ||
    method.sync ||
    method.generator ||
    method.operator
  )) {
    throw new CppEmitError("C++ emission supports synchronous instance accessors only", statement);
  }
  if ((method.accessorKind === "get" || method.getterShorthand) && method.parameters.length > 0) {
    throw new CppEmitError("C++ getter accessors cannot declare parameters", statement);
  }
  if (method.accessorKind === "set" && method.parameters.length !== 1) {
    throw new CppEmitError("C++ setter accessors require exactly one parameter", statement);
  }
  if (method.operator && (method.isStatic || method.async || method.sync || method.generator)) {
    throw new CppEmitError("C++ emission supports synchronous instance operator methods only", statement);
  }
}

function emitEnumConstantExpression(expression: Expr): string {
  switch (expression.kind) {
    case NodeKind.IntLiteral:
      return String((expression as IntLiteral).value);
    case NodeKind.Identifier:
      return cppName((expression as Identifier).name);
    case NodeKind.UnaryExpression: {
      const unary = expression as UnaryExpression;
      if (!new Set(["+", "-", "~"]).has(unary.operator)) break;
      return `(${unary.operator}${emitEnumConstantExpression(unary.argument)})`;
    }
    case NodeKind.BinaryExpression: {
      const binary = expression as BinaryExpression;
      if (!new Set(["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"]).has(binary.operator)) break;
      return `(${emitEnumConstantExpression(binary.left)} ${binary.operator} ${emitEnumConstantExpression(binary.right)})`;
    }
    case NodeKind.MemberExpression: {
      const member = expression as MemberExpression;
      const enumName = !member.computed ? identifierName(member.object) : null;
      const memberName = !member.computed ? identifierName(member.property) : null;
      if (enumName && memberName && activeEnumNames.has(enumName)) {
        return `${cppName(enumName)}::${cppName(memberName)}`;
      }
      break;
    }
    case NodeKind.AsExpression:
    case NodeKind.SatisfiesExpression:
    case NodeKind.NonNullExpression:
      return emitEnumConstantExpression((expression as AsExpression | SatisfiesExpression | NonNullExpression).expression);
  }
  throw new CppEmitError("C++ emission supports numeric enum constant expressions only");
}

function emitEnum(statement: EnumStatement): string {
  if (statement.declared) {
    throw new CppEmitError("C++ emission does not support ambient enum declarations", statement);
  }
  const lines = [`struct ${cppName(statement.name.name)} final {`];
  statement.members.forEach((member, index) => {
    const value = member.initializer
      ? emitEnumConstantExpression(member.initializer)
      : index === 0
        ? "0"
        : `(${cppName(statement.members[index - 1]!.name.name)} + 1)`;
    lines.push(`  static constexpr std::int32_t ${cppName(member.name.name)} = ${value};`);
  });
  lines.push("};");
  return lines.join("\n");
}

function interfacePropertyGetterName(propertyName: string): string {
  return `__vexa_property_get_${cppName(propertyName)}`;
}

function interfacePropertySetterName(propertyName: string): string {
  return `__vexa_property_set_${cppName(propertyName)}`;
}

function isMutableInterfaceProperty(property: InterfacePropertyMember): boolean {
  return property.declarationKind !== "val" && property.declarationKind !== "const";
}

function interfacePropertyCppType(property: InterfacePropertyMember): string | null {
  const declared = cppTypeForDeclaredName(property.typeAnnotation.name);
  return property.optional && !declared?.endsWith("*") ? "vexa::Value" : declared;
}

function emitInterfaceProperty(property: InterfacePropertyMember, statement: InterfaceStatement): string[] {
  const type = interfacePropertyCppType(property);
  if (!type || type === "void") {
    throw new CppEmitError(
      `C++ emission does not support interface property type '${property.typeAnnotation.name}' yet`,
      statement
    );
  }
  const lines = [property.optional
    ? `  virtual ${type} ${interfacePropertyGetterName(property.name.name)}() { return vexa::defaultValue<${type}>(); }`
    : `  virtual ${type} ${interfacePropertyGetterName(property.name.name)}() = 0;`];
  if (isMutableInterfaceProperty(property)) {
    lines.push(property.optional
      ? `  virtual void ${interfacePropertySetterName(property.name.name)}(${type}) {}`
      : `  virtual void ${interfacePropertySetterName(property.name.name)}(${type} value) = 0;`);
  }
  return lines;
}

function emitInterfaceMethod(method: InterfaceMethodMember, statement: InterfaceStatement): string {
  if (
    method.accessorKind ||
    method.computed ||
    method.typeParameters?.length
  ) {
    throw new CppEmitError("C++ emission supports required, non-generic interface methods only", statement);
  }
  const resultType = method.returnType
    ? cppTypeForDeclaredName(method.returnType.name)
    : "void";
  if (!resultType) {
    throw new CppEmitError(
      `C++ emission does not support interface method return type '${method.returnType?.name}' yet`,
      statement
    );
  }
  const parameters = callableParameters(method.parameters, statement, false).text;
  const signature = `  virtual ${resultType} ${cppName(method.name.name)}(${parameters})`;
  return method.optional
    ? `${signature} { throw std::runtime_error("Optional interface method '${method.name.name}' is not implemented"); }`
    : `${signature} = 0;`;
}

function emitInterface(statement: InterfaceStatement): string {
  return withCppTypeParameters(statement.typeParameters, () => emitInterfaceWithActiveTypeParameters(statement));
}

function emitInterfaceWithActiveTypeParameters(statement: InterfaceStatement): string {
  const extendedInterfaces: string[] = [];
  for (const extendedType of statement.extendsTypes ?? []) {
    const baseName = parseTypeNameShape(extendedType.name).baseName;
    if (!activeInterfaceNames.has(baseName)) {
      throw new CppEmitError(
        `C++ interface '${statement.name.name}' can only extend another emitted interface`,
        statement
      );
    }
    const mapped = cppTypeForDeclaredName(extendedType.name);
    if (!mapped?.endsWith("*")) throw new CppEmitError(`C++ cannot map interface '${extendedType.name}'`, statement);
    extendedInterfaces.push(`public ${mapped.slice(0, -1)}`);
  }
  const inheritance = extendedInterfaces.length > 0
    ? ` : ${extendedInterfaces.join(", ")}`
    : " : public cppgc::GarbageCollectedMixin, public virtual vexa::EnumerableObject";
  const traceParts: string[] = [];
  for (const extendedType of statement.extendsTypes ?? []) {
    traceParts.push(`${cppTypeForDeclaredName(extendedType.name)!.slice(0, -1)}::Trace(visitor);`);
  }
  const traceBody = traceParts.join(" ");
  const trace = traceBody
    ? `  void Trace(cppgc::Visitor* visitor) const override { ${traceBody} }`
    : "  void Trace(cppgc::Visitor*) const override {}";
  const nativeCastBranches: string[] = [
    `if (__vexa_type == vexa::nativeTypeToken<${cppName(statement.name.name)}>()) return this;`,
  ];
  for (const extendedType of statement.extendsTypes ?? []) {
    const baseType = cppTypeForDeclaredName(extendedType.name)!.slice(0, -1);
    nativeCastBranches.push(`if (auto* __vexa_base = ${baseType}::nativeInterfaceCast(__vexa_type)) return __vexa_base;`);
  }
  const memberLines: string[] = [];
  for (const member of statement.members) {
    if (member.kind === NodeKind.InterfaceMethodMember) memberLines.push(emitInterfaceMethod(member, statement));
    else memberLines.push(...emitInterfaceProperty(member, statement));
  }
  const enumerableProperties = interfaceProperties(statement);
  const enumerableKeys = enumerableProperties.map((property) => cppUtf16String(property.name.name)).join(", ");
  const enumerableGetBranches = enumerableProperties.map((property) =>
    `if (__vexa_key == ${cppUtf16String(property.name.name)}) return vexa::convertValue<vexa::Value>(this->${interfacePropertyGetterName(property.name.name)}());`
  );
  return [
    `${cppTemplatePrefix(statement.typeParameters)}class ${cppName(statement.name.name)}${inheritance} {`,
    " public:",
    `  virtual ~${cppName(statement.name.name)}() = default;`,
    trace,
    `  void* nativeInterfaceCast(const void* __vexa_type) override { ${nativeCastBranches.join(" ")} return nullptr; }`,
    `  std::vector<std::u16string> enumerableKeys() const override { return {${enumerableKeys}}; }`,
    `  vexa::Value enumerableGet(const std::u16string& __vexa_key) override { ${enumerableGetBranches.join(" ")} return vexa::Value::undefined(); }`,
    ...(statement.typeParameters?.length ? [] : [`  static ${cppName(statement.name.name)}* fromRecord(vexa::RecordObject* record);`]),
    ...memberLines,
    "};",
  ].join("\n");
}

function classImplementsMethod(statement: ClassStatement, methodName: string): boolean {
  return implementedInterfaceTypes(statement).some((implementedType) => {
    const interfaceStatement = activeInterfaceStatements.get(parseTypeNameShape(implementedType.name).baseName);
    return Boolean(interfaceStatement && interfaceMethodForName(interfaceStatement, methodName));
  });
}

function implementedInterfaceTypes(statement: ClassStatement): Identifier[] {
  return [
    ...(statement.extendsType && activeInterfaceNames.has(parseTypeNameShape(statement.extendsType.name).baseName)
      ? [statement.extendsType]
      : []),
    ...(statement.implementsTypes ?? []),
  ];
}

function interfaceProperties(
  statement: InterfaceStatement,
  visited = new Set<string>()
): InterfacePropertyMember[] {
  if (visited.has(statement.name.name)) return [];
  visited.add(statement.name.name);
  const properties = new Map<string, InterfacePropertyMember>();
  for (const extendedType of statement.extendsTypes ?? []) {
    const parent = activeInterfaceStatements.get(parseTypeNameShape(extendedType.name).baseName);
    for (const property of parent ? interfaceProperties(parent, visited) : []) {
      properties.set(property.name.name, property);
    }
  }
  for (const member of statement.members) {
    if (member.kind === NodeKind.InterfacePropertyMember) properties.set(member.name.name, member);
  }
  return [...properties.values()];
}

function interfaceMethods(
  statement: InterfaceStatement,
  visited = new Set<string>()
): InterfaceMethodMember[] {
  if (visited.has(statement.name.name)) return [];
  visited.add(statement.name.name);
  const methods = new Map<string, InterfaceMethodMember>();
  for (const extendedType of statement.extendsTypes ?? []) {
    const parent = activeInterfaceStatements.get(parseTypeNameShape(extendedType.name).baseName);
    for (const method of parent ? interfaceMethods(parent, visited) : []) {
      methods.set(method.name.name, method);
    }
  }
  for (const member of statement.members) {
    if (member.kind === NodeKind.InterfaceMethodMember) methods.set(member.name.name, member);
  }
  return [...methods.values()];
}

function recordInterfaceAdapterName(interfaceName: string): string {
  const statement = activeInterfaceStatements.get(interfaceName);
  const mappedInterface = statement ? cppTypeForDeclaredName(statement.name.name) : null;
  let nativeName = cppName(interfaceName);
  if (mappedInterface?.endsWith("*")) nativeName = mappedInterface.slice(0, -1);
  return `__vexa_record_adapter_${nativeName}`;
}

function emitRecordInterfaceAdaptation(expression: Expr, interfaceName: string): string {
  const statement = activeInterfaceStatements.get(interfaceName);
  if (!statement) {
    throw new CppEmitError(
      `C++ cannot adapt a structural record to unknown interface '${interfaceName}'`
    );
  }
  const previousExpectedPropertyTypes = activeExpectedRecordPropertyCppTypes;
  activeExpectedRecordPropertyCppTypes = new Map(
    interfaceProperties(statement).flatMap((property) => {
      const type = interfacePropertyCppType(property);
      return type ? [[property.name.name, type] as const] : [];
    })
  );
  let result: string;
  try {
    result = `${activeRuntimeName}.make<${recordInterfaceAdapterName(interfaceName)}>(${emitExpression(expression)})`;
  } finally {
    activeExpectedRecordPropertyCppTypes = previousExpectedPropertyTypes;
  }
  return result;
}

function emitRecordInterfaceAdapter(statement: InterfaceStatement): string | null {
  if (statement.typeParameters?.length) return null;
  const interfaceName = cppName(statement.name.name);
  const adapterName = recordInterfaceAdapterName(statement.name.name);
  const properties: string[] = [];
  for (const property of interfaceProperties(statement)) {
    const type = interfacePropertyCppType(property);
    if (!type || type === "void") {
      throw new CppEmitError(
        `C++ emission does not support interface property type '${property.typeAnnotation.name}' yet`,
        statement
      );
    }
    properties.push(`  ${type} ${interfacePropertyGetterName(property.name.name)}() override { return vexa::recordGet<${type}>(${currentRuntimeExpression}, record_, ${cppUtf16String(property.name.name)}); }`);
    if (isMutableInterfaceProperty(property)) {
      properties.push(
        `  void ${interfacePropertySetterName(property.name.name)}(${type} value) override { vexa::recordSet(${currentRuntimeExpression}, record_, ${cppUtf16String(property.name.name)}, value); }`
      );
    }
  }
  const methods: string[] = [];
  for (const method of interfaceMethods(statement)) {
    const resultType = method.returnType ? cppTypeForDeclaredName(method.returnType.name) : "void";
    if (!resultType) {
      throw new CppEmitError(`C++ cannot map interface method '${method.name.name}'`, statement);
    }
    const parameters = callableParameters(method.parameters, statement, false);
    const dynamicArguments = parameters.names.map((name) =>
      `vexa::convertValue<vexa::Value>(${cppName(name)})`).join(", ");
    const invocation = `vexa::call(${currentRuntimeExpression}, vexa::recordGet<vexa::Value>(${currentRuntimeExpression}, record_, ${cppUtf16String(method.name.name)}), {${dynamicArguments}})`;
    const body = resultType === "void"
      ? `${invocation};`
      : `return vexa::convertValue<${resultType}>(${invocation});`;
    methods.push(`  ${resultType} ${cppName(method.name.name)}(${parameters.text}) override { ${body} }`);
  }
  return [
    `class ${adapterName} final : public cppgc::GarbageCollected<${adapterName}>, public ${interfaceName} {`,
    " public:",
    `  explicit ${adapterName}(vexa::RecordObject* record) : record_(record) {}`,
    `  void Trace(cppgc::Visitor* visitor) const override { ${interfaceName}::Trace(visitor); visitor->Trace(record_); }`,
    "  std::vector<std::u16string> enumerableKeys() const override { return record_->keys(); }",
    "  vexa::Value enumerableGet(const std::u16string& key) override { return record_->get(key); }",
    "  vexa::RecordObject* enumerableBackingRecord() override { return record_; }",
    "  void defineProperty(const std::u16string& key, const vexa::Value& value, bool enumerable) override { if (enumerable) record_->set(key, value); else record_->setHidden(key, value); }",
    ...properties,
    ...methods,
    " private:",
    "  cppgc::Member<vexa::RecordObject> record_;",
    "};",
    `inline ${interfaceName}* ${interfaceName}::fromRecord(vexa::RecordObject* record) { return ${currentRuntimeExpression}.make<${adapterName}>(record); }`,
  ].join("\n");
}

interface ResolvedInterfaceProperty {
  property: InterfacePropertyMember;
  typeName: string;
}

function resolvedInterfaceProperties(
  typeName: string,
  inheritedBindings: ReadonlyMap<string, string> = new Map(),
  visited = new Set<string>()
): ResolvedInterfaceProperty[] {
  const substitutedTypeName = substituteTypeName(typeName, inheritedBindings);
  const shape = parseTypeNameShape(substitutedTypeName);
  const statement = activeInterfaceStatements.get(shape.baseName);
  if (!statement || visited.has(substitutedTypeName)) return [];
  visited.add(substitutedTypeName);
  const bindings = new Map<string, string>();
  const typeParameters = statement.typeParameters ?? [];
  for (let index = 0; index < typeParameters.length; index += 1) {
    const parameter = typeParameters[index]!;
    const argument = shape.typeArguments[index] ?? parameter.defaultType?.name;
    if (argument) bindings.set(parameter.name.name, substituteTypeName(argument, inheritedBindings));
  }
  const properties = new Map<string, ResolvedInterfaceProperty>();
  for (const extendedType of statement.extendsTypes ?? []) {
    for (const property of resolvedInterfaceProperties(extendedType.name, bindings, visited)) {
      properties.set(property.property.name.name, property);
    }
  }
  for (const member of statement.members) {
    if (member.kind !== NodeKind.InterfacePropertyMember) continue;
    properties.set(member.name.name, {
      property: member,
      typeName: substituteTypeName(member.typeAnnotation.name, bindings),
    });
  }
  return [...properties.values()];
}

function implementedInterfaceProperties(statement: ClassStatement): ResolvedInterfaceProperty[] {
  const properties = new Map<string, ResolvedInterfaceProperty>();
  for (const implementedType of implementedInterfaceTypes(statement)) {
    for (const property of resolvedInterfaceProperties(implementedType.name)) {
      properties.set(property.property.name.name, property);
    }
  }
  return [...properties.values()];
}

function classPropertyImplementationKind(
  statement: ClassStatement,
  propertyName: string
): number {
  let primaryProperty: ClassPrimaryConstructorParameter | null = null;
  for (const parameter of statement.primaryConstructorParameters ?? []) {
    if (parameter.name.name === propertyName) {
      primaryProperty = parameter;
      break;
    }
  }
  if (primaryProperty) {
    return primaryProperty.declarationKind !== "val" && primaryProperty.declarationKind !== "const" ? 2 : 1;
  }
  let field: ClassFieldMember | null = null;
  for (const member of statement.members) {
    if (member.kind === NodeKind.ClassFieldMember && member.name.name === propertyName) {
      field = member as ClassFieldMember;
      break;
    }
  }
  if (field) {
    return field.declarationKind !== "val" && field.declarationKind !== "const" && !field.isReadonly ? 2 : 1;
  }
  return classGetterForName(statement, propertyName) ? 3 : 0;
}

function emitInterfacePropertyBridges(statement: ClassStatement): string[] {
  const result: string[] = [];
  for (const rawResolvedProperty of implementedInterfaceProperties(statement)) {
    const resolvedProperty = rawResolvedProperty as ResolvedInterfaceProperty;
    const property = resolvedProperty.property;
    const typeName = resolvedProperty.typeName;
    const implementationKind = classPropertyImplementationKind(statement, property.name.name);
    if (implementationKind === 0) {
      if (property.optional) continue;
      throw new CppEmitError(
        `C++ interface property '${property.name.name}' requires a field or getter implementation`,
        statement
      );
    }
    const implementationType = cppTypeForDeclaredName(typeName);
    const type = property.optional ? "vexa::Value" : implementationType;
    if (!type || type === "void" || !implementationType || implementationType === "void") {
      throw new CppEmitError(
        `C++ emission does not support interface property type '${property.typeAnnotation.name}' yet`,
        statement
      );
    }
    const propertyName = cppName(property.name.name);
    const getterValue = implementationKind === 3
      ? `this->${propertyName}()`
      : `this->${propertyName}`;
    const returnedValue = property.optional
      ? `vexa::convertValue<vexa::Value>(${getterValue})`
      : getterValue;
    const lines = [
      `  ${type} ${interfacePropertyGetterName(property.name.name)}() override { return ${returnedValue}; }`,
    ];
    if (isMutableInterfaceProperty(property)) {
      if (implementationKind === 2) {
        lines.push(
          `  void ${interfacePropertySetterName(property.name.name)}(${type} __vexa_property_value) override { this->${propertyName} = ${property.optional ? `vexa::convertValue<${implementationType}>(__vexa_property_value)` : "__vexa_property_value"}; }`
        );
      } else if (implementationKind === 3 && classSetterForName(statement, property.name.name)) {
        lines.push(
          `  void ${interfacePropertySetterName(property.name.name)}(${type} __vexa_property_value) override { this->${propertyName}(${property.optional ? `vexa::convertValue<${implementationType}>(__vexa_property_value)` : "__vexa_property_value"}); }`
        );
      } else {
        throw new CppEmitError(
          `C++ mutable interface property '${property.name.name}' requires a mutable field or setter accessor`,
          statement
        );
      }
    }
    result.push(...lines);
  }
  return result;
}

function emitClassMethod(
  method: ClassMethodMember,
  statement: ClassStatement
): string {
  return withCppTypeParameters(method.typeParameters, () =>
    emitClassMethodWithActiveTypeParameters(method, statement)
  );
}

function emitClassMethodWithActiveTypeParameters(
  method: ClassMethodMember,
  statement: ClassStatement
): string {
  validateClassMethod(method, statement);
  const generatorInfo = callableGeneratorInfo(
    method.name,
    method.returnType,
    Boolean(method.generator),
    Boolean(method.async || method.sync),
    statement
  );
  const producesTask = !generatorInfo && callableProducesTask(
    method.name,
    method.returnType,
    Boolean(method.async || method.sync),
    method.body
  );
  const asyncResultType = !generatorInfo && (method.async || method.sync)
    ? callableReturnType(method.returnType, method.body, statement, method.name, true)
    : null;
  const signature = callableSignature(
    method.name,
    method.parameters,
    method.returnType,
    method.body,
    statement,
    producesTask,
    generatorInfo,
    method.operator ? operatorMethodRuntimeName(method.operator, method.parameters) : method.name.name
  );
  const overridesBase = inheritedClassMethodForName(statement, method.name.name) !== null;
  const override = classImplementsMethod(statement, method.name.name) || overridesBase ? " override" : "";
  if (method.abstract) {
    return `  virtual ${signature} = 0;`;
  }
  const virtual = activeDerivedClassNames.has(statement.name.name) && !method.isStatic ? "virtual " : "";
  const valueResultType = generatorInfo?.resultType ?? asyncResultType ??
    callableReturnType(method.returnType, method.body, statement, method.name, producesTask);
  const callableResultType = producesTask && asyncResultType === null
    ? `vexa::Task<${valueResultType}>`
    : valueResultType;
  return withCallableContext(
    method.parameters,
    statement.name.name,
    Boolean(method.isStatic),
    asyncResultType,
    generatorInfo?.resultType ?? null,
    callableResultType,
    statement,
    () => {
      const body = generatorInfo
        ? emitGeneratorCallableBlock(method.body, "    ", generatorInfo.resultType)
        : asyncResultType !== null
          ? emitAsyncCallableBlock(method.body, "    ", asyncResultType)
          : emitBlock(method.body, "    ");
      return `${cppTemplatePrefix(method.typeParameters, "  ", true)}  ${method.isStatic ? "static " : virtual}${signature}${override} ${emitCallableReturnBoundary(body, "  ", callableResultType, Boolean(generatorInfo || asyncResultType))}`;
    }
  );
}

function emitClass(statement: ClassStatement): string {
  return withCppTypeParameters(statement.typeParameters, () => emitClassWithActiveTypeParameters(statement));
}

interface TypedPrimaryConstructorParameter {
  parameter: ClassPrimaryConstructorParameter;
  name: string;
  type: string;
}

interface TypedClassField extends ClassFieldTypeInfo {
  field: ClassFieldMember;
  name: string;
}

interface TypedConstructorProperty {
  parameter: FunctionParameter;
  typeName: string;
  type: string;
  name: string;
}

interface ClassFieldOutput {
  access: "public" | "private" | "protected";
  text: string;
}

function emitClassWithActiveTypeParameters(statement: ClassStatement): string {
  const extendedBaseName = statement.extendsType
    ? parseTypeNameShape(statement.extendsType.name).baseName
    : null;
  const nativeErrorBase = Boolean(extendedBaseName && isNativeErrorTypeName(extendedBaseName));
  let hasUnsupportedImplementedType = false;
  for (const implementedType of statement.implementsTypes ?? []) {
    if (!activeInterfaceNames.has(parseTypeNameShape(implementedType.name).baseName)) {
      hasUnsupportedImplementedType = true;
      break;
    }
  }
  if (
    statement.declared ||
    (extendedBaseName && !nativeErrorBase && !activeInterfaceNames.has(extendedBaseName) && !activeClassNames.has(extendedBaseName)) ||
    hasUnsupportedImplementedType ||
    statement.classDelegates?.length ||
    statement.members.some((member) => member.kind !== NodeKind.ClassMethodMember && member.kind !== NodeKind.ClassFieldMember)
  ) {
    const unsupportedMembers = statement.members
      .filter((member) => member.kind !== NodeKind.ClassMethodMember && member.kind !== NodeKind.ClassFieldMember)
      .map((member) => (member as Node).kind);
    throw new CppEmitError(
      `C++ emission cannot lower class '${statement.name.name}'${unsupportedMembers.length > 0 ? ` members: ${unsupportedMembers.join(", ")}` : " with its current inheritance or delegation"}`,
      statement
    );
  }

  const className = cppName(statement.name.name);
  const classType = statement.typeParameters?.length
    ? `${className}<${statement.typeParameters.map((parameter) => cppName(parameter.name.name)).join(", ")}>`
    : className;
  const baseClass: ClassStatement | undefined = statement.extendsType
    ? activeClassStatements.get(parseTypeNameShape(statement.extendsType.name).baseName)
    : undefined;
  const mappedBaseType: string | null = statement.extendsType
    ? cppTypeForDeclaredName(statement.extendsType.name)
    : null;
  let mappedBaseClassType: string = "";
  if (mappedBaseType !== null) {
    mappedBaseClassType = mappedBaseType.slice(0, -1) as string;
  }
  const constructorMethod = classConstructorMethod(statement);
  const implementedInterfaces: string[] = [];
  for (const implementedType of implementedInterfaceTypes(statement)) {
    const mapped = cppTypeForDeclaredName(implementedType.name);
    if (!mapped?.endsWith("*")) {
      throw new CppEmitError(`C++ cannot map interface '${implementedType.name}'`, statement);
    }
    implementedInterfaces.push(`public ${mapped.slice(0, -1)}`);
  }
  const parameters = statement.primaryConstructorParameters ?? [];
  const typedParameters: TypedPrimaryConstructorParameter[] = [];
  for (const parameter of parameters) {
    typedParameters.push({
      parameter,
      name: cppName(parameter.name.name),
      type: primaryConstructorParameterType(parameter, statement),
    });
  }
  const typedFieldMembers: TypedClassField[] = [];
  const typedStaticFields: TypedClassField[] = [];
  for (const rawMember of statement.members) {
    if (rawMember.kind !== NodeKind.ClassFieldMember) continue;
    const field = rawMember as ClassFieldMember;
    if (field.declared) continue;
    const fieldType = classFieldType(field, statement);
    const typedField: TypedClassField = {
      field,
      name: cppName(field.name.name),
      valueType: fieldType.valueType,
      storageType: fieldType.storageType,
      traced: fieldType.traced,
      genericTraced: fieldType.genericTraced,
    };
    if (field.isStatic) typedStaticFields.push(typedField);
    else typedFieldMembers.push(typedField);
  }
  const constructorPropertyParameters: FunctionParameter[] = [];
  for (const parameter of constructorMethod?.parameters ?? []) {
    if (parameter.accessModifier !== undefined || parameter.isReadonly === true) {
      constructorPropertyParameters.push(parameter);
    }
  }
  const typedConstructorProperties: TypedConstructorProperty[] = [];
  for (const parameter of constructorPropertyParameters) {
    const typeName = parameter.typeAnnotation?.name;
    const parameterType = emittedCallableParameterCppType(parameter, false);
    const type = parameter.optional && parameterType && typeName
      ? optionalCppValueType(parameterType, typeName)
      : parameterType;
    if (!type || type === "void" || parameter.name.kind !== NodeKind.Identifier) {
      throw new CppEmitError("C++ constructor parameter properties require supported identifier types", statement);
    }
    typedConstructorProperties.push({ parameter, typeName: typeName!, type, name: cppName(parameter.name.name) });
  }
  const sourceConstructorParameterParts: string[] = [];
  for (const rawParameter of typedParameters) {
    const parameter = rawParameter as TypedPrimaryConstructorParameter;
    sourceConstructorParameterParts.push(`${parameter.type} ${parameter.name}`);
  }
  const sourceConstructorParameters = sourceConstructorParameterParts.join(", ");
  const usesRuntime = classUsesRuntimeConstructor(statement);
  const constructorParameters = nativeConstructorParameters(sourceConstructorParameters);
  const initializers: string[] = [];
  for (const rawParameter of typedParameters) {
    const parameter = rawParameter as TypedPrimaryConstructorParameter;
    initializers.push(`${parameter.name}(${parameter.name})`);
  }
  for (const rawField of typedFieldMembers) {
    const field = rawField as TypedClassField;
    initializers.push(`${field.name}(${field.field.initializer
      ? emitClassFieldInitializer(field.field.initializer, statement, field.valueType)
      : `vexa::defaultValue<${field.valueType}>()`})`);
  }
  let constructor = initializers.length > 0 || usesRuntime || constructorParameters
    ? `${className}(${constructorParameters})${initializers.length > 0 ? ` : ${initializers.join(", ")}` : ""} {}`
    : `${className}() = default;`;
  if (constructorMethod) {
    const superStatement = constructorMethod.body.body.find((candidate) => {
      if (candidate.kind !== NodeKind.ExprStatement) return false;
      const expression = (candidate as ExprStatement).expression;
      return expression.kind === NodeKind.CallExpression && identifierName((expression as CallExpression).callee) === "super";
    });
    const superCall = superStatement
      ? (superStatement as ExprStatement).expression as CallExpression
      : null;
    if (baseClass && !superCall && classRequiresConstructorArguments(baseClass)) {
      throw new CppEmitError(
        `C++ derived constructor '${statement.name.name}' must forward arguments to '${baseClass.name.name}' with super(...)`,
        statement
      );
    }
    constructor = withCallableContext(
      constructorMethod.parameters,
      statement.name.name,
      false,
      null,
      null,
      "void",
      statement,
      () => {
        const methodParameters = callableParameters(constructorMethod.parameters, statement).text;
        const nativeParameters = methodParameters;
        const nativeInitializers: string[] = [];
        if (baseClass && mappedBaseClassType) {
          const baseArguments = superCall
            ? emitArguments(superCall.args, classConstructorParameters(baseClass))
            : "";
          nativeInitializers.push(
            `${mappedBaseClassType}(${classUsesRuntimeConstructor(baseClass) ? withRuntimeArgument(baseArguments) : baseArguments})`
          );
        } else if (nativeErrorBase) {
          if (superCall && superCall.args.length > 1) {
            throw new CppEmitError("C++ Error subclasses support zero or one super message", statement);
          }
          if (superCall && superCall.args[0]) {
            nativeInitializers.push(`vexa::Error(${emitConvertedValue(superCall.args[0], "vexa::Value")})`);
          } else {
            nativeInitializers.push(`vexa::Error(std::u16string(u"Error"))`);
          }
        }
        for (const rawProperty of typedConstructorProperties) {
          const property = rawProperty as TypedConstructorProperty;
          const parameterType = emittedCallableParameterCppType(property.parameter, false);
          const initializer = property.type === "vexa::Value" && parameterType?.endsWith("*")
            ? `(${property.name} ? vexa::convertValue<vexa::Value>(${property.name}) : vexa::Value::undefined())`
            : property.name;
          nativeInitializers.push(`${property.name}(${initializer})`);
        }
        for (const rawField of typedFieldMembers) {
          const field = rawField as TypedClassField;
          nativeInitializers.push(`${field.name}(${field.field.initializer
            ? emitClassFieldInitializer(field.field.initializer, statement, field.valueType)
            : `vexa::defaultValue<${field.valueType}>()`})`);
        }
        const body = new BlockStatement(
          constructorMethod.body.body.filter((candidate) => candidate !== superStatement),
          constructorMethod.body.annotations,
          constructorMethod.body.jsName
        );
        return `${className}(${nativeParameters})${nativeInitializers.length > 0 ? ` : ${nativeInitializers.join(", ")}` : ""} ${emitBlock(body, "  ")}`;
      }
    );
  } else if (baseClass && (classRequiresConstructorArguments(baseClass) || classUsesRuntimeConstructor(baseClass))) {
    throw new CppEmitError(
      `C++ derived class '${statement.name.name}' requires an explicit constructor with super(...) for base class '${baseClass.name.name}'`,
      statement
    );
  }
  const primaryFields: string[] = [];
  for (const rawParameter of typedParameters) {
    const typedParameter = rawParameter as TypedPrimaryConstructorParameter;
    const immutable = typedParameter.parameter.declarationKind === "val" || typedParameter.parameter.declarationKind === "const";
    const declaredType = typedParameter.parameter.typeAnnotation?.name;
    const storageType = managedArrayElementType(typedParameter.type) !== null
      ? `cppgc::Member<${typedParameter.type.slice(0, -1)}>`
      : declaredType && isNativeObjectTypeName(declaredType)
        ? `cppgc::Member<${typedParameter.type.slice(0, -1)}>`
        : typedParameter.type;
    primaryFields.push(`  ${immutable ? "const " : ""}${storageType} ${typedParameter.name};`);
  }
  for (const rawProperty of typedConstructorProperties) {
    const typedProperty = rawProperty as TypedConstructorProperty;
    const immutable = typedProperty.parameter.isReadonly === true;
    const storageType = typedProperty.type.endsWith("*")
      ? `cppgc::Member<${typedProperty.type.slice(0, -1)}>`
      : typedProperty.type;
    primaryFields.push(`  ${immutable ? "const " : ""}${storageType} ${typedProperty.name};`);
  }
  const explicitFields: ClassFieldOutput[] = [];
  for (const rawField of typedFieldMembers) {
    const typedField = rawField as TypedClassField;
    const immutable = Boolean(typedField.field.initializer) &&
      (typedField.field.declarationKind === "val" || typedField.field.declarationKind === "const" || typedField.field.isReadonly);
    explicitFields.push({ access: typedField.field.accessModifier ?? "public", text: `  ${immutable ? "const " : ""}${typedField.storageType} ${typedField.name};` });
  }
  const staticFieldAccessors: ClassFieldOutput[] = [];
  for (const rawField of typedStaticFields) {
    const typedField = rawField as TypedClassField;
    const initializer = typedField.field.initializer
      ? emitClassFieldInitializer(typedField.field.initializer, statement, typedField.valueType, true)
      : `vexa::defaultValue<${typedField.valueType}>()`;
    if (typedField.traced) {
      const pointee = typedField.valueType.slice(0, -1);
      staticFieldAccessors.push({
        access: typedField.field.accessModifier ?? "public" as const,
        text: [
          `  static ${typedField.valueType} ${staticFieldAccessorName(typedField.field)}() {`,
          `    static cppgc::Persistent<${pointee}> __vexa_value;`,
          `    if (!__vexa_value) __vexa_value = ${initializer};`,
          "    return __vexa_value.Get();",
          "  }",
        ].join("\n"),
      });
      continue;
    }
    staticFieldAccessors.push({
      access: typedField.field.accessModifier ?? "public" as const,
      text: `  static ${typedField.valueType}& ${staticFieldAccessorName(typedField.field)}() { static ${typedField.valueType} __vexa_value = ${initializer}; return __vexa_value; }`,
    });
  }
  const fieldLines = [...primaryFields];
  let activeAccess: "public" | "private" | "protected" = "public";
  for (const field of explicitFields) {
    if (field.access !== activeAccess) {
      fieldLines.push(` ${field.access}:`);
      activeAccess = field.access;
    }
    fieldLines.push(field.text);
  }
  for (const field of staticFieldAccessors) {
    if (field.access !== activeAccess) {
      fieldLines.push(` ${field.access}:`);
      activeAccess = field.access;
    }
    fieldLines.push(field.text);
  }
  const tracedFields: string[] = [];
  for (const rawParameter of typedParameters) {
    const parameter = rawParameter as TypedPrimaryConstructorParameter;
    if ((parameter.parameter.typeAnnotation && isNativeObjectTypeName(parameter.parameter.typeAnnotation.name)) ||
      managedArrayElementType(parameter.type) !== null) {
      tracedFields.push(`visitor->Trace(${parameter.name});`);
    }
    if (parameter.parameter.typeAnnotation && activeCppTypeParameters.has(parameter.parameter.typeAnnotation.name)) {
      tracedFields.push(`vexa::traceManagedValue(visitor, ${parameter.name});`);
    }
  }
  for (const rawProperty of typedConstructorProperties) {
    const property = rawProperty as TypedConstructorProperty;
    if (property.type.endsWith("*")) {
      tracedFields.push(`visitor->Trace(${property.name});`);
    }
    if (activeCppTypeParameters.has(property.typeName)) {
      tracedFields.push(`vexa::traceManagedValue(visitor, ${property.name});`);
    }
  }
  for (const rawField of typedFieldMembers) {
    const field = rawField as TypedClassField;
    if (field.traced) tracedFields.push(`visitor->Trace(${field.name});`);
    if (field.genericTraced) tracedFields.push(`vexa::traceManagedValue(visitor, ${field.name});`);
  }
  const traceStatements: string[] = [];
  if (baseClass && mappedBaseClassType) traceStatements.push(`${mappedBaseClassType}::Trace(visitor);`);
  else traceStatements.push("vexa::DynamicValueObject::Trace(visitor);");
  for (const implementedType of implementedInterfaceTypes(statement)) {
    traceStatements.push(`${cppTypeForDeclaredName(implementedType.name)!.slice(0, -1)}::Trace(visitor);`);
  }
  traceStatements.push(...tracedFields);
  const traceOverrides = true;
  const traceVirtual = !traceOverrides && (Boolean(statement.abstract) || activeDerivedClassNames.has(statement.name.name));
  const traceQualifier = traceOverrides ? (statement.abstract || activeDerivedClassNames.has(statement.name.name) ? " override" : " final") : "";
  const trace = traceStatements.length > 0
    ? `  ${traceVirtual ? "virtual " : ""}void Trace(cppgc::Visitor* visitor) const${traceQualifier} { ${traceStatements.join(" ")} }`
    : `  ${traceVirtual ? "virtual " : ""}void Trace(cppgc::Visitor*) const${traceQualifier} {}`;
  const methods: ClassMethodMember[] = [];
  for (const rawMember of statement.members) {
    if (rawMember.kind === NodeKind.ClassMethodMember && rawMember.name.name !== "constructor") {
      methods.push(rawMember as ClassMethodMember);
    }
  }
  const methodLines: string[] = [];
  const propertyBridges = emitInterfacePropertyBridges(statement);
  if (propertyBridges.length > 0) {
    if (activeAccess !== "public") {
      methodLines.push(" public:");
      activeAccess = "public";
    }
    methodLines.push(...propertyBridges);
  }
  for (const method of methods) {
    const access = method.accessModifier ?? "public";
    if (access !== activeAccess) {
      methodLines.push(` ${access}:`);
      activeAccess = access;
    }
    methodLines.push(emitClassMethod(method, statement));
  }

  const final = statement.abstract || activeDerivedClassNames.has(statement.name.name) ? "" : " final";
  const nativeBases: string[] = [];
  nativeBases.push(baseClass && mappedBaseClassType
    ? `public ${mappedBaseClassType}`
    : `public cppgc::GarbageCollected<${classType}>`);
  if (!baseClass) nativeBases.push("public vexa::DynamicValueObject");
  if (nativeErrorBase) nativeBases.push("public vexa::Error");
  for (const implementedInterface of implementedInterfaces) nativeBases.push(implementedInterface);
  const dynamicCastBranches: string[] = [
    `if (__vexa_type == vexa::nativeTypeToken<${classType}>()) return this;`,
  ];
  if (nativeErrorBase) {
    dynamicCastBranches.push(`if (__vexa_type == vexa::nativeTypeToken<vexa::Error>()) return static_cast<vexa::Error*>(this);`);
  }
  for (const implementedType of implementedInterfaceTypes(statement)) {
    const interfaceType = cppTypeForDeclaredName(implementedType.name)!.slice(0, -1);
    dynamicCastBranches.push(`if (__vexa_type == vexa::nativeTypeToken<${interfaceType}>()) return static_cast<${interfaceType}*>(this);`);
  }
  if (baseClass && mappedBaseClassType) {
    dynamicCastBranches.push(`if (auto* __vexa_base = ${mappedBaseClassType}::dynamicCast(__vexa_type)) return __vexa_base;`);
  }
  const dynamicPropertyReads: Array<{ key: string; body: string }> = [];
  const dynamicPropertyWrites: Array<{ key: string; body: string }> = [];
  const dynamicPropertyNames: string[] = [];
  const addDynamicProperty = (name: string, valueType: string, immutable: boolean): void => {
    dynamicPropertyNames.push(cppUtf16String(name));
    const storedValue = valueType.endsWith("*") ? `vexa::rawPointer(${name})` : name;
    dynamicPropertyReads.push({
      key: name,
      body: `return vexa::convertValue<vexa::Value>(${storedValue});`,
    });
    if (!immutable) {
      dynamicPropertyWrites.push({
        key: name,
        body: `${name} = vexa::convertValue<${valueType}>(__vexa_value); return __vexa_value;`,
      });
    }
  };
  for (const parameter of typedParameters) {
    addDynamicProperty(
      parameter.name,
      parameter.type,
      parameter.parameter.declarationKind === "val" || parameter.parameter.declarationKind === "const"
    );
  }
  for (const property of typedConstructorProperties) {
    addDynamicProperty(property.name, property.type, Boolean(property.parameter.isReadonly));
  }
  for (const field of typedFieldMembers) {
    if (field.field.accessModifier === "private" || field.field.accessModifier === "protected") {
      continue;
    }
    const immutable = Boolean(field.field.initializer) && Boolean(
      field.field.declarationKind === "val" || field.field.declarationKind === "const" || field.field.isReadonly
    );
    addDynamicProperty(field.name, field.valueType, immutable);
  }
  const dynamicMethodReads: Array<{ key: string; body: string }> = [];
  for (const method of methods) {
    if (
      method.isStatic || method.abstract || method.missingBody ||
      method.accessorKind || method.getterShorthand || method.typeParameters?.length ||
      (method.accessModifier !== undefined && method.accessModifier !== "public") ||
      method.async || method.sync || method.generator ||
      method.parameters.some((parameter) => parameter.name.kind !== NodeKind.Identifier || parameter.rest)
    ) {
      continue;
    }
    const parameterTypes = method.parameters.map((parameter) =>
      emittedCallableParameterCppType(parameter, false));
    if (parameterTypes.some((type) => !type || type === "void")) continue;
    const resultType = callableReturnType(method.returnType, method.body, statement, method.name, false);
    const lambdaParameters = parameterTypes.map((type, index) =>
      `${type!} __vexa_argument_${index}`).join(", ");
    const argumentsText = parameterTypes.map((_, index) => `__vexa_argument_${index}`).join(", ");
    const invocation = `this->${method.operator
      ? cppOperatorMethodName(method.operator, method.parameters)
      : cppName(method.name.name)}(${argumentsText})`;
    const result = resultType === "void"
      ? `${invocation};`
      : `return ${invocation};`;
    const functionTypes = [resultType];
    for (const parameterType of parameterTypes) functionTypes.push(parameterType!);
    dynamicMethodReads.push({
      key: method.operator ? `__vexa_operator:${method.operator}` : method.name.name,
      body: `return vexa::Value(vexa::makeFunction<${functionTypes.join(", ")}>(${currentRuntimeExpression}, [this](${lambdaParameters}) -> ${resultType} { ${result} }, {vexa::convertValue<vexa::Value>(this)}));`,
    });
  }
  const dynamicGetFallback = baseClass && mappedBaseClassType
    ? `${mappedBaseClassType}::dynamicGet(__vexa_key)`
    : "vexa::DynamicValueObject::dynamicGet(__vexa_key)";
  const dynamicSetFallback = baseClass && mappedBaseClassType
    ? `${mappedBaseClassType}::dynamicSet(__vexa_key, __vexa_value)`
    : "vexa::DynamicValueObject::dynamicSet(__vexa_key, __vexa_value)";
  const dynamicKeysFallback = baseClass && mappedBaseClassType
    ? `${mappedBaseClassType}::dynamicKeys()`
    : "std::vector<std::u16string>{}";
  const dynamicMethods = [
    `  const void* dynamicTypeToken() const override { return vexa::nativeTypeToken<${classType}>(); }`,
    `  void* dynamicCast(const void* __vexa_type) override { ${dynamicCastBranches.join(" ")} return nullptr; }`,
    '  std::u16string dynamicToString() const override { return u"[object Object]"; }',
    `  std::vector<std::u16string> dynamicKeys() const override { auto __vexa_keys = ${dynamicKeysFallback}; ${dynamicPropertyNames.map((name) => `if (std::find(__vexa_keys.begin(), __vexa_keys.end(), ${name}) == __vexa_keys.end()) __vexa_keys.push_back(${name});`).join(" ")} return __vexa_keys; }`,
    [
      "  vexa::Value dynamicGet(const std::u16string& __vexa_key) override {",
      emitDynamicKeyDispatch([...dynamicPropertyReads, ...dynamicMethodReads], "    "),
      `    return ${dynamicGetFallback};`,
      "  }",
    ].filter(Boolean).join("\n"),
    [
      "  vexa::Value dynamicSet(const std::u16string& __vexa_key, const vexa::Value& __vexa_value) override {",
      emitDynamicKeyDispatch(dynamicPropertyWrites, "    "),
      `    return ${dynamicSetFallback};`,
      "  }",
    ].filter(Boolean).join("\n"),
  ];
  if (implementedInterfaces.length > 0) {
    dynamicMethods.push(`  void* nativeInterfaceCast(const void* __vexa_type) override { ${dynamicCastBranches.join(" ")} return nullptr; }`);
  }
  return [
    `${cppTemplatePrefix(statement.typeParameters)}class ${className}${final} : ${nativeBases.join(", ")} {`,
    " public:",
    `  ${constructor}`,
    trace,
    ...dynamicMethods,
    ...fieldLines,
    ...methodLines,
    "};",
  ].join("\n");
}

function emitLabeledStatement(statement: LabeledStatement, indent: string): string {
  const label = statement.label.name;
  if (statement.body.kind === NodeKind.ForStatement) {
    return emitFor(statement.body as ForStatement, indent, label);
  }
  if (statement.body.kind === NodeKind.WhileStatement) {
    const loop = statement.body as WhileStatement;
    return `${indent}while ${emitParenthesizedCondition(loop.condition)} ${emitLoopBody(loop.body, indent, label)}`;
  }
  if (statement.body.kind === NodeKind.DoWhileStatement) {
    const loop = statement.body as DoWhileStatement;
    return `${indent}do ${emitLoopBody(loop.body, indent, label)} while ${emitParenthesizedCondition(loop.condition)};`;
  }
  const body = emitStatement(statement.body, `${indent}  `);
  return [
    `${indent}try {`,
    body,
    `${indent}} catch (const vexa::LabeledBreakSignal& __vexa_signal) {`,
    `${indent}  if (__vexa_signal.label() != ${cppUtf16String(label)}) throw;`,
    `${indent}}`,
  ].join("\n");
}

function emitStatement(statement: Statement, indent = ""): string {
  switch (statement.kind) {
    case NodeKind.BlockStatement:
      return `${indent}${emitBlock(statement as BlockStatement, indent)}`;
    case NodeKind.ExprStatement: {
      const expression = (statement as ExprStatement).expression;
      if (expression.kind === NodeKind.UnaryExpression && (expression as UnaryExpression).operator === "yield*") {
        if (!activeGeneratorResultType) throw new CppEmitError("C++ yield* emission requires a generator callable", statement);
        const temporary = `__vexa_yield_value_${activeYieldTemporaryCounter++}`;
        const argument = (expression as UnaryExpression).argument;
        const emittedIterable = emitExpression(argument);
        const iterable = isManagedArrayExpression(argument)
          ? `*vexa::arrayPointer(${emittedIterable})`
          : emittedIterable;
        return [
          `${indent}for (auto&& ${temporary} : ${iterable}) {`,
          `${indent}  co_yield vexa::convertValue<${activeGeneratorResultType}>(${temporary});`,
          `${indent}}`,
        ].join("\n");
      }
      return `${indent}${emitDiscardedExpression(expression)};`;
    }
    case NodeKind.VarStatement:
      return `${indent}${emitVariable(statement as VarStatement)};`;
    case NodeKind.ForStatement:
      return emitFor(statement as ForStatement, indent);
    case NodeKind.SwitchStatement:
      return emitSwitch(statement as SwitchStatement, indent);
    case NodeKind.IfStatement: {
      const branch = statement as IfStatement;
      let narrowing: { sourceName: string; targetName: string; targetType: string } | null = null;
      if (branch.condition.kind === NodeKind.BinaryExpression) {
        const condition = branch.condition as BinaryExpression;
        const sourceName = condition.left.kind === NodeKind.Identifier ? (condition.left as Identifier).name : null;
        const targetName = condition.right.kind === NodeKind.Identifier ? (condition.right as Identifier).name : null;
        if ((condition.operator === "instanceof" || condition.operator === "is") && sourceName && targetName && activeClassNames.has(targetName)) {
          const targetType = cppTypeForDeclaredName(targetName);
          if (targetType?.endsWith("*")) {
            narrowing = { sourceName, targetName, targetType };
          }
        }
      }
      let thenBody: string;
      if (narrowing) {
        const previousLocalCppTypes = activeLocalCppTypes;
        const previousGcObjectTypes = activeGcObjectTypes;
        const previousDynamicValueNames = activeDynamicValueNames;
        activeLocalCppTypes = new Map(activeLocalCppTypes);
        activeLocalCppTypes.set(narrowing.sourceName, narrowing.targetType);
        activeGcObjectTypes = new Map(activeGcObjectTypes);
        activeGcObjectTypes.set(narrowing.sourceName, narrowing.targetName);
        activeDynamicValueNames = new Set(activeDynamicValueNames);
        activeDynamicValueNames.delete(narrowing.sourceName);
        try {
          thenBody = emitBody(branch.thenBranch, indent);
        } finally {
          activeLocalCppTypes = previousLocalCppTypes;
          activeGcObjectTypes = previousGcObjectTypes;
          activeDynamicValueNames = previousDynamicValueNames;
        }
        const temporary = `__vexa_narrowed_${cppName(narrowing.sourceName)}`;
        thenBody = injectBlockPreamble(thenBody, [
          `${indent}  auto* ${temporary} = vexa::convertValue<${narrowing.targetType}>(${cppName(narrowing.sourceName)});`,
          `${indent}  auto* ${cppName(narrowing.sourceName)} = ${temporary};`,
        ]);
      } else {
        thenBody = emitBody(branch.thenBranch, indent);
      }
      const alternate = branch.elseBranch ? ` else ${emitBody(branch.elseBranch, indent)}` : "";
      return `${indent}if ${emitParenthesizedCondition(branch.condition)} ${thenBody}${alternate}`;
    }
    case NodeKind.WhileStatement: {
      const loop = statement as WhileStatement;
      return `${indent}while ${emitParenthesizedCondition(loop.condition)} ${emitLoopBody(loop.body, indent)}`;
    }
    case NodeKind.DoWhileStatement: {
      const loop = statement as DoWhileStatement;
      return `${indent}do ${emitLoopBody(loop.body, indent)} while ${emitParenthesizedCondition(loop.condition)};`;
    }
    case NodeKind.LabeledStatement:
      return emitLabeledStatement(statement as LabeledStatement, indent);
    case NodeKind.ReturnStatement: {
      const returned = (statement as ReturnStatement).expression;
      if (activeFinallyProtectedDepth > 0 && activeCallableResultType) {
        activeCallableUsesReturnSignal = true;
        if (!returned && activeCallableResultType !== "void") {
          return `${indent}throw vexa::ReturnSignal<${activeCallableResultType}>(vexa::defaultValue<${activeCallableResultType}>());`;
        }
        if (!returned || activeCallableResultType === "void") {
          return `${indent}throw vexa::ReturnSignal<${activeCallableResultType}>();`;
        }
        if (activeCppTypeParameters.has(activeCallableResultType)) {
          return `${indent}vexa::throwReturn<${activeCallableResultType}>(${activeRuntimeName}, [&]() -> decltype(auto) { return ${emitExpression(returned)}; });`;
        }
        const emitted = emitConvertedValue(returned, activeCallableResultType);
        const returnedType = activeExpressionTypes.get(returned as Node);
        const flattened = activeAsyncResultType && returnedType?.kind === AnalysisTypeKind.Named && returnedType.name === "Promise"
          ? `(co_await ${emitted})`
          : emitted;
        return `${indent}throw vexa::ReturnSignal<${activeCallableResultType}>(${flattened});`;
      }
      if (activeGeneratorResultType) {
        return `${indent}co_return ${returned
          ? emitConvertedValue(returned, activeGeneratorResultType)
          : `vexa::defaultValue<${activeGeneratorResultType}>()`};`;
      }
      if (activeAsyncResultType) {
        if (!returned) return `${indent}co_return;`;
        return `${indent}co_return ${emitAsyncResultValue(returned, activeAsyncResultType)};`;
      }
      if (!returned) return activeCallableResultType && activeCallableResultType !== "void"
        ? `${indent}return vexa::defaultValue<${activeCallableResultType}>();`
        : `${indent}return;`;
      if (activeCallableResultType === "void") return `${indent}${emitExpression(returned)}; return;`;
      return `${indent}return ${activeCallableResultType
        ? emitConvertedValue(returned, activeCallableResultType)
        : emitExpression(returned)};`;
    }
    case NodeKind.ThrowStatement:
      return `${indent}vexa::throwValue(${emitExpression((statement as ThrowStatement).expression)});`;
    case NodeKind.TryStatement:
      return emitTry(statement as TryStatement, indent);
    case NodeKind.BreakStatement: {
      const control = statement as BreakStatement;
      if (control.label) {
        return `${indent}throw vexa::LabeledBreakSignal(${cppUtf16String(control.label.name)});`;
      }
      const boundary = activeBreakBoundaries.at(-1);
      if (boundary && activeFinallyProtectedDepth > boundary.finallyDepth) {
        boundary.usesSignal = true;
        return `${indent}throw vexa::BreakSignal();`;
      }
      return `${indent}break;`;
    }
    case NodeKind.ContinueStatement: {
      const control = statement as ContinueStatement;
      if (control.label) {
        return `${indent}throw vexa::LabeledContinueSignal(${cppUtf16String(control.label.name)});`;
      }
      const boundary = activeContinueBoundaries.at(-1);
      if (boundary && activeFinallyProtectedDepth > boundary.finallyDepth) {
        boundary.usesSignal = true;
        return `${indent}throw vexa::ContinueSignal();`;
      }
      return `${indent}continue;`;
    }
    case NodeKind.FunctionStatement:
      return `${indent}${emitFunction(statement as FunctionStatement)}`;
    case NodeKind.ClassStatement:
      return `${indent}${emitClass(statement as ClassStatement)}`;
    case NodeKind.ExportStatement: {
      const declaration = (statement as ExportStatement).declaration;
      return declaration ? emitStatement(declaration, indent) : "";
    }
    case NodeKind.EmptyStatement:
      return `${indent};`;
    case NodeKind.DebuggerStatement:
      return `${indent}/* debugger */;`;
    case NodeKind.TypeAliasStatement:
    case NodeKind.InterfaceStatement:
    case NodeKind.EnumStatement:
    case NodeKind.ImportStatement:
      return "";
    default:
      throw new CppEmitError(`C++ emission does not support ${statement.kind} statements yet`, statement);
  }
}

function isDirectSyncCall(expression: Expr): expression is CallExpression {
  if (expression.kind !== NodeKind.CallExpression) return false;
  const call = expression as CallExpression;
  const functionName = identifierName(call.callee);
  return Boolean(functionName && activeFunctionStatements.get(functionName)?.sync);
}

export interface CppEmitSemantics {
  sourceFilePath?: string;
  emitSourceLocations?: boolean;
  expressionTypes?: ReadonlyMap<Node, AnalysisType>;
  implicitReceiverIdentifiers?: ReadonlySet<Node>;
  implicitReceiverExtensionIdentifiers?: ReadonlyMap<Node, string>;
  staticImplicitReceiverIdentifiers?: ReadonlyMap<Node, string>;
  autoAwaitExpressions?: ReadonlySet<Node>;
  callableTypes?: ReadonlyMap<Node, AnalysisType>;
  operatorResolutions?: ReadonlyMap<Node, AnalysisSymbol>;
  extensionPropertyResolutions?: ReadonlyMap<Node, ExtensionPropertyResolution>;
  receiverLambdas?: ReadonlyMap<Node, ReceiverLambdaInfo>;
}

function interfacesInDependencyOrder(interfaces: readonly InterfaceStatement[]): InterfaceStatement[] {
  const byName = new Map<string, InterfaceStatement>();
  for (const statement of interfaces) byName.set(statement.name.name, statement);
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const result: InterfaceStatement[] = [];
  for (const root of interfaces) {
    const pendingStatements: InterfaceStatement[] = [root];
    const pendingExpanded: boolean[] = [false];
    while (pendingStatements.length > 0) {
      const statement = pendingStatements.pop()!;
      const expanded = pendingExpanded.pop()!;
      const name = statement.name.name;
      if (emitted.has(name)) continue;
      if (expanded) {
        visiting.delete(name);
        emitted.add(name);
        result.push(statement);
        continue;
      }
      if (visiting.has(name)) continue;
      visiting.add(name);
      pendingStatements.push(statement);
      pendingExpanded.push(true);
      const parents: InterfaceStatement[] = [];
      for (const extendedType of statement.extendsTypes ?? []) {
        const parent = byName.get(parseTypeNameShape(extendedType.name).baseName);
        if (parent) parents.push(parent);
      }
      for (let index = parents.length - 1; index >= 0; index -= 1) {
        pendingStatements.push(parents[index]!);
        pendingExpanded.push(false);
      }
    }
  }
  return result;
}

function classesInDependencyOrder(classes: readonly ClassStatement[]): ClassStatement[] {
  const byName = new Map<string, ClassStatement>();
  for (const statement of classes) byName.set(statement.name.name, statement);
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const result: ClassStatement[] = [];
  for (const root of classes) {
    const pendingStatements: ClassStatement[] = [root];
    const pendingExpanded: boolean[] = [false];
    while (pendingStatements.length > 0) {
      const statement = pendingStatements.pop()!;
      const expanded = pendingExpanded.pop()!;
      const name = statement.name.name;
      if (emitted.has(name)) continue;
      if (expanded) {
        visiting.delete(name);
        emitted.add(name);
        result.push(statement);
        continue;
      }
      if (visiting.has(name)) continue;
      visiting.add(name);
      pendingStatements.push(statement);
      pendingExpanded.push(true);
      const parent = statement.extendsType
        ? byName.get(parseTypeNameShape(statement.extendsType.name).baseName)
        : undefined;
      if (parent) {
        pendingStatements.push(parent);
        pendingExpanded.push(false);
      }
    }
  }
  return result;
}

interface TopLevelVariableInfo {
  statement: VarStatement;
  name: string;
  type: string;
  pointee: string | null;
}

export function emitCppProgram(program: Program, semantics: CppEmitSemantics = {}): string {
  activeClassPropertyCppTypes = new Map();
  activeNativeFunctionCaptureNamesCache = new Map();
  activeNestedClosureCaptureNamesCache = new Map();
  activeDeclaredCppTypeCache = new Map();
  activeCanonicalNativeObjectNameCache = new Map();
  activeClassMethodCache = new Map();
  activeClassGetterCache = new Map();
  activeClassSetterCache = new Map();
  activeClassStoredPropertyInfoCache = new Map();
  const statements: Statement[] = [];
  const interfaces: InterfaceStatement[] = [];
  const enums: EnumStatement[] = [];
  const typeAliases: TypeAliasStatement[] = [];
  const classes: ClassStatement[] = [];
  const functions: FunctionStatement[] = [];
  const extensionProperties: VarStatement[] = [];
  for (const bodyStatement of program.body) {
    const statement = bodyStatement.kind === NodeKind.ExportStatement && (bodyStatement as ExportStatement).declaration
      ? (bodyStatement as ExportStatement).declaration!
      : bodyStatement;
    statements.push(statement);
    if (statement.kind === NodeKind.InterfaceStatement) interfaces.push(statement as InterfaceStatement);
    else if (statement.kind === NodeKind.EnumStatement) enums.push(statement as EnumStatement);
    else if (statement.kind === NodeKind.TypeAliasStatement) typeAliases.push(statement as TypeAliasStatement);
    else if (statement.kind === NodeKind.ClassStatement) classes.push(statement as ClassStatement);
    else if (statement.kind === NodeKind.FunctionStatement) functions.push(statement as FunctionStatement);
    else if (statement.kind === NodeKind.VarStatement && (statement as VarStatement).receiverType) {
      extensionProperties.push(statement as VarStatement);
    }
  }
  const stringLiteralValues = new Set<string>();
  const registerStringLiteral = (value: string): void => {
    stringLiteralValues.add(value);
  };
  const pendingLiteralNodes: Node[] = [program];
  while (pendingLiteralNodes.length > 0) {
    const node = pendingLiteralNodes.pop()!;
    if (node.kind === NodeKind.StringLiteral) {
      registerStringLiteral((node as StringLiteral).value);
    }
    if (node.kind === NodeKind.UnaryExpression && usesPooledFunctionTypeof(node as UnaryExpression)) {
      registerStringLiteral("function");
    }
    for (const child of childNodes(node)) pendingLiteralNodes.push(child);
  }
  activeStringLiteralNames = new Map();
  for (const value of [...stringLiteralValues].sort()) {
    activeStringLiteralNames.set(value, `__vexa_literal_${activeStringLiteralNames.size}`);
  }
  const nativeIdentifierNames = (identifier: Identifier): string[] => {
    const originalName = identifier.__vexaNativeOriginalName;
    if (originalName && originalName !== identifier.name) return [identifier.name, originalName];
    return [identifier.name];
  };
  const classStatements = new Map<string, ClassStatement>();
  for (const statement of classes) {
    for (const name of nativeIdentifierNames(statement.name)) classStatements.set(name, statement);
  }
  activeClassStatements = classStatements;
  const classStatementsByCppBase = new Map<string, ClassStatement>();
  for (const [name, statement] of classStatements) classStatementsByCppBase.set(cppName(name), statement);
  activeClassStatementsByCppBase = classStatementsByCppBase;
  activeClassNames = new Set(activeClassStatements.keys());
  const derivedClassNames = new Set<string>();
  for (const statement of classes) {
    if (!statement.extendsType) continue;
    const parentName = parseTypeNameShape(statement.extendsType.name).baseName;
    if (activeClassNames.has(parentName)) derivedClassNames.add(parentName);
  }
  activeDerivedClassNames = derivedClassNames;
  const interfaceStatements = new Map<string, InterfaceStatement>();
  for (const statement of interfaces) {
    for (const name of nativeIdentifierNames(statement.name)) interfaceStatements.set(name, statement);
  }
  activeInterfaceStatements = interfaceStatements;
  const interfaceStatementsByCppBase = new Map<string, InterfaceStatement>();
  for (const [name, statement] of interfaceStatements) interfaceStatementsByCppBase.set(cppName(name), statement);
  activeInterfaceStatementsByCppBase = interfaceStatementsByCppBase;
  activeInterfaceNames = new Set(activeInterfaceStatements.keys());
  const enumNames = new Set<string>();
  for (const statement of enums) enumNames.add(statement.name.name);
  activeEnumNames = enumNames;
  const typeAliasTargets = new Map<string, string>();
  for (const statement of typeAliases) {
    if (statement.typeParameters?.length) continue;
    for (const name of nativeIdentifierNames(statement.name)) {
      typeAliasTargets.set(name, statement.targetType.name);
    }
  }
  activeTypeAliases = typeAliasTargets;
  activeCppTypeParameters = new Set();
  activeCppTypeParameterCacheKey = "";
  const functionStatements = new Map<string, FunctionStatement>();
  for (const statement of functions) {
    if (!statement.receiverType) functionStatements.set(statement.name.name, statement);
  }
  activeFunctionStatements = functionStatements;
  const extensionFunctions = new Map<string, FunctionStatement[]>();
  for (const statement of functions) {
    if (!statement.receiverType) continue;
    const existing = extensionFunctions.get(statement.receiverType.name) ?? [];
    existing.push(statement);
    extensionFunctions.set(statement.receiverType.name, existing);
  }
  activeExtensionFunctions = extensionFunctions;
  const extensionPropertyMap = new Map<string, VarStatement>();
  for (const statement of extensionProperties) {
    if (statement.name.kind === NodeKind.Identifier && statement.receiverType) {
      extensionPropertyMap.set(`${statement.receiverType.name}.${(statement.name as Identifier).name}`, statement);
    }
  }
  activeExtensionProperties = extensionPropertyMap;
  activeGcObjectTypes = new Map();
  activeGcArrayTypes = new Map();
  activeDynamicValueNames = new Set();
  activeSharedBindingNames = new Set();
  activeSharedBindingCandidates = new Set();
  activeFunctionObjectCapture = false;
  activeFunctionObjectCaptureNames = null;
  activeExpressionTypes = semantics.expressionTypes ?? new Map();
  activeHasExpressionTypes = activeExpressionTypes.size > 0;
  activeImplicitReceiverIdentifiers = semantics.implicitReceiverIdentifiers ?? new Set();
  activeReceiverLambdas = semantics.receiverLambdas ?? new Map();
  activeReceiverLabels = new Map();
  activeReceiverSymbolCounter = 0;
  activeImplicitReceiverExtensionIdentifiers = semantics.implicitReceiverExtensionIdentifiers ?? new Map();
  activeStaticImplicitReceiverIdentifiers = semantics.staticImplicitReceiverIdentifiers ?? new Map();
  activeAutoAwaitExpressions = semantics.autoAwaitExpressions ?? new Set();
  activeCallableTypes = semantics.callableTypes ?? new Map();
  activeOperatorResolutions = semantics.operatorResolutions ?? new Map();
  activeExtensionPropertyResolutions = semantics.extensionPropertyResolutions ?? new Map();
  activeSourceFilePath = semantics.sourceFilePath ?? null;
  activeEmitSourceLocations = semantics.emitSourceLocations ?? false;
  activeExpectedLambdaResultCppType = null;
  activeExpectedLambdaParameterCppTypes = null;
  const operatorMethodsByNameNode = new Map<Node, ClassMethodMember>();
  for (const statement of classes) {
    for (const member of statement.members) {
      if (member.kind === NodeKind.ClassMethodMember && (member as ClassMethodMember).operator) {
        const method = member as ClassMethodMember;
        operatorMethodsByNameNode.set(method.name as Node, method);
      }
    }
  }
  activeOperatorMethodsByNameNode = operatorMethodsByNameNode;
  activeSuppressAutoAwait = false;
  activeAsyncResultType = null;
  activeGeneratorResultType = null;
  activeYieldTemporaryCounter = 0;
  activeExceptionTemporaryCounter = 0;
  activeSwitchTemporaryCounter = 0;
  activeDestructureTemporaryCounter = 0;
  activeCurrentClassName = null;
  activeCurrentClassStatement = null;
  clearExpressionTypeCaches();
  activeCurrentMethodStatic = false;
  activeLocalNames = new Set();
  activeLocalDeclaredTypeNames = new Map();
  activeLocalCppTypes = new Map();
  activeCallableParameterPointerTypes = new Map();
  activeGlobalDeclaredTypeNames = new Map();
  activeGlobalCppTypes = new Map();
  activeGlobalGcRootTypes = new Map();
  activeRuntimeName = "runtime";

  const topLevelVariables: VarStatement[] = [];
  for (const rawStatement of statements) {
    if (rawStatement.kind !== NodeKind.VarStatement) continue;
    const statement = rawStatement as VarStatement;
    if (!statement.receiverType && statement.name.kind === NodeKind.Identifier && statement.initializer) {
      topLevelVariables.push(statement);
    }
  }
  const topLevelVariableInfo: TopLevelVariableInfo[] = [];
  for (const statement of topLevelVariables) {
    const name = cppName((statement.name as Identifier).name);
    const declaredType = statement.typeAnnotation ? cppTypeForDeclaredName(statement.typeAnnotation.name) : "";
    const emittedInferredType = statement.initializer
      ? emittedCppTypeForExpression(statement.initializer)
      : null;
    const analyzedInferredType = statement.initializer
      ? cppTypeForExpression(statement.initializer)
      : null;
    const inferredType = statement.initializer?.kind === NodeKind.ArrayLiteral
      ? `vexa::ArrayObject<${arrayLiteralCppElementType(statement.initializer as ArrayLiteral)}>*`
      : (!emittedInferredType || emittedInferredType === "auto") &&
          analyzedInferredType && analyzedInferredType !== "auto"
        ? analyzedInferredType
        : emittedInferredType;
    let type: string = "vexa::Value";
    if (declaredType.length > 0) type = declaredType;
    else if (inferredType && inferredType !== "auto" && inferredType !== "void") type = inferredType;
    topLevelVariableInfo.push({ statement, name, type, pointee: type.endsWith("*") ? type.slice(0, -1) : null });
    activeLocalCppTypes.set((statement.name as Identifier).name, type);
  }
  activeGlobalCppTypes = new Map(activeLocalCppTypes);
  const globalDeclaredTypeNames = new Map<string, string>();
  for (const statement of topLevelVariables) {
    if (statement.typeAnnotation && statement.name.kind === NodeKind.Identifier) {
      globalDeclaredTypeNames.set((statement.name as Identifier).name, statement.typeAnnotation.name);
    }
  }
  activeGlobalDeclaredTypeNames = globalDeclaredTypeNames;
  activeGlobalGcRootTypes = new Map();
  for (const info of topLevelVariableInfo) {
    if (info.pointee && info.statement.name.kind === NodeKind.Identifier) {
      activeGlobalGcRootTypes.set((info.statement.name as Identifier).name, info.pointee);
    }
  }
  clearExpressionTypeCaches();
  const topLevelVariableDeclarations: string[] = [];
  for (const rawInfo of topLevelVariableInfo) {
    const info = rawInfo as TopLevelVariableInfo;
    if (info.pointee) {
      topLevelVariableDeclarations.push(`${info.type} ${info.name} = nullptr;`);
      topLevelVariableDeclarations.push(`cppgc::Persistent<${info.pointee}> ${info.name}__vexa_root;`);
    } else {
      topLevelVariableDeclarations.push(`${info.type} ${info.name} = vexa::defaultValue<${info.type}>();`);
    }
  }
  const stringLiteralDeclarations: string[] = [];
  const stringLiteralInitializers: string[] = [];
  for (const [value, name] of activeStringLiteralNames) {
    stringLiteralDeclarations.push(`static vexa::Value* ${name} = nullptr;`);
    stringLiteralInitializers.push(`  ${name} = __VEXA_STRING_LITERAL(${cppUtf16String(value)});`);
  }

  const forwardInterfaces: string[] = [];
  for (const statement of interfaces) {
    forwardInterfaces.push(`${cppTemplatePrefix(statement.typeParameters, "", true)}class ${cppName(statement.name.name)};`);
  }
  const forwardClasses: string[] = [];
  for (const statement of classes) {
    forwardClasses.push(`${cppTemplatePrefix(statement.typeParameters, "", true)}class ${cppName(statement.name.name)};`);
  }
  const enumDefinitions: string[] = [];
  for (const statement of enums) enumDefinitions.push(emitEnum(statement));
  const orderedInterfaces = interfacesInDependencyOrder(interfaces);
  const interfaceDefinitions: string[] = [];
  const recordInterfaceAdapters: string[] = [];
  for (const statement of orderedInterfaces) {
    interfaceDefinitions.push(emitInterface(statement));
    const adapter = emitRecordInterfaceAdapter(statement);
    if (adapter !== null) recordInterfaceAdapters.push(adapter);
  }
  const functionPrototypes: string[] = [];
  for (const statement of functions) {
    functionPrototypes.push(`${cppTemplatePrefix(statement.typeParameters, "", true)}${functionSignature(statement)};`);
  }
  const classDefinitions: string[] = [];
  for (const statement of classesInDependencyOrder(classes)) classDefinitions.push(emitClass(statement));
  const functionDefinitions: string[] = [];
  for (const statement of functions) functionDefinitions.push(emitFunction(statement));
  const extensionPropertyDefinitions: string[] = [];
  for (const statement of extensionProperties) extensionPropertyDefinitions.push(emitExtensionProperty(statement));
  const forwardDeclarations: string[] = [];
  forwardDeclarations.push(...forwardInterfaces);
  forwardDeclarations.push(...forwardClasses);
  const declarationSections: string[][] = [
    stringLiteralDeclarations,
    forwardDeclarations,
    topLevelVariableDeclarations,
    enumDefinitions,
    interfaceDefinitions,
    recordInterfaceAdapters,
    functionPrototypes,
    classDefinitions,
    functionDefinitions,
    extensionPropertyDefinitions,
  ];
  const declarations: string[] = [];
  let emittedSection = false;
  for (const section of declarationSections) {
    if (section.length === 0) continue;
    if (emittedSection) declarations.push("");
    declarations.push(...section);
    emittedSection = true;
  }

  activeGcObjectTypes = new Map();
  activeGcArrayTypes = new Map();
  activeDynamicValueNames = new Set();
  activeSharedBindingNames = new Set();
  activeSharedBindingCandidates = new Set();
  activeCurrentClassName = null;
  activeCurrentClassStatement = null;
  activeCurrentMethodStatic = false;
  activeLocalNames = new Set();
  activeLocalDeclaredTypeNames = new Map();
  activeLocalCppTypes = new Map();
  activeCallableParameterPointerTypes = new Map();
  activeRuntimeName = "runtime";
  for (const info of topLevelVariableInfo) {
    if (info.statement.name.kind !== NodeKind.Identifier) continue;
    const sourceName = (info.statement.name as Identifier).name;
    activeLocalCppTypes.set(sourceName, info.type);
    if (info.type === "vexa::Value") activeDynamicValueNames.add(sourceName);
  }
  const entryStatements: string[] = [];
  for (const statement of statements) {
    if (
      statement.kind === NodeKind.FunctionStatement ||
      statement.kind === NodeKind.ClassStatement ||
      (statement.kind === NodeKind.VarStatement && Boolean((statement as VarStatement).receiverType))
    ) continue;
    if (statement.kind === NodeKind.VarStatement) {
      const variable = statement as VarStatement;
      if (variable.name.kind !== NodeKind.Identifier) {
        const emitted = emitStatement(variable, "    ");
        if (emitted) {
          entryStatements.push(...emitStatementPreamble(statement, "    "));
          entryStatements.push(emitted);
        }
        continue;
      }
      if (!variable.initializer) continue;
      const info = topLevelVariableInfo.find((candidate) => (candidate as TopLevelVariableInfo).statement === variable)!;
      const declaredTypeName = variable.typeAnnotation?.name;
      const initializer = declaredTypeName &&
        activeInterfaceNames.has(parseTypeNameShape(declaredTypeName).baseName) &&
        isRecordExpression(variable.initializer)
        ? emitRecordInterfaceAdaptation(variable.initializer, parseTypeNameShape(declaredTypeName).baseName)
        : emitExpressionWithExpectedCppType(variable.initializer, info.type);
      entryStatements.push(...emitStatementPreamble(statement, "    "));
      entryStatements.push(`    ${info.name} = ${initializer};`);
      if (info.pointee) {
        entryStatements.push(`    ${info.name}__vexa_root = cppgc::Persistent<${info.pointee}>(${info.name});`);
      }
      continue;
    }
    if (statement.kind === NodeKind.ExprStatement && isDirectSyncCall((statement as ExprStatement).expression)) {
      entryStatements.push(...emitStatementPreamble(statement, "    "));
      entryStatements.push(`    ${emitWithoutAutoAwait((statement as ExprStatement).expression)}.get();`);
      continue;
    }
    const emitted = emitStatement(statement, "    ");
    if (!emitted) continue;
    entryStatements.push(...emitStatementPreamble(statement, "    "));
    entryStatements.push(emitted);
  }

  const outputLines: string[] = [
    "// Generated by VexaScript. Compile through `vexa build <file> --emit cpp --native`.",
    '#include "runtime.cpp"',
    ""
  ];
  outputLines.push(...declarations);
  if (declarations.length > 0) outputLines.push("");
  outputLines.push(
    "#define __VEXA_STRING_LITERAL(str) runtime.retainLiteralValue(std::u16string((str), sizeof(str) / sizeof(char16_t) - 1))",
    "int main(int argc, char** argv) {",
    "  vexa::Runtime runtime;",
    `  runtime.reserveLiterals(${activeStringLiteralNames.size});`
  );
  outputLines.push(...stringLiteralInitializers);
  outputLines.push(
    "#undef __VEXA_STRING_LITERAL",
    "  vexa::Process process(runtime, vexa::platformArguments(argc, argv), vexa::platformEnvironment());",
    "  vexa::process = &process;",
    "  try {"
  );
  outputLines.push(...entryStatements);
  outputLines.push(
    "    runtime.runEventLoop();",
    "  } catch (const std::exception& error) {",
    '    std::cerr << "Uncaught " << error.what();',
    "    const auto location = runtime.sourceLocation();",
    '    if (!location.empty()) std::cerr << " at " << vexa::utf16ToUtf8(location);',
    "    std::cerr << std::endl;",
    "    return 1;",
    "  }",
    "  return static_cast<int>(process.exitCode);",
    "}",
    ""
  );
  return outputLines.join("\n");
}
