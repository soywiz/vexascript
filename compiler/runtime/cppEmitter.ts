import type {
  ArrayLiteral,
  ArrayBindingPattern,
  ArrowFunctionExpression,
  AssignmentExpression,
  BinaryExpression,
  BindingElement,
  BindingName,
  BlockStatement,
  BreakStatement,
  CallExpression,
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
  FunctionExpression,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  IfStatement,
  InterfaceMember,
  InterfaceMethodMember,
  InterfacePropertyMember,
  InterfaceStatement,
  LabeledStatement,
  MemberExpression,
  NamedArgument,
  NewExpression,
  Node,
  ObjectLiteral,
  ObjectBindingPattern,
  ObjectProperty,
  OverloadableOperator,
  Program,
  RangeExpression,
  RegExpLiteral,
  ReturnStatement,
  Statement,
  SpreadExpression,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  TypeAliasStatement,
  TypeParameter,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
} from "compiler/ast/ast";
import { compoundAssignmentBinaryOperator } from "compiler/ast/ast";
import { bindingElementPropertyName, bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { childNodes } from "compiler/ast/traversal";
import type { AnalysisType, BuiltinTypeName } from "compiler/analysis/types";
import type { AnalysisSymbol } from "compiler/analysis/model";
import type { ExtensionPropertyResolution } from "compiler/analysis/model";
import { parseTypeNameShape, splitArraySuffixTypeName } from "compiler/analysis/typeNames";
import { operatorMethodRuntimeName } from "./operatorNames";

export class CppEmitError extends Error {
  constructor(message: string, readonly statement?: Statement) {
    super(message);
    this.name = "CppEmitError";
  }
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

let activeClassNames: ReadonlySet<string> = new Set();
let activeInterfaceNames: ReadonlySet<string> = new Set();
let activeEnumNames: ReadonlySet<string> = new Set();
let activeTypeAliases: ReadonlyMap<string, string> = new Map();
let activeCppTypeParameters: ReadonlySet<string> = new Set();
let activeGcObjectTypes: Map<string, string> = new Map();
let activeGcArrayTypes: Map<string, string> = new Map();
let activeDynamicValueNames: Set<string> = new Set();
let activeFunctionObjectCapture = false;
let activeFunctionObjectCaptureNames: ReadonlySet<string> | null = null;
let activeExpressionTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeFunctionStatements: ReadonlyMap<string, FunctionStatement> = new Map();
let activeExtensionFunctions: ReadonlyMap<string, readonly FunctionStatement[]> = new Map();
let activeClassStatements: ReadonlyMap<string, ClassStatement> = new Map();
let activeDerivedClassNames: ReadonlySet<string> = new Set();
let activeInterfaceStatements: ReadonlyMap<string, InterfaceStatement> = new Map();
let activeCurrentClassName: string | null = null;
let activeCurrentMethodStatic = false;
let activeLocalNames: Set<string> = new Set();
let activeRuntimeName = "runtime";
let activeThisExpression = "this";
let activeImplicitReceiverIdentifiers: ReadonlySet<Node> = new Set();
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
let activeFinallyProtectedDepth = 0;
let activeBreakBoundaryDepths: number[] = [];
let activeContinueBoundaryDepths: number[] = [];
let activeYieldTemporaryCounter = 0;
let activeExceptionTemporaryCounter = 0;
let activeSwitchTemporaryCounter = 0;
let activeDestructureTemporaryCounter = 0;
let activeSourceFilePath: string | null = null;

function cppName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const withValidStart = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return CPP_RESERVED_WORDS.has(withValidStart) ? `vexa_${withValidStart}` : withValidStart;
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
      : null;
    return `typename ${cppName(parameter.name.name)}${defaultType ? ` = ${defaultType}` : ""}`;
  }).join(", ");
  return `${indent}template <${parameters}>\n`;
}

function withCppTypeParameters<T>(
  typeParameters: readonly TypeParameter[] | undefined,
  emit: () => T
): T {
  if (!typeParameters?.length) return emit();
  const previous = activeCppTypeParameters;
  activeCppTypeParameters = new Set([
    ...activeCppTypeParameters,
    ...typeParameters.map((parameter) => parameter.name.name),
  ]);
  try {
    return emit();
  } finally {
    activeCppTypeParameters = previous;
  }
}

function substituteTypeName(typeName: string, bindings: ReadonlyMap<string, string>): string {
  const direct = bindings.get(typeName);
  if (direct) return direct;
  const shape = parseTypeNameShape(typeName);
  const baseName = bindings.get(shape.baseName) ?? shape.baseName;
  const argumentsText = shape.typeArguments.length > 0
    ? `<${shape.typeArguments.map((argument) => substituteTypeName(argument, bindings)).join(", ")}>`
    : "";
  return `${baseName}${argumentsText}${"[]".repeat(shape.arrayDepth)}`;
}

function cppOperatorMethodName(operator: OverloadableOperator, parameters: readonly FunctionParameter[]): string {
  return cppName(operatorMethodRuntimeName(operator, parameters));
}

function identifierName(expression: Expr): string | null {
  return expression.kind === "Identifier" ? (expression as Identifier).name : null;
}

function emitIdentifier(identifier: Identifier): string {
  if (identifier.name === "this") return activeThisExpression;
  if (activeImplicitReceiverExtensionIdentifiers.has(identifier as Node)) {
    const receiverName = activeImplicitReceiverExtensionIdentifiers.get(identifier as Node)!;
    const extensionProperty = activeExtensionProperties.get(`${receiverName}.${identifier.name}`);
    if (extensionProperty) {
      return `${extensionPropertyCppName(extensionProperty)}(${activeRuntimeName}, ${activeThisExpression})`;
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
    const currentClass = activeCurrentClassName
      ? activeClassStatements.get(activeCurrentClassName)
      : undefined;
    if (currentClass && classGetterForName(currentClass, identifier.name)) {
      return `${activeThisExpression}->${cppName(identifier.name)}(${activeRuntimeName})`;
    }
    return `${activeThisExpression}->${cppName(identifier.name)}`;
  }
  return cppName(identifier.name);
}

function emitWithoutAutoAwait(expression: Expr): string {
  const previous = activeSuppressAutoAwait;
  activeSuppressAutoAwait = true;
  try {
    return emitExpression(expression);
  } finally {
    activeSuppressAutoAwait = previous;
  }
}

function maybeAutoAwait(expression: Expr, emitted: string): string {
  return !activeSuppressAutoAwait && activeAutoAwaitExpressions.has(expression as Node)
    ? activeAsyncResultType
      ? `(co_await ${emitted})`
      : `${emitted}.get()`
    : emitted;
}

function memberParts(expression: Expr): { object: Expr; objectName: string | null; propertyName: string } | null {
  if (expression.kind !== "MemberExpression") return null;
  const member = expression as MemberExpression;
  if (member.computed || member.property.kind !== "Identifier") return null;
  return {
    object: member.object,
    objectName: identifierName(member.object),
    propertyName: (member.property as Identifier).name,
  };
}

function cppString(value: string): string {
  return JSON.stringify(value)
    .replace(/\\u2028/g, "\\u2028")
    .replace(/\\u2029/g, "\\u2029");
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
    case "string":
    case "any":
    case "unknown":
      return "vexa::Value";
    default:
      return null;
  }
}

function cppTypeForAnalysisType(type: AnalysisType): string | null {
  if (type.kind === "builtin") return cppTypeForBuiltin(type.name);
  if (type.kind === "named" && activeCppTypeParameters.has(type.name) && !(type.typeArguments?.length)) {
    return cppName(type.name);
  }
  if (type.kind === "literal") {
    return cppTypeForBuiltin(type.base === "number" ? "number" : type.base);
  }
  if (type.kind === "array") {
    const elementType = cppArrayElementType(type.elementType);
    return elementType ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (type.kind === "range") {
    const elementType = cppArrayElementType(type.elementType);
    return elementType ? `std::vector<${elementType}>` : null;
  }
  if (type.kind === "tuple") {
    const elementTypes = new Set(type.elements.map(cppArrayElementType));
    const elementType = elementTypes.size === 1 ? [...elementTypes][0] : null;
    return elementType ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (type.kind === "object") return "vexa::RecordObject*";
  if (
    type.kind === "named" &&
    (type.name === "Array" || type.name === "ReadonlyArray" || type.name === "ConcatArray")
  ) {
    const elementType = cppArrayElementType(type.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" });
    return elementType ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (type.kind === "named" && type.name === "Promise") {
    const resultType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" });
    return `vexa::Task<${resultType ?? "vexa::Value"}>`;
  }
  if (type.kind === "named" && (type.name === "Map" || type.name === "ReadonlyMap")) {
    const keyType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? { kind: "builtin", name: "any" }) ?? "vexa::Value";
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[1] ?? { kind: "builtin", name: "any" }) ?? "vexa::Value";
    return `vexa::MapObject<${keyType}, ${valueType}>*`;
  }
  if (type.kind === "named" && (type.name === "Set" || type.name === "ReadonlySet")) {
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? { kind: "builtin", name: "any" }) ?? "vexa::Value";
    return `vexa::SetObject<${valueType}>*`;
  }
  if (type.kind === "named" && type.name === "WeakMap") {
    const keyType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" });
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[1] ?? { kind: "builtin", name: "any" }) ?? "vexa::Value";
    return keyType?.endsWith("*") ? `vexa::WeakMapObject<${keyType}, ${valueType}>*` : null;
  }
  if (type.kind === "named" && type.name === "WeakSet") {
    const valueType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" });
    return valueType?.endsWith("*") ? `vexa::WeakSetObject<${valueType}>*` : null;
  }
  if (type.kind === "named" && type.name === "RegExp") return "vexa::RegExp";
  if (type.kind === "named" && type.name === "Date") return "vexa::DateObject*";
  if (type.kind === "named" && type.name === "ArrayBuffer") return "vexa::ArrayBufferObject*";
  if (type.kind === "named" && type.name === "Uint8Array") return "vexa::Uint8ArrayObject*";
  if (type.kind === "named" && type.name === "DataView") return "vexa::DataViewObject*";
  if (type.kind === "named" && activeEnumNames.has(type.name)) return "std::int32_t";
  if (type.kind === "named" && isNativeObjectTypeName(type.name)) {
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
    return `${cppName(parseTypeNameShape(type.name).baseName)}${specialization}*`;
  }
  return null;
}

function cppTypeForDeclaredName(typeName: string, visitedAliases = new Set<string>()): string | null {
  const arrayType = splitArraySuffixTypeName(typeName);
  if (arrayType) {
    const elementType = arrayType.elementTypeName === "string"
      ? "std::string"
      : cppTypeForDeclaredName(arrayType.elementTypeName, visitedAliases);
    if (!elementType || elementType === "void") return null;
    let result = elementType;
    for (let depth = 0; depth < arrayType.arrayDepth; depth += 1) {
      result = `vexa::ArrayObject<${result}>*`;
    }
    return result;
  }
  if (activeCppTypeParameters.has(typeName)) return cppName(typeName);
  const builtin = cppTypeForBuiltin(typeName as BuiltinTypeName);
  if (builtin) return builtin;
  if (activeEnumNames.has(typeName)) return "std::int32_t";
  const shape = parseTypeNameShape(typeName);
  if (shape.baseName === "Array" || shape.baseName === "ReadonlyArray" || shape.baseName === "ConcatArray") {
    const elementType = cppTypeForDeclaredName(shape.typeArguments[0] ?? "unknown", visitedAliases);
    return elementType && elementType !== "void" ? `vexa::ArrayObject<${elementType}>*` : null;
  }
  if (shape.baseName === "Map" || shape.baseName === "ReadonlyMap") {
    const keyType = cppTypeForDeclaredName(shape.typeArguments[0] ?? "any", visitedAliases) ?? "vexa::Value";
    const valueType = cppTypeForDeclaredName(shape.typeArguments[1] ?? "any", visitedAliases) ?? "vexa::Value";
    return `vexa::MapObject<${keyType}, ${valueType}>*`;
  }
  if (shape.baseName === "Set" || shape.baseName === "ReadonlySet") {
    const valueType = cppTypeForDeclaredName(shape.typeArguments[0] ?? "any", visitedAliases) ?? "vexa::Value";
    return `vexa::SetObject<${valueType}>*`;
  }
  if (shape.baseName === "WeakMap") {
    const keyType = cppTypeForDeclaredName(shape.typeArguments[0] ?? "unknown", visitedAliases);
    const valueType = cppTypeForDeclaredName(shape.typeArguments[1] ?? "any", visitedAliases) ?? "vexa::Value";
    return keyType?.endsWith("*") ? `vexa::WeakMapObject<${keyType}, ${valueType}>*` : null;
  }
  if (shape.baseName === "WeakSet") {
    const valueType = cppTypeForDeclaredName(shape.typeArguments[0] ?? "unknown", visitedAliases);
    return valueType?.endsWith("*") ? `vexa::WeakSetObject<${valueType}>*` : null;
  }
  if (shape.baseName === "Date") return "vexa::DateObject*";
  if (shape.baseName === "ArrayBuffer") return "vexa::ArrayBufferObject*";
  if (shape.baseName === "Uint8Array") return "vexa::Uint8ArrayObject*";
  if (shape.baseName === "DataView") return "vexa::DataViewObject*";
  if (activeClassNames.has(shape.baseName) || activeInterfaceNames.has(shape.baseName)) {
    const statement = activeClassStatements.get(shape.baseName) ?? activeInterfaceStatements.get(shape.baseName);
    const parameters = statement?.typeParameters ?? [];
    const argumentNames = [...shape.typeArguments];
    for (let index = argumentNames.length; index < parameters.length; index += 1) {
      const defaultType = parameters[index]?.defaultType;
      if (!defaultType) return null;
      argumentNames.push(defaultType.name);
    }
    const typeArguments = argumentNames.map((argument) => cppTypeForDeclaredName(argument, visitedAliases));
    if (typeArguments.some((argument) => !argument) || typeArguments.length < parameters.length) return null;
    const specialization = parameters.length > 0 ? `<${typeArguments.join(", ")}>` : "";
    return `${cppName(shape.baseName)}${specialization}*`;
  }
  if (visitedAliases.has(typeName)) return null;
  const aliasTarget = activeTypeAliases.get(typeName);
  if (!aliasTarget) return null;
  visitedAliases.add(typeName);
  return cppTypeForDeclaredName(aliasTarget, visitedAliases);
}

function isNativeObjectTypeName(typeName: string): boolean {
  const baseName = parseTypeNameShape(typeName).baseName;
  return activeClassNames.has(baseName) || activeInterfaceNames.has(baseName);
}

function cppArrayElementType(type: AnalysisType): string | null {
  if (type.kind === "builtin" && type.name === "string") return "std::string";
  if (type.kind === "literal" && type.base === "string") return "std::string";
  if (type.kind === "union") return "vexa::Value";
  return cppTypeForAnalysisType(type);
}

function cppTypeForExpression(expression: Expr): string {
  const analysisType = activeExpressionTypes.get(expression as Node);
  if (analysisType) {
    const mapped = cppTypeForAnalysisType(analysisType);
    if (mapped) return mapped;
  }
  if (expression.kind === "IntLiteral") return "std::int32_t";
  if (expression.kind === "LongLiteral") return "std::int64_t";
  if (expression.kind === "BigIntLiteral") return "vexa::BigInt";
  if (expression.kind === "FloatLiteral") return "double";
  return "auto";
}

function managedArrayElementType(type: string): string | null {
  const prefix = "vexa::ArrayObject<";
  return type.startsWith(prefix) && type.endsWith(">*")
    ? type.slice(prefix.length, -2)
    : null;
}

function managedArrayCppTypeForExpression(expression: Expr): string | null {
  const mapped = cppTypeForExpression(expression);
  if (managedArrayElementType(mapped) !== null) return mapped;
  const taskPrefix = "vexa::Task<";
  if (mapped.startsWith(taskPrefix) && mapped.endsWith(">")) {
    const result = mapped.slice(taskPrefix.length, -1);
    if (managedArrayElementType(result) !== null) return result;
  }
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind === "array" || type?.kind === "tuple") return cppTypeForAnalysisType(type);
  return null;
}

function isManagedArrayExpression(expression: Expr): boolean {
  if (managedArrayElementType(cppTypeForExpression(expression)) !== null) return true;
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === "array" || type?.kind === "tuple" ||
    (type?.kind === "named" && new Set(["Array", "ReadonlyArray", "ConcatArray"]).has(type.name)) ||
    expression.kind === "ArrayLiteral";
}

function emitManagedArrayPointer(expression: Expr): string {
  return `vexa::arrayPointer(${emitExpression(expression)})`;
}

function isArrayExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === "array" || type?.kind === "tuple" || type?.kind === "range" ||
    (type?.kind === "named" && new Set(["Array", "ReadonlyArray", "ConcatArray"]).has(type.name)) ||
    expression.kind === "ArrayLiteral" || expression.kind === "RangeExpression";
}

function nativeCollectionKind(expression: Expr): "map" | "set" | "weakMap" | "weakSet" | null {
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind !== "named") return null;
  if (type.name === "Map" || type.name === "ReadonlyMap") return "map";
  if (type.name === "Set" || type.name === "ReadonlySet") return "set";
  if (type.name === "WeakMap") return "weakMap";
  if (type.name === "WeakSet") return "weakSet";
  return null;
}

function isDateExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === "named" && type.name === "Date";
}

function nativeBinaryObjectKind(expression: Expr): "buffer" | "uint8" | "dataView" | null {
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind !== "named") return null;
  if (type.name === "ArrayBuffer") return "buffer";
  if (type.name === "Uint8Array") return "uint8";
  if (type.name === "DataView") return "dataView";
  return null;
}

function emitNativeCollectionConstruction(call: CallExpression | NewExpression, name: "Map" | "Set" | "WeakMap" | "WeakSet"): string {
  const argumentsList = call.arguments ?? [];
  if (argumentsList.length > 1) throw new CppEmitError(`C++ ${name} construction expects at most one iterable`, call);
  let mapped = cppTypeForExpression(call as unknown as Expr);
  let explicit: string[] = [];
  if (call.typeArguments?.length) {
    explicit = call.typeArguments.map((argument) => cppTypeForDeclaredName(argument.name) ?? "vexa::Value");
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
  if (!mapped.endsWith("*")) {
    throw new CppEmitError(`C++ cannot resolve ${name} type arguments`, call);
  }
  if (argumentsList.length === 1) {
    if (name === "WeakMap" || name === "WeakSet") {
      throw new CppEmitError(`C++ ${name} iterable construction is not implemented yet`, call);
    }
    const values = argumentsList[0]!;
    if (!isManagedArrayExpression(values)) {
      throw new CppEmitError(`C++ ${name} iterable construction requires a native array`, call);
    }
    if (name === "Map") {
      const analysisType = activeExpressionTypes.get(call as Node);
      const inferred = analysisType?.kind === "named"
        ? (analysisType.typeArguments ?? []).map((argument) => cppTypeForAnalysisType(argument) ?? "vexa::Value")
        : [];
      const types = explicit.length === 2 ? explicit : inferred;
      if (types.length < 2) throw new CppEmitError("C++ cannot infer Map entry types", call);
      return `vexa::mapFromEntries<${types[0]}, ${types[1]}>(${activeRuntimeName}, ${emitManagedArrayPointer(values)})`;
    }
    const analysisType = activeExpressionTypes.get(call as Node);
    const inferred = analysisType?.kind === "named"
      ? cppTypeForAnalysisType(analysisType.typeArguments?.[0] ?? { kind: "builtin", name: "any" }) ?? "vexa::Value"
      : "vexa::Value";
    return `vexa::setFromArray<${explicit[0] ?? inferred}>(${activeRuntimeName}, ${emitManagedArrayPointer(values)})`;
  }
  return `${activeRuntimeName}.make<${mapped.slice(0, -1)}>()`;
}

function isRecordExpression(expression: Expr): boolean {
  return activeExpressionTypes.get(expression as Node)?.kind === "object" || expression.kind === "ObjectLiteral";
}

function isGeneratorExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind === "named" && (type.name === "Generator" || type.name === "AsyncGenerator")) return true;
  if (expression.kind !== "CallExpression") return false;
  const call = expression as CallExpression;
  const functionName = identifierName(call.callee);
  if (functionName && activeFunctionStatements.get(functionName)?.generator) return true;
  const member = memberParts(call.callee);
  const method = member ? classMethodForMember(member) : null;
  return method?.kind === "ClassMethodMember" && Boolean(method.generator);
}

function emitConvertedValue(expression: Expr, resultType: string): string {
  const sourceType = activeExpressionTypes.get(expression as Node);
  const alreadyDynamicRecordMember = expression.kind === "MemberExpression" &&
    activeExpressionTypes.get((expression as MemberExpression).object as Node)?.kind === "object";
  if (resultType === "vexa::Value" && sourceType?.kind === "function" && !alreadyDynamicRecordMember) {
    const callableResult = cppTypeForAnalysisType(sourceType.returnType) ?? "vexa::Value";
    const callableParameters = sourceType.parameters.map((parameter) =>
      cppTypeForAnalysisType(parameter.type) ?? "vexa::Value");
    const templateArguments = [callableResult, ...callableParameters].join(", ");
    const captureNames = nativeFunctionCaptureNames(expression);
    const roots = nativeLambdaRootValues(captureNames);
    const previousFunctionObjectCapture = activeFunctionObjectCapture;
    const previousFunctionObjectCaptureNames = activeFunctionObjectCaptureNames;
    activeFunctionObjectCapture = true;
    activeFunctionObjectCaptureNames = captureNames;
    try {
      return `vexa::Value(vexa::makeFunction<${templateArguments}>(${activeRuntimeName}, ${emitExpression(expression)}, {${roots.join(", ")}}))`;
    } finally {
      activeFunctionObjectCapture = previousFunctionObjectCapture;
      activeFunctionObjectCaptureNames = previousFunctionObjectCaptureNames;
    }
  }
  return `vexa::convertValue<${resultType}>(${activeRuntimeName}, ${emitExpression(expression)})`;
}

function emitArrayLiteral(array: ArrayLiteral): string {
  const type = cppTypeForExpression(array as unknown as Expr);
  const elementType = managedArrayElementType(type);
  if (!elementType) {
    throw new CppEmitError("C++ emission requires arrays with one supported element type");
  }
  const emitElement = (element: Expr): string => {
    const emitted = emitExpression(element);
    return elementType === "std::string" ? `vexa::toString(${emitted})` : emitted;
  };
  const hasExpandedElements = array.elements.some((element) =>
    element.kind === "ArrayHole" || element.kind === "SpreadExpression");
  if (hasExpandedElements) {
    const operations = array.elements.map((element) => {
      if (element.kind === "ArrayHole") {
        if (elementType !== "vexa::Value") {
          throw new CppEmitError("C++ sparse arrays require a dynamic value element type");
        }
        return "vexa::push(__vexa_array, vexa::Value::undefined())";
      }
      if (element.kind === "SpreadExpression") {
        const argument = (element as SpreadExpression).argument;
        const source = isManagedArrayExpression(argument)
          ? emitManagedArrayPointer(argument)
          : emitExpression(argument);
        return elementType === "vexa::Value"
          ? `vexa::appendAllConverted(${activeRuntimeName}, __vexa_array, ${source})`
          : `vexa::appendAll(__vexa_array, ${source})`;
      }
      const value = elementType === "vexa::Value"
        ? emitConvertedValue(element as Expr, "vexa::Value")
        : emitElement(element as Expr);
      return `vexa::push(__vexa_array, ${value})`;
    });
    return `([&]() { auto* __vexa_array = ${activeRuntimeName}.array<${elementType}>(); ${operations.join("; ")}; return __vexa_array; }())`;
  }
  const elements = elementType === "vexa::Value"
    ? array.elements.map((element) => emitConvertedValue(element as Expr, "vexa::Value"))
    : array.elements.map((element) => emitElement(element as Expr));
  return `${activeRuntimeName}.array<${elementType}>({${elements.join(", ")}})`;
}

function objectPropertyName(property: ObjectProperty): string | null {
  if (property.computed) return null;
  if (property.key.kind === "Identifier") return (property.key as Identifier).name;
  if (property.key.kind === "StringLiteral") {
    return (property.key as unknown as { value: string }).value;
  }
  if (property.key.kind === "IntLiteral" || property.key.kind === "FloatLiteral") {
    return String((property.key as unknown as { value: number }).value);
  }
  return null;
}

function emitObjectLiteral(object: ObjectLiteral): string {
  const simple = object.properties.every((property) =>
    property.kind === "ObjectProperty" &&
    !(property as ObjectProperty).computed &&
    !(property as ObjectProperty).method);
  if (simple) {
    const properties = object.properties.map((property) => {
      const objectProperty = property as ObjectProperty;
      const name = objectPropertyName(objectProperty)!;
      return `{${cppString(name)}, ${emitConvertedValue(objectProperty.value, "vexa::Value")}}`;
    });
    return `${activeRuntimeName}.record({${properties.join(", ")}})`;
  }

  const operations = object.properties.map((property) => {
    if (property.kind === "ObjectSpreadProperty") {
      return `vexa::recordSpread(__vexa_record, ${emitExpression(property.argument)})`;
    }
    const objectProperty = property as ObjectProperty;
    const name = objectPropertyName(objectProperty);
    const key = objectProperty.computed
      ? `vexa::propertyKey(${emitExpression(objectProperty.key)})`
      : cppString(name!);
    return `vexa::recordSet(${activeRuntimeName}, __vexa_record, ${key}, ${emitConvertedValue(objectProperty.value, "vexa::Value")})`;
  });
  return `([&]() { auto* __vexa_record = ${activeRuntimeName}.record(); ${operations.join("; ")}; return __vexa_record; }())`;
}

type CallableParameter = FunctionParameter | ClassPrimaryConstructorParameter;

function callableParameterName(parameter: CallableParameter): string | null {
  return parameter.name.kind === "Identifier" ? (parameter.name as Identifier).name : null;
}

function isSupportedDefaultExpression(expression: Expr): boolean {
  return new Set([
    "IntLiteral",
    "LongLiteral",
    "BigIntLiteral",
    "FloatLiteral",
    "BooleanLiteral",
    "StringLiteral",
    "NullLiteral",
    "UndefinedLiteral",
  ]).has(expression.kind);
}

function emitArguments(argumentsList: readonly Expr[], parameters?: readonly CallableParameter[]): string {
  if (!parameters) {
    return argumentsList.map(emitExpression).join(", ");
  }
  return orderedCallArguments(argumentsList, parameters).map((argument, index) => {
    const parameterType = parameters[index]?.typeAnnotation?.name;
    return parameterType && activeInterfaceNames.has(parameterType) && isRecordExpression(argument)
      ? emitRecordInterfaceAdaptation(argument, parameterType)
      : emitExpression(argument);
  }).join(", ");
}

function orderedCallArguments(
  argumentsList: readonly Expr[],
  parameters: readonly CallableParameter[]
): Expr[] {
  const ordered: Array<Expr | undefined> = new Array(parameters.length);
  let positionalIndex = 0;
  for (const argument of argumentsList) {
    if (argument.kind === "NamedArgument") {
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
    if (!ordered[index] && parameters[index]?.defaultValue) {
      ordered[index] = parameters[index]!.defaultValue;
    }
  }
  if (ordered.some((argument) => argument === undefined)) {
    throw new CppEmitError("C++ emission could not resolve every required call argument");
  }
  return ordered as Expr[];
}

function emitCallArguments(call: CallExpression, parameters?: readonly CallableParameter[]): string {
  return emitArguments(call.arguments, parameters);
}

function withRuntimeArgument(argumentsText: string): string {
  return `${activeRuntimeName}${argumentsText ? `, ${argumentsText}` : ""}`;
}

function classNameForExpression(expression: Expr): string | null {
  if (expression.kind === "Identifier") {
    const name = (expression as Identifier).name;
    if (name === "this") return activeCurrentClassName;
    const tracked = activeGcObjectTypes.get(name);
    if (tracked) return parseTypeNameShape(tracked).baseName;
    if (isNativeObjectTypeName(name)) return null;
  }
  if (expression.kind === "CallExpression") {
    const calleeName = identifierName((expression as CallExpression).callee);
    if (calleeName && activeClassNames.has(calleeName)) return calleeName;
  }
  if (expression.kind === "NewExpression") {
    const calleeName = identifierName((expression as NewExpression).callee);
    if (calleeName && activeClassNames.has(calleeName)) return calleeName;
  }
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === "named" && isNativeObjectTypeName(type.name)
    ? parseTypeNameShape(type.name).baseName
    : null;
}

function staticClassNameForExpression(expression: Expr): string | null {
  if (expression.kind !== "Identifier") return null;
  const name = (expression as Identifier).name;
  return activeClassNames.has(name) && !activeLocalNames.has(name) ? name : null;
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
  return member?.kind === "InterfaceMethodMember" ? member : null;
}

function interfacePropertyForName(statement: InterfaceStatement, propertyName: string): InterfacePropertyMember | null {
  const member = interfaceMemberForName(statement, propertyName);
  return member?.kind === "InterfacePropertyMember" ? member : null;
}

function interfacePropertyForMember(member: { object: Expr; propertyName: string }): InterfacePropertyMember | null {
  const typeName = classNameForExpression(member.object);
  const statement = typeName ? activeInterfaceStatements.get(typeName) : undefined;
  return statement ? interfacePropertyForName(statement, member.propertyName) : null;
}

interface NativePropertyMember {
  kind: "method" | "record" | "dynamic" | "extension";
  expression: Expr;
  receiver: Expr | null;
  propertyName: string;
  getterName: string | null;
  setterName: string | null;
  keyExpression?: Expr;
}

function resolvedNativePropertyMember(expression: Expr): NativePropertyMember | null {
  if (expression.kind === "Identifier" && activeImplicitReceiverIdentifiers.has(expression as Node)) {
    const propertyName = (expression as Identifier).name;
    const statement = activeCurrentClassName
      ? activeClassStatements.get(activeCurrentClassName)
      : undefined;
    if (!statement || activeCurrentMethodStatic) return null;
    const getter = classGetterForName(statement, propertyName);
    const setter = classSetterForName(statement, propertyName);
    return getter || setter ? {
      kind: "method",
      expression,
      receiver: null,
      propertyName,
      getterName: getter ? cppName(propertyName) : null,
      setterName: setter ? cppName(propertyName) : null,
    } : null;
  }
  if (expression.kind !== "MemberExpression") return null;
  const member = expression as MemberExpression;
  const extensionResolution = activeExtensionPropertyResolutions.get(member as Node);
  if (extensionResolution) {
    const declaration = extensionResolution.declaration;
    const getter = declaration.initializer || declaration.accessors?.some((accessor) => accessor.accessorKind === "get");
    const setter = declaration.accessors?.some((accessor) => accessor.accessorKind === "set");
    return {
      kind: "extension",
      expression,
      receiver: member.object,
      propertyName: (declaration.name as Identifier).name,
      getterName: getter ? extensionPropertyCppName(declaration) : null,
      setterName: setter ? extensionPropertyCppName(declaration, true) : null,
    };
  }
  const propertyName = !member.computed ? identifierName(member.property) : null;
  if (cppTypeForExpression(member.object) === "vexa::Value") {
    if (!member.computed && !propertyName) return null;
    return {
      kind: "dynamic",
      expression,
      receiver: member.object,
      propertyName: propertyName ?? "<computed>",
      getterName: propertyName ?? "<computed>",
      setterName: propertyName ?? "<computed>",
      ...(member.computed ? { keyExpression: member.property } : {}),
    };
  }
  if (activeExpressionTypes.get(member.object as Node)?.kind === "object") {
    if (!member.computed && !propertyName) return null;
    return {
      kind: "record",
      expression,
      receiver: member.object,
      propertyName: propertyName ?? "<computed>",
      getterName: propertyName ?? "<computed>",
      setterName: propertyName ?? "<computed>",
      ...(member.computed ? { keyExpression: member.property } : {}),
    };
  }
  if (!propertyName) return null;
  const interfaceProperty = interfacePropertyForMember({ object: member.object, propertyName });
  if (interfaceProperty) {
    return {
      kind: "method",
      expression,
      receiver: member.object,
      propertyName,
      getterName: interfacePropertyGetterName(propertyName),
      setterName: isMutableInterfaceProperty(interfaceProperty)
        ? interfacePropertySetterName(propertyName)
        : null,
    };
  }
  const className = classNameForExpression(member.object);
  const statement = className ? activeClassStatements.get(className) : undefined;
  if (!statement) return null;
  const getter = classGetterForName(statement, propertyName);
  const setter = classSetterForName(statement, propertyName);
  return getter || setter ? {
    kind: "method",
    expression,
    receiver: member.object,
    propertyName,
    getterName: getter ? cppName(propertyName) : null,
    setterName: setter ? cppName(propertyName) : null,
  } : null;
}

function emitNativePropertyKey(property: NativePropertyMember): string {
  return property.keyExpression
    ? `vexa::propertyKey(${emitExpression(property.keyExpression)})`
    : cppString(property.propertyName);
}

function emitNativePropertyGet(
  property: NativePropertyMember,
  receiver: string,
  key?: string
): string {
  if (property.kind === "record") {
    const resultType = cppTypeForExpression(property.expression);
    return `vexa::recordGet<${resultType === "auto" ? "vexa::Value" : resultType}>(${activeRuntimeName}, ${receiver}, ${key ?? emitNativePropertyKey(property)})`;
  }
  if (property.kind === "dynamic") {
    return `vexa::dynamicGet(${activeRuntimeName}, ${receiver}, ${key ?? emitNativePropertyKey(property)})`;
  }
  if (property.kind === "extension") {
    return `${property.getterName}(${activeRuntimeName}, ${receiver})`;
  }
  return `${receiver}->${property.getterName}(${activeRuntimeName})`;
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
    return `vexa::dynamicSet(${activeRuntimeName}, ${receiver}, ${key ?? emitNativePropertyKey(property)}, vexa::convertValue<vexa::Value>(${activeRuntimeName}, ${value}))`;
  }
  if (property.kind === "extension") {
    return `${property.setterName}(${activeRuntimeName}, ${receiver}, ${value})`;
  }
  return `${receiver}->${property.setterName}(${activeRuntimeName}, ${value})`;
}

function emitPropertyAssignment(
  assignment: AssignmentExpression,
  property: NativePropertyMember
): string {
  if (!property.setterName) {
    throw new CppEmitError(`C++ cannot assign to read-only property '${property.propertyName}'`);
  }
  const receiver = property.receiver ? emitExpression(property.receiver) : activeThisExpression;
  const keyDeclaration = (property.kind === "record" || property.kind === "dynamic") && property.keyExpression
    ? ` auto __vexa_property_key = ${emitNativePropertyKey(property)};`
    : "";
  const key = (property.kind === "record" || property.kind === "dynamic") && property.keyExpression
    ? "__vexa_property_key"
    : undefined;
  if (assignment.operator === "=") {
    const assignedValue = property.kind === "dynamic" && activeExpressionTypes.get(assignment.right as Node)?.kind === "function"
      ? emitConvertedValue(assignment.right, "vexa::Value")
      : emitExpression(assignment.right);
    return `([&]() { ${property.kind === "extension" || property.kind === "dynamic" ? "auto" : "auto*"} __vexa_property_receiver = ${receiver};${keyDeclaration} auto __vexa_property_value = ${assignedValue}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)}; return __vexa_property_value; }())`;
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
  const value = propertyType === "vexa::Value"
    ? emitDynamicBinaryText(binaryOperator, "__vexa_property_current", "__vexa_property_operand") ??
      `(__vexa_property_current ${binaryOperator} __vexa_property_operand)`
    : `(__vexa_property_current ${binaryOperator} __vexa_property_operand)`;
  return `([&]() { ${property.kind === "extension" || property.kind === "dynamic" ? "auto" : "auto*"} __vexa_property_receiver = ${receiver};${keyDeclaration} auto __vexa_property_current = ${emitNativePropertyGet(property, "__vexa_property_receiver", key)}; auto __vexa_property_operand = ${emitExpression(assignment.right)}; auto __vexa_property_value = ${value}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)}; return __vexa_property_value; }())`;
}

function emitPropertyUpdate(
  update: UpdateExpression,
  property: NativePropertyMember
): string {
  if (!property.setterName) {
    throw new CppEmitError(`C++ cannot update read-only property '${property.propertyName}'`);
  }
  if (!property.getterName) {
    throw new CppEmitError(`C++ cannot update write-only property '${property.propertyName}'`);
  }
  const delta = update.operator === "++" ? "+" : "-";
  const returned = update.prefix ? "__vexa_property_value" : "__vexa_property_current";
  const receiver = property.receiver ? emitExpression(property.receiver) : activeThisExpression;
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
  const updated = propertyType === "vexa::Value"
    ? emitDynamicBinaryText(delta, "__vexa_property_current", "1") ?? `(__vexa_property_current ${delta} 1)`
    : `(__vexa_property_current ${delta} 1)`;
  return `([&]() { ${property.kind === "extension" || property.kind === "dynamic" ? "auto" : "auto*"} __vexa_property_receiver = ${receiver};${keyDeclaration} auto __vexa_property_current = ${emitNativePropertyGet(property, "__vexa_property_receiver", key)}; auto __vexa_property_value = ${updated}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)}; return ${returned}; }())`;
}

function classMethodForMember(
  member: { object: Expr; propertyName: string }
): ClassMethodMember | InterfaceMethodMember | null {
  const className = staticClassNameForExpression(member.object) ?? classNameForExpression(member.object);
  if (!className) return null;
  const classStatement = activeClassStatements.get(className);
  const classMethod = classStatement ? classMethodForName(classStatement, member.propertyName) : null;
  if (classMethod) return classMethod;
  const interfaceStatement = activeInterfaceStatements.get(className);
  return interfaceStatement ? interfaceMethodForName(interfaceStatement, member.propertyName) : null;
}

function classMethodForName(
  statement: ClassStatement,
  methodName: string,
  visited = new Set<string>()
): ClassMethodMember | null {
  if (visited.has(statement.name.name)) return null;
  visited.add(statement.name.name);
  const own = statement.members.find((candidate): candidate is ClassMethodMember =>
    candidate.kind === "ClassMethodMember" && candidate.name.name === methodName);
  if (own) return own;
  const parent = statement.extendsType
    ? activeClassStatements.get(parseTypeNameShape(statement.extendsType.name).baseName)
    : undefined;
  return parent ? classMethodForName(parent, methodName, visited) : null;
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
  return statement.members.find((member): member is ClassMethodMember =>
    member.kind === "ClassMethodMember" &&
    member.name.name === propertyName &&
    (member.getterShorthand === true || member.accessorKind === "get")) ?? null;
}

function classSetterForName(
  statement: ClassStatement,
  propertyName: string
): ClassMethodMember | null {
  return statement.members.find((member): member is ClassMethodMember =>
    member.kind === "ClassMethodMember" &&
    member.name.name === propertyName &&
    member.accessorKind === "set") ?? null;
}

function classGetterForMember(
  member: { object: Expr; propertyName: string }
): ClassMethodMember | null {
  const className = classNameForExpression(member.object);
  const statement = className ? activeClassStatements.get(className) : undefined;
  return statement ? classGetterForName(statement, member.propertyName) : null;
}

function classUsesRuntimeConstructor(statement: ClassStatement | undefined): boolean {
  return Boolean(statement && (
    statement.members.some((member) => member.kind === "ClassFieldMember") ||
    classConstructorMethod(statement)
  ));
}

function classConstructorMethod(statement: ClassStatement | undefined): ClassMethodMember | null {
  return statement?.members.find((member): member is ClassMethodMember =>
    member.kind === "ClassMethodMember" && member.name.name === "constructor") ?? null;
}

function classConstructorParameters(statement: ClassStatement | undefined): readonly CallableParameter[] | undefined {
  return classConstructorMethod(statement)?.parameters ?? statement?.primaryConstructorParameters;
}

function nativeLambdaCapture(selfName: string, referenceEntryLocals: boolean): {
  text: string;
  thisExpression: string;
} {
  if (!activeFunctionObjectCapture && referenceEntryLocals && activeRuntimeName === "runtime") {
    return { text: "[&]", thisExpression: activeThisExpression };
  }
  const captures = ["="];
  for (const [sourceName, className] of activeGcObjectTypes) {
    if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
    const name = cppName(sourceName);
    captures.push(activeFunctionObjectCapture
      ? `${name} = vexa::rawPointer(${name})`
      : `${name} = cppgc::Persistent<${cppName(className)}>(${name})`);
  }
  for (const [sourceName, pointeeType] of activeGcArrayTypes) {
    if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
    const name = cppName(sourceName);
    captures.push(activeFunctionObjectCapture
      ? `${name} = vexa::arrayPointer(${name})`
      : `${name} = cppgc::Persistent<${pointeeType}>(vexa::arrayPointer(${name}))`);
  }
  if (activeFunctionObjectCapture) {
    for (const sourceName of activeDynamicValueNames) {
      if (activeFunctionObjectCaptureNames && !activeFunctionObjectCaptureNames.has(sourceName)) continue;
      const name = cppName(sourceName);
      captures.push(`${name} = vexa::StoredValue(${name})`);
    }
  }
  const rootThis = activeCurrentClassName !== null && !activeCurrentMethodStatic &&
    (!activeFunctionObjectCaptureNames || activeFunctionObjectCaptureNames.has("this"));
  if (rootThis) {
    captures.push(activeFunctionObjectCapture
      ? `${selfName} = this`
      : `${selfName} = cppgc::Persistent<${cppName(activeCurrentClassName!)}>(this)`);
  }
  captures.push(`&${activeRuntimeName}`);
  return {
    text: `[${captures.join(", ")}]`,
    thisExpression: rootThis ? selfName : activeThisExpression,
  };
}

function nativeFunctionCaptureNames(expression: Expr): Set<string> {
  if (expression.kind !== "ArrowFunctionExpression" && expression.kind !== "FunctionExpression") return new Set();
  const callable = expression as ArrowFunctionExpression | FunctionExpression;
  const declared = new Set(callable.parameters.flatMap((parameter) =>
    parameter.name.kind === "Identifier" ? [parameter.name.name] : bindingIdentifiers(parameter.name).map((name) => name.name)));
  const used = new Set<string>();
  const visit = (node: Node): void => {
    if (node.kind === "VarStatement") {
      const variable = node as VarStatement;
      for (const name of bindingIdentifiers(variable.declarations?.[0]?.name ?? variable.name)) declared.add(name.name);
    }
    if (node.kind === "Identifier") used.add((node as Identifier).name);
    for (const child of childNodes(node)) visit(child);
  };
  visit(callable.body);
  for (const name of declared) used.delete(name);
  return used;
}

function nativeLambdaRootValues(captureNames: ReadonlySet<string>): string[] {
  const roots = [
    ...[...activeGcObjectTypes.keys()].filter((name) => captureNames.has(name)).map((sourceName) => `vexa::convertValue<vexa::Value>(${activeRuntimeName}, vexa::rawPointer(${cppName(sourceName)}))`),
    ...[...activeGcArrayTypes.keys()].filter((name) => captureNames.has(name)).map((sourceName) => `vexa::convertValue<vexa::Value>(${activeRuntimeName}, vexa::arrayPointer(${cppName(sourceName)}))`),
    ...[...activeDynamicValueNames].filter((name) => captureNames.has(name)).map((sourceName) => `vexa::convertValue<vexa::Value>(${activeRuntimeName}, ${cppName(sourceName)})`),
  ];
  if (activeCurrentClassName !== null && !activeCurrentMethodStatic && captureNames.has("this")) {
    roots.push(`vexa::convertValue<vexa::Value>(${activeRuntimeName}, this)`);
  }
  return roots;
}

function emitNativeLambda(parametersList: readonly FunctionParameter[], body: Expr | BlockStatement): string {
  const capture = nativeLambdaCapture("__vexa_callback_self", true);
  const parameters = callableParameters(parametersList, undefined, false, true);
  const previousLocalNames = activeLocalNames;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousGcArrayTypes = activeGcArrayTypes;
  const previousDynamicValueNames = activeDynamicValueNames;
  const previousThisExpression = activeThisExpression;
  activeLocalNames = new Set([...activeLocalNames, ...parameters.names]);
  activeGcObjectTypes = new Map([...activeGcObjectTypes, ...parameters.gcTypes]);
  activeGcArrayTypes = new Map([...activeGcArrayTypes, ...parameters.gcArrayTypes]);
  activeDynamicValueNames = new Set([...activeDynamicValueNames, ...parameters.dynamicNames]);
  activeThisExpression = capture.thisExpression;
  try {
    const prefix = `${capture.text}(${parameters.text})${activeRuntimeName === "runtime" ? "" : " mutable"}`;
    return body.kind === "BlockStatement"
      ? `${prefix} ${emitBlock(body as BlockStatement, "")}`
      : `${prefix} { return ${emitExpression(body as Expr)}; }`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeThisExpression = previousThisExpression;
  }
}

function emitAsyncNativeLambda(
  expression: ArrowFunctionExpression | FunctionExpression,
  parametersList: readonly FunctionParameter[],
  body: Expr | BlockStatement
): string {
  const functionType = activeExpressionTypes.get(expression as Node);
  const analyzedReturn = functionType?.kind === "function" ? functionType.returnType : null;
  const taskType = analyzedReturn ? cppTypeForAnalysisType(analyzedReturn) : null;
  const resultType = taskType?.startsWith("vexa::Task<") && taskType.endsWith(">")
    ? taskType.slice("vexa::Task<".length, -1)
    : analyzedReturn ? cppTypeForAnalysisType(analyzedReturn) ?? "vexa::Value" : "vexa::Value";
  const capture = nativeLambdaCapture("__vexa_async_callback_self", true);
  const parameters = callableParameters(parametersList, undefined, false, true);
  const previousLocalNames = activeLocalNames;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousGcArrayTypes = activeGcArrayTypes;
  const previousDynamicValueNames = activeDynamicValueNames;
  const previousThisExpression = activeThisExpression;
  const previousAsyncResultType = activeAsyncResultType;
  const previousCallableResultType = activeCallableResultType;
  activeLocalNames = new Set([...activeLocalNames, ...parameters.names]);
  activeGcObjectTypes = new Map([...activeGcObjectTypes, ...parameters.gcTypes]);
  activeGcArrayTypes = new Map([...activeGcArrayTypes, ...parameters.gcArrayTypes]);
  activeDynamicValueNames = new Set([...activeDynamicValueNames, ...parameters.dynamicNames]);
  activeThisExpression = capture.thisExpression;
  activeAsyncResultType = resultType;
  activeCallableResultType = `vexa::Task<${resultType}>`;
  try {
    const emittedBody = body.kind === "BlockStatement"
      ? emitAsyncCallableBlock(body as BlockStatement, "", resultType)
      : resultType === "void"
        ? `{ ${emitExpression(body as Expr)}; co_return; }`
        : `{ co_return ${emitConvertedValue(body as Expr, resultType)}; }`;
    return `${capture.text}(${parameters.text}) mutable -> vexa::Task<${resultType}> ${emittedBody}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeThisExpression = previousThisExpression;
    activeAsyncResultType = previousAsyncResultType;
    activeCallableResultType = previousCallableResultType;
  }
}

function emitArrowFunction(expression: ArrowFunctionExpression): string {
  if (expression.async || expression.sync) {
    return emitAsyncNativeLambda(expression, expression.parameters, expression.body);
  }
  return emitNativeLambda(expression.parameters, expression.body);
}

function emitFunctionExpression(expression: FunctionExpression): string {
  if (expression.generator || expression.typeParameters?.length) {
    throw new CppEmitError("C++ emission currently supports non-generic, non-generator function expressions only");
  }
  if (expression.async || expression.sync) {
    return emitAsyncNativeLambda(expression, expression.parameters, expression.body);
  }
  return emitNativeLambda(expression.parameters, expression.body);
}

function emitClassConstruction(
  callee: Expr,
  argumentsList: readonly Expr[],
  resultExpression?: Expr
): string {
  const className = identifierName(callee);
  if (!className || !activeClassNames.has(className)) {
    throw new CppEmitError("C++ explicit construction currently supports generated classes only");
  }
  const classStatement = activeClassStatements.get(className);
  const constructorArguments = emitArguments(argumentsList, classConstructorParameters(classStatement));
  const nativeArguments = classUsesRuntimeConstructor(classStatement)
    ? withRuntimeArgument(constructorArguments)
    : constructorArguments;
  const mappedResultType = resultExpression ? cppTypeForExpression(resultExpression) : "auto";
  const constructedType = mappedResultType.endsWith("*")
    ? mappedResultType.slice(0, -1)
    : cppName(className);
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
    const capture = [`&${activeRuntimeName}`, ...captures].join(", ");
    const argumentsText = orderedArguments.map((_, index) => `__vexa_timer_argument_${index}`).join(", ");
    return `[${capture}]() mutable { ${cppName(functionName!)}(${activeRuntimeName}${argumentsText ? `, ${argumentsText}` : ""}); }`;
  }
  const callback = emitExpression(expression);
  const dynamic = cppTypeForExpression(expression) === "vexa::Value";
  const capture = [`&${activeRuntimeName}`, `__vexa_timer_callback = ${callback}`, ...captures].join(", ");
  const argumentsText = orderedArguments.map((_, index) => `__vexa_timer_argument_${index}`);
  const invocation = dynamic
    ? `vexa::call(${activeRuntimeName}, __vexa_timer_callback, {${argumentsText.map((argument) =>
        `vexa::convertValue<vexa::Value>(${activeRuntimeName}, ${argument})`).join(", ")}})`
    : `__vexa_timer_callback(${argumentsText.join(", ")})`;
  return `[${capture}]() mutable { ${invocation}; }`;
}

function emitPromiseCall(call: CallExpression): string {
  if (call.arguments.length !== 1 || call.arguments[0]?.kind !== "ArrowFunctionExpression") {
    throw new CppEmitError("C++ Promise construction expects one executor callback");
  }
  const executor = call.arguments[0] as ArrowFunctionExpression;
  if (
    executor.parameters.length !== 2 ||
    executor.parameters.some((parameter) => parameter.name.kind !== "Identifier")
  ) {
    throw new CppEmitError("C++ Promise executors require resolve and reject identifier parameters");
  }

  const promiseType = activeExpressionTypes.get(call as Node);
  const valueType = promiseType?.kind === "named" && promiseType.name === "Promise"
    ? cppTypeForAnalysisType(promiseType.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" }) ?? "vexa::Value"
    : "vexa::Value";
  const parameterNames = executor.parameters.map((parameter) => (parameter.name as Identifier).name);
  const previousLocalNames = activeLocalNames;
  const previousThisExpression = activeThisExpression;
  activeLocalNames = new Set([...activeLocalNames, ...parameterNames]);
  try {
    const capture = nativeLambdaCapture("__vexa_promise_self", true);
    activeThisExpression = capture.thisExpression;
    const body = executor.body.kind === "BlockStatement"
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
  if (type?.kind === "array" || type?.kind === "tuple") return ["Array"];
  if (type?.kind === "builtin") return type.name === "int" ? ["int", "number"] : [type.name];
  if (type?.kind !== "named") return [];
  const names: string[] = [];
  const visit = (name: string): void => {
    const baseName = parseTypeNameShape(name).baseName;
    if (names.includes(baseName)) return;
    names.push(baseName);
    const classStatement = activeClassStatements.get(baseName);
    if (classStatement?.extendsType) visit(classStatement.extendsType.name);
    for (const implementedType of classStatement?.implementsTypes ?? []) visit(implementedType.name);
    const interfaceStatement = activeInterfaceStatements.get(baseName);
    for (const extendedType of interfaceStatement?.extendsTypes ?? []) visit(extendedType.name);
  };
  visit(type.name);
  return names;
}

function extensionFunctionForCall(member: ReturnType<typeof memberParts>): FunctionStatement | null {
  if (!member) return null;
  for (const receiverName of extensionReceiverNamesForExpression(member.object)) {
    const candidate = activeExtensionFunctions.get(receiverName)
      ?.find((statement) => statement.name.name === member.propertyName);
    if (candidate) return candidate;
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
  const receiverArguments = receiverType?.kind === "array" || receiverType?.kind === "tuple"
    ? [receiverType.kind === "array"
        ? receiverType.elementType
        : receiverType.elements[0] ?? { kind: "builtin", name: "unknown" } as AnalysisType]
    : receiverType?.kind === "named"
      ? receiverType.typeArguments ?? []
      : [];
  receiverParameters.forEach((parameter, index) => {
    const mapped = receiverArguments[index]
      ? (receiverType?.kind === "array" || receiverType?.kind === "tuple"
          ? cppArrayElementType(receiverArguments[index]!)
          : cppTypeForAnalysisType(receiverArguments[index]!))
      : null;
    if (mapped) bindings.set(parameter.name, mapped);
  });
  const orderedArguments = orderedCallArguments(argumentsList, statement.parameters);
  statement.parameters.forEach((parameter, index) => {
    const typeName = parameter.typeAnnotation?.name;
    if (!typeName || bindings.has(typeName) || !statement.typeParameters?.some((item) => item.name.name === typeName)) {
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
  const bindings = extensionTemplateArguments(statement, member.object, call.arguments);
  const orderedArguments = orderedCallArguments(call.arguments, statement.parameters);
  const argumentsText = orderedArguments.map((argument, index) => {
    const parameterType = statement.parameters[index]?.typeAnnotation?.name;
    const boundType = parameterType ? bindings.get(parameterType) : null;
    return boundType
      ? emitConvertedValue(argument, boundType)
      : emitExpression(argument);
  }).join(", ");
  const explicitTemplateArguments = cppCallTemplateArguments(call);
  const templateArguments = explicitTemplateArguments || (statement.typeParameters?.length &&
    statement.typeParameters.every((parameter) => bindings.has(parameter.name.name))
      ? `<${statement.typeParameters.map((parameter) => bindings.get(parameter.name.name)).join(", ")}>`
      : "");
  return `${cppName(extensionCppName(statement))}${templateArguments}(${activeRuntimeName}, ${receiver}${argumentsText ? `, ${argumentsText}` : ""})`;
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

function emitCall(call: CallExpression): string {
  const calleeName = identifierName(call.callee);
  if (calleeName === "Promise") return emitPromiseCall(call);
  if (calleeName === "Map" || calleeName === "Set" || calleeName === "WeakMap" || calleeName === "WeakSet") {
    return emitNativeCollectionConstruction(call, calleeName);
  }
  const argumentsText = emitCallArguments(call);
  const member = memberParts(call.callee);
  if (member?.objectName === "console") {
    const supported = new Set(["log", "info", "warn", "error"]);
    if (!supported.has(member.propertyName)) {
      throw new CppEmitError(`C++ emission does not support console.${member.propertyName} yet`);
    }
    return `vexa::console.${member.propertyName}(${argumentsText})`;
  }
  if (member?.objectName === "Math") {
    return `vexa::Math::${cppName(member.propertyName)}(${argumentsText})`;
  }
  if (member?.objectName === "Date" && member.propertyName === "now") {
    if (call.arguments.length !== 0) throw new CppEmitError("C++ Date.now expects no arguments", call);
    return "vexa::dateNow()";
  }
  if (member?.objectName === "Date" && member.propertyName === "parse") {
    if (call.arguments.length !== 1) throw new CppEmitError("C++ Date.parse expects one string", call);
    return `vexa::dateParse(vexa::convertValue<std::string>(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)}))`;
  }
  if (member?.objectName === "Object" && new Set(["keys", "values"]).has(member.propertyName)) {
    if (call.arguments.length !== 1) throw new CppEmitError(`C++ Object.${member.propertyName} expects one object`);
    return `vexa::record${member.propertyName === "keys" ? "Keys" : "Values"}(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)})`;
  }
  if (member?.objectName === "JSON" && (member.propertyName === "parse" || member.propertyName === "stringify")) {
    if (call.arguments.length !== 1) throw new CppEmitError(`C++ JSON.${member.propertyName} expects one argument`, call);
    const argument = emitConvertedValue(call.arguments[0]!, "vexa::Value");
    return member.propertyName === "parse"
      ? `vexa::jsonParse(${activeRuntimeName}, ${argument})`
      : `vexa::jsonStringify(${activeRuntimeName}, ${argument})`;
  }
  if (member?.objectName === "Promise") {
    if (member.propertyName === "resolve") {
      if (call.arguments.length > 1) throw new CppEmitError("C++ Promise.resolve expects zero or one argument");
      return call.arguments.length === 0
        ? `vexa::promiseResolve(${activeRuntimeName}, vexa::Value::undefined())`
        : `vexa::promiseResolve(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)})`;
    }
    if (member.propertyName === "reject") {
      if (call.arguments.length !== 1) throw new CppEmitError("C++ Promise.reject expects one reason");
      const promiseType = activeExpressionTypes.get(call as Node);
      const valueType = promiseType?.kind === "named" && promiseType.name === "Promise"
        ? cppTypeForAnalysisType(promiseType.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" }) ?? "vexa::Value"
        : "vexa::Value";
      return `vexa::rejectedTask<${valueType}>(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)})`;
    }
    const promiseCombinators = new Map([
      ["all", "promiseAll"],
      ["race", "promiseRace"],
      ["allSettled", "promiseAllSettled"],
      ["any", "promiseAny"],
    ]);
    const promiseCombinator = promiseCombinators.get(member.propertyName);
    if (promiseCombinator) {
      if (call.arguments.length !== 1) {
        throw new CppEmitError(`C++ Promise.${member.propertyName} expects one task array`);
      }
      const tasks = isManagedArrayExpression(call.arguments[0]!)
        ? emitManagedArrayPointer(call.arguments[0]!)
        : emitExpression(call.arguments[0]!);
      return `vexa::${promiseCombinator}(${activeRuntimeName}, ${tasks})`;
    }
  }
  if (member && new Set(["then", "catch", "finally"]).has(member.propertyName)) {
    if (call.arguments.length !== 1) {
      throw new CppEmitError(`C++ Promise.${member.propertyName} expects one callback`);
    }
    const helper = member.propertyName === "then"
      ? "promiseThen"
      : member.propertyName === "catch"
        ? "promiseCatch"
        : "promiseFinally";
    return `vexa::${helper}(${activeRuntimeName}, ${emitExpression(member.object)}, ${emitExpression(call.arguments[0]!)})`;
  }
  if (member) {
    const collection = nativeCollectionKind(member.object);
    if (collection === "map") {
      const receiver = emitExpression(member.object);
      if (member.propertyName === "clear") {
        if (call.arguments.length !== 0) throw new CppEmitError("C++ Map.clear expects no arguments", call);
        return `vexa::mapClear(${receiver})`;
      }
      if (member.propertyName === "get" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.arguments.length !== 1) throw new CppEmitError(`C++ Map.${member.propertyName} expects one key`, call);
        const helper = member.propertyName === "get" ? "mapGet" : member.propertyName === "has" ? "mapHas" : "mapDelete";
        const runtime = helper === "mapGet" || helper === "mapHas" || helper === "mapDelete" ? `${activeRuntimeName}, ` : "";
        return `vexa::${helper}(${runtime}${receiver}, ${emitExpression(call.arguments[0]!)})`;
      }
      if (member.propertyName === "set") {
        if (call.arguments.length !== 2) throw new CppEmitError("C++ Map.set expects a key and value", call);
        return `vexa::mapSet(${activeRuntimeName}, ${receiver}, ${emitExpression(call.arguments[0]!)}, ${emitExpression(call.arguments[1]!)})`;
      }
      if (member.propertyName === "forEach") {
        if (call.arguments.length !== 1) throw new CppEmitError("C++ Map.forEach expects one callback", call);
        return `vexa::mapForEach(${receiver}, ${emitExpression(call.arguments[0]!)})`;
      }
      if (member.propertyName === "keys" || member.propertyName === "values" || member.propertyName === "entries") {
        if (call.arguments.length !== 0) throw new CppEmitError(`C++ Map.${member.propertyName} expects no arguments`, call);
        const helper = member.propertyName === "keys" ? "mapKeys" : member.propertyName === "values" ? "mapValues" : "mapEntries";
        return `vexa::${helper}(${activeRuntimeName}, ${receiver})`;
      }
    }
    if (collection === "set") {
      const receiver = emitExpression(member.object);
      if (member.propertyName === "clear") {
        if (call.arguments.length !== 0) throw new CppEmitError("C++ Set.clear expects no arguments", call);
        return `vexa::setClear(${receiver})`;
      }
      if (member.propertyName === "add" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.arguments.length !== 1) throw new CppEmitError(`C++ Set.${member.propertyName} expects one value`, call);
        const helper = member.propertyName === "add" ? "setAdd" : member.propertyName === "has" ? "setHas" : "setDelete";
        return `vexa::${helper}(${activeRuntimeName}, ${receiver}, ${emitExpression(call.arguments[0]!)})`;
      }
      if (member.propertyName === "forEach") {
        if (call.arguments.length !== 1) throw new CppEmitError("C++ Set.forEach expects one callback", call);
        return `vexa::setForEach(${receiver}, ${emitExpression(call.arguments[0]!)})`;
      }
      if (member.propertyName === "keys" || member.propertyName === "values") {
        if (call.arguments.length !== 0) throw new CppEmitError(`C++ Set.${member.propertyName} expects no arguments`, call);
        return `vexa::setValues(${activeRuntimeName}, ${receiver})`;
      }
    }
    if (collection === "weakMap") {
      const receiver = emitExpression(member.object);
      if (member.propertyName === "get" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.arguments.length !== 1) throw new CppEmitError(`C++ WeakMap.${member.propertyName} expects one key`, call);
        const helper = member.propertyName === "get" ? "weakMapGet" : member.propertyName === "has" ? "weakMapHas" : "weakMapDelete";
        return `vexa::${helper}(${activeRuntimeName}, ${receiver}, ${emitExpression(call.arguments[0]!)})`;
      }
      if (member.propertyName === "set") {
        if (call.arguments.length !== 2) throw new CppEmitError("C++ WeakMap.set expects a key and value", call);
        return `vexa::weakMapSet(${activeRuntimeName}, ${receiver}, ${emitExpression(call.arguments[0]!)}, ${emitExpression(call.arguments[1]!)})`;
      }
    }
    if (collection === "weakSet") {
      const receiver = emitExpression(member.object);
      if (member.propertyName === "add" || member.propertyName === "has" || member.propertyName === "delete") {
        if (call.arguments.length !== 1) throw new CppEmitError(`C++ WeakSet.${member.propertyName} expects one value`, call);
        const helper = member.propertyName === "add" ? "weakSetAdd" : member.propertyName === "has" ? "weakSetHas" : "weakSetDelete";
        return `vexa::${helper}(${activeRuntimeName}, ${receiver}, ${emitExpression(call.arguments[0]!)})`;
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
      if (call.arguments.length !== 0) throw new CppEmitError(`C++ Date.${member.propertyName} expects no arguments`, call);
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
      return `${emitExpression(member.object)}->${cppName(member.propertyName)}(${argumentsText})`;
    }
  }
  const arrayRuntimeMethods = new Set([
    "push", "pop", "shift", "unshift", "includes", "indexOf", "join", "reverse",
    "slice", "concat", "map", "filter", "reduce", "forEach", "some", "every",
    "findIndex", "find", "at", "lastIndexOf", "splice", "fill", "copyWithin", "flat", "flatMap", "sort",
  ]);
  if (member && isArrayExpression(member.object) && arrayRuntimeMethods.has(member.propertyName)) {
    const receiver = isManagedArrayExpression(member.object)
      ? emitManagedArrayPointer(member.object)
      : emitExpression(member.object);
    const convertsValueArguments = new Set(["push", "unshift", "includes", "indexOf", "lastIndexOf", "concat", "splice", "fill"])
      .has(member.propertyName);
    const receiverElementType = managedArrayElementType(cppTypeForExpression(member.object));
    const arrayArguments = member.propertyName === "concat"
      ? call.arguments.map((argument) => {
        if (isManagedArrayExpression(argument)) return emitManagedArrayPointer(argument);
        return receiverElementType === "vexa::Value"
          ? emitConvertedValue(argument, "vexa::Value")
          : emitExpression(argument);
      }).join(", ")
      : receiverElementType === "vexa::Value" && convertsValueArguments
        ? call.arguments.map((argument, index) => {
          const converts = member.propertyName === "splice"
            ? index >= 2
            : member.propertyName === "fill"
              ? index === 0
              : true;
          return converts ? emitConvertedValue(argument, "vexa::Value") : emitExpression(argument);
        }).join(", ")
        : argumentsText;
    const allocatesArray = isManagedArrayExpression(member.object) &&
      new Set(["slice", "concat", "map", "filter", "splice", "flat", "flatMap"]).has(member.propertyName);
    return `vexa::${member.propertyName}(${allocatesArray ? `${activeRuntimeName}, ` : ""}${receiver}${arrayArguments ? `, ${arrayArguments}` : ""})`;
  }
  if (member?.propertyName === "return" && isGeneratorExpression(member.object)) {
    if (call.arguments.length > 1) {
      throw new CppEmitError("C++ generator return expects zero or one value");
    }
    return `${emitExpression(member.object)}.finish(${argumentsText})`;
  }
  if (member) {
    const primitiveMethod = new Map([
      ["toString", "toString"],
      ["valueOf", "valueOf"],
      ["toFixed", "toFixed"],
      ["toUpperCase", "toUpperCase"],
      ["toLowerCase", "toLowerCase"],
      ["trim", "trim"],
      ["includes", "stringIncludes"],
      ["startsWith", "startsWith"],
      ["endsWith", "endsWith"],
      ["charAt", "charAt"],
      ["substring", "substring"],
      ["slice", "stringSlice"],
      ["split", "split"],
      ["test", "regexTest"],
    ]).get(member.propertyName);
    if (primitiveMethod) {
      const receiver = emitExpression(member.object);
      const runtimeArgument = primitiveMethod === "split" ? `${activeRuntimeName}, ` : "";
      return `vexa::${primitiveMethod}(${runtimeArgument}${receiver}${argumentsText ? `, ${argumentsText}` : ""})`;
    }
  }

  if (member) {
    const method = classMethodForMember(member);
    if (method) {
      const methodArguments = emitCallArguments(call, method.parameters);
      if (method.kind === "ClassMethodMember" && method.static) {
        const className = staticClassNameForExpression(member.object);
        if (!className) {
          throw new CppEmitError("C++ static methods must be called through their class name");
        }
        return `${cppName(className)}::${cppName(method.name.name)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(methodArguments)})`;
      }
      if (call.typeArguments?.length) {
        return `${emitExpression(member.object)}->${cppName(method.name.name)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(methodArguments)})`;
      }
      return `${emitExpression(call.callee)}(${withRuntimeArgument(methodArguments)})`;
    }
  }

  if (member) {
    const extensionCall = emitExtensionFunctionCall(call, member);
    if (extensionCall) return extensionCall;
  }

  if (calleeName === "setTimeout" || calleeName === "setInterval") {
    if (call.arguments.length < 1) {
      throw new CppEmitError(`C++ ${calleeName} expects a callback, optional delay, and optional callback arguments`);
    }
    const callback = emitTimerCallback(call.arguments[0]!, call.arguments.slice(2));
    const delay = call.arguments[1] ? `, ${emitExpression(call.arguments[1])}` : "";
    return `${activeRuntimeName}.${calleeName}(${callback}${delay})`;
  }
  if (calleeName === "clearTimeout" || calleeName === "clearInterval") {
    if (call.arguments.length !== 1) {
      throw new CppEmitError(`C++ ${calleeName} expects one timer id`);
    }
    return `${activeRuntimeName}.${calleeName}(${emitExpression(call.arguments[0]!)})`;
  }
  if (calleeName === "readTextFile") {
    if (call.arguments.length !== 1) {
      throw new CppEmitError("C++ readTextFile expects one path");
    }
    return `vexa::readTextFile(${activeRuntimeName}, vexa::convertValue<std::string>(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)}))`;
  }
  const runtimeGlobals = new Set(["String", "Number", "Boolean", "BigInt", "Error", "parseInt", "parseFloat", "isNaN", "isFinite"]);
  if (calleeName && runtimeGlobals.has(calleeName)) {
    if (calleeName === "BigInt") return `vexa::makeBigInt(${argumentsText})`;
    return `vexa::${cppName(calleeName)}(${argumentsText})`;
  }
  if (calleeName && activeImplicitReceiverExtensionIdentifiers.has(call.callee as Node)) {
    const receiverName = activeImplicitReceiverExtensionIdentifiers.get(call.callee as Node)!;
    const extension = activeExtensionFunctions.get(receiverName)
      ?.find((statement) => statement.name.name === calleeName);
    if (!extension) {
      throw new CppEmitError(`C++ cannot resolve implicit extension call '${calleeName}'`);
    }
    const methodArguments = emitCallArguments(call, extension.parameters);
    return `${cppName(extensionCppName(extension))}${cppCallTemplateArguments(call)}(${activeRuntimeName}, ${activeThisExpression}${methodArguments ? `, ${methodArguments}` : ""})`;
  }
  if (calleeName && (
    activeImplicitReceiverIdentifiers.has(call.callee as Node) ||
    activeStaticImplicitReceiverIdentifiers.has(call.callee as Node)
  )) {
    const currentClass = activeCurrentClassName ? activeClassStatements.get(activeCurrentClassName) : undefined;
    const method = currentClass?.members.find((candidate): candidate is ClassMethodMember =>
      candidate.kind === "ClassMethodMember" && candidate.name.name === calleeName);
    const methodArguments = emitCallArguments(call, method?.parameters);
    if (method?.static) {
      return `${cppName(activeCurrentClassName!)}::${cppName(calleeName)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(methodArguments)})`;
    }
    if (activeCurrentMethodStatic) {
      throw new CppEmitError("C++ static methods cannot make implicit instance method calls");
    }
    return `${activeThisExpression}->${cppName(calleeName)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(methodArguments)})`;
  }
  const functionStatement = calleeName ? activeFunctionStatements.get(calleeName) : undefined;
  if (calleeName && functionStatement) {
    const functionArguments = emitCallArguments(call, functionStatement.parameters);
    return `${cppName(calleeName)}${cppCallTemplateArguments(call)}(${withRuntimeArgument(functionArguments)})`;
  }
  if (calleeName && activeClassNames.has(calleeName)) {
    return emitClassConstruction(call.callee, call.arguments, call);
  }
  const dynamicRecordCallable = call.callee.kind === "MemberExpression" &&
    activeExpressionTypes.get((call.callee as MemberExpression).object as Node)?.kind === "object";
  if (cppTypeForExpression(call.callee) === "vexa::Value" || dynamicRecordCallable) {
    const dynamicArguments = call.arguments.map((argument) =>
      emitConvertedValue(argument.kind === "NamedArgument" ? (argument as NamedArgument).value : argument, "vexa::Value"));
    return `vexa::call(${activeRuntimeName}, ${emitExpression(call.callee)}, {${dynamicArguments.join(", ")}})`;
  }
  return `${emitExpression(call.callee)}(${argumentsText})`;
}

function isGcObjectExpression(expression: Expr): boolean {
  return classNameForExpression(expression) !== null;
}

function resolvedClassOperator(expression: Expr): ClassMethodMember | null {
  const symbol = activeOperatorResolutions.get(expression as Node);
  return symbol ? activeOperatorMethodsByNameNode.get(symbol.node) ?? null : null;
}

function computedMemberArguments(member: MemberExpression): Expr[] {
  return member.property.kind === "CommaExpression"
    ? (member.property as CommaExpression).expressions
    : [member.property];
}

function emitClassOperatorCall(method: ClassMethodMember, receiver: Expr, argumentsList: readonly Expr[]): string {
  return emitClassOperatorCallText(method, emitExpression(receiver), argumentsList.map(emitExpression));
}

function emitClassOperatorCallText(method: ClassMethodMember, receiverText: string, argumentTexts: readonly string[]): string {
  if (!method.operator) throw new CppEmitError("Resolved C++ operator method is missing its operator kind");
  return `${receiverText}->${cppOperatorMethodName(method.operator, method.parameters)}(${withRuntimeArgument(argumentTexts.join(", "))})`;
}

function emitResolvedBinaryOperator(expression: BinaryExpression): string | null {
  const method = resolvedClassOperator(expression);
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

function dynamicBinaryHelper(operator: string): string | null {
  return new Map<string, string>([
    ["+", "add"], ["-", "subtract"], ["*", "multiply"], ["/", "divide"],
    ["%", "remainder"], ["**", "power"], ["&", "bitwiseAnd"], ["|", "bitwiseOr"],
    ["^", "bitwiseXor"], ["<<", "shiftLeft"], [">>", "shiftRight"], [">>>", "unsignedShiftRight"],
  ]).get(operator) ?? null;
}

function emitDynamicBinaryText(operator: string, left: string, right: string): string | null {
  const helper = dynamicBinaryHelper(operator);
  if (!helper) return null;
  const convertedLeft = `vexa::convertValue<vexa::Value>(${activeRuntimeName}, ${left})`;
  const convertedRight = `vexa::convertValue<vexa::Value>(${activeRuntimeName}, ${right})`;
  return helper === "add"
    ? `vexa::add(${activeRuntimeName}, ${left}, ${right})`
    : `vexa::${helper}(${convertedLeft}, ${convertedRight})`;
}

function emitBinary(expression: BinaryExpression): string {
  const overloaded = emitResolvedBinaryOperator(expression);
  if (overloaded) return overloaded;
  const dynamicOperands = cppTypeForExpression(expression.left) === "vexa::Value" ||
    cppTypeForExpression(expression.right) === "vexa::Value";
  if (dynamicOperands) {
    const dynamic = emitDynamicBinaryText(
      expression.operator,
      emitExpression(expression.left),
      emitExpression(expression.right)
    );
    if (dynamic) return dynamic;
  }
  if (isDateExpression(expression.left) && isDateExpression(expression.right)) {
    const comparison = new Map<string, string>([
      ["<", "<"], [">", ">"], ["<=", "<="], [">=", ">="],
    ]).get(expression.operator);
    if (comparison) {
      return `(${emitExpression(expression.left)}->getTime() ${comparison} ${emitExpression(expression.right)}->getTime())`;
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
    const leftType = cppTypeForExpression(expression.left);
    const left = emitExpression(expression.left);
    if (leftType === "vexa::Value") {
      return `vexa::nullishCoalesce(${left}, [&]() { return ${emitConvertedValue(expression.right, "vexa::Value")}; })`;
    }
    if (leftType.endsWith("*")) {
      return `vexa::nullishCoalesce(${left}, [&]() { return ${emitExpression(expression.right)}; })`;
    }
    return `(${left})`;
  }
  if (expression.operator === "&&" || expression.operator === "||") {
    return `(${emitCondition(expression.left)} ${expression.operator} ${emitCondition(expression.right)})`;
  }
  if (expression.operator === "<=>") {
    const dynamic = cppTypeForExpression(expression.left) === "vexa::Value" ||
      cppTypeForExpression(expression.right) === "vexa::Value";
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
  if ((expression.operator === "is" || expression.operator === "instanceof") && expression.right.kind === "Identifier") {
    const targetName = (expression.right as Identifier).name;
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
    new Set(["<", ">", "<=", ">=", "==", "!="]).has(operator) &&
    (cppTypeForExpression(expression.left) === "vexa::Value" || cppTypeForExpression(expression.right) === "vexa::Value")
  ) {
    const left = emitConvertedValue(expression.left, "vexa::Value");
    const right = emitConvertedValue(expression.right, "vexa::Value");
    if (operator === "==" || operator === "!=") {
      const strict = expression.operator === "===" || expression.operator === "!==";
      const equality = `vexa::${strict ? "strictEquals" : "looseEquals"}(${left}, ${right})`;
      return operator === "!=" ? `(!${equality})` : equality;
    }
    const relation = new Map([["<", "< 0"], [">", "> 0"], ["<=", "<= 0"], [">=", ">= 0"]]).get(operator)!;
    return `(vexa::compare(${left}, ${right}) ${relation})`;
  }
  if (operator === "in" || operator === "is" || operator === "instanceof") {
    throw new CppEmitError(`C++ emission does not support the '${operator}' operator yet`);
  }
  return `(${emitExpression(expression.left)} ${operator} ${emitExpression(expression.right)})`;
}

function emitCondition(expression: Expr): string {
  const emitted = emitExpression(expression);
  const type = cppTypeForExpression(expression);
  return type === "bool" || type === "auto" ? emitted : `vexa::Boolean(${emitted})`;
}

function emitParenthesizedCondition(expression: Expr): string {
  const condition = emitCondition(expression);
  return condition.startsWith("(") && condition.endsWith(")") ? condition : `(${condition})`;
}

function emitExpression(expression: Expr): string {
  switch (expression.kind) {
    case "IntLiteral":
    case "FloatLiteral":
      return String((expression as unknown as { value: number }).value);
    case "BigIntLiteral":
      return `vexa::BigInt(${cppString(String((expression as unknown as { value: bigint }).value))})`;
    case "LongLiteral":
      return `${String((expression as unknown as { value: bigint }).value)}LL`;
    case "BooleanLiteral":
      return (expression as unknown as { value: boolean }).value ? "true" : "false";
    case "StringLiteral":
      return `${activeRuntimeName}.string(${cppString((expression as unknown as { value: string }).value)})`;
    case "RegExpLiteral": {
      const literal = expression as RegExpLiteral;
      return `vexa::RegExp(${cppString(literal.pattern)}, ${cppString(literal.flags)})`;
    }
    case "ArrayLiteral":
      return emitArrayLiteral(expression as unknown as ArrayLiteral);
    case "ObjectLiteral":
      return emitObjectLiteral(expression as ObjectLiteral);
    case "CommaExpression":
      return `(${(expression as CommaExpression).expressions.map(emitExpression).join(", ")})`;
    case "RangeExpression": {
      const range = expression as RangeExpression;
      return `vexa::range(${emitExpression(range.start)}, ${emitExpression(range.end)}, ${range.exclusive ? "true" : "false"})`;
    }
    case "NullLiteral":
      return "vexa::Value::null()";
    case "UndefinedLiteral":
      return "vexa::Value::undefined()";
    case "Identifier":
      return emitIdentifier(expression as Identifier);
    case "BinaryExpression":
      return emitBinary(expression as BinaryExpression);
    case "UnaryExpression": {
      const unary = expression as UnaryExpression;
      const overloaded = resolvedClassOperator(unary);
      if (overloaded) return emitClassOperatorCall(overloaded, unary.argument, []);
      if (unary.operator === "typeof") return `vexa::typeOf(${emitExpression(unary.argument)})`;
      if (unary.operator === "void") return `(static_cast<void>(${emitExpression(unary.argument)}), vexa::Value::undefined())`;
      if (unary.operator === "!") return `(!${emitCondition(unary.argument)})`;
      if (unary.operator === "-" && cppTypeForExpression(unary.argument) === "vexa::Value") {
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
    case "UpdateExpression": {
      const update = expression as UpdateExpression;
      if (update.argument.kind === "MemberExpression") {
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
          return `([&]() { auto* __vexa_array = ${receiver}; auto __vexa_array_index = ${index}; auto __vexa_array_current = vexa::arrayGet(__vexa_array, __vexa_array_index); auto __vexa_array_value = vexa::arraySet(__vexa_array, __vexa_array_index, ${updated}); return ${returned}; }())`;
        }
      }
      const property = resolvedNativePropertyMember(update.argument);
      if (property) {
        return emitPropertyUpdate(update, property);
      }
      if (cppTypeForExpression(update.argument) === "vexa::Value") {
        const current = emitExpression(update.argument);
        const delta = update.operator === "++" ? "+" : "-";
        const updated = emitDynamicBinaryText(delta, "__vexa_update_current", "1")!;
        const returned = update.prefix ? current : "__vexa_update_current";
        return `([&]() { auto __vexa_update_current = ${current}; ${current} = ${updated}; return ${returned}; }())`;
      }
      const text = `${emitExpression(update.argument)}${update.operator}`;
      return update.prefix ? `${update.operator}${emitExpression(update.argument)}` : text;
    }
    case "AssignmentExpression": {
      const assignment = expression as AssignmentExpression;
      const overloaded = resolvedClassOperator(assignment);
      if (overloaded?.operator === "[]=" && assignment.left.kind === "MemberExpression") {
        const member = assignment.left as MemberExpression;
        return emitClassOperatorCall(overloaded, member.object, [assignment.right, ...computedMemberArguments(member)]);
      }
      if (assignment.left.kind === "MemberExpression") {
        const member = assignment.left as MemberExpression;
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
          return `([&]() { auto* __vexa_array = ${receiver}; auto __vexa_array_index = ${index}; auto __vexa_array_value = ${value}; return vexa::arraySet(__vexa_array, __vexa_array_index, __vexa_array_value); }())`;
        }
      }
      const property = resolvedNativePropertyMember(assignment.left);
      if (property) {
        return emitPropertyAssignment(assignment, property);
      }
      const compoundOperator = compoundAssignmentBinaryOperator(assignment.operator);
      if (overloaded?.operator === compoundOperator) {
        const target = emitExpression(assignment.left);
        const call = emitClassOperatorCallText(overloaded, "__vexa_compound_target", [emitExpression(assignment.right)]);
        return `vexa::assignWith(${target}, [&](auto __vexa_compound_target) { return ${call}; })`;
      }
      if (assignment.operator === "+=" && cppTypeForExpression(assignment.left) === "vexa::Value") {
        return `vexa::addAssign(${activeRuntimeName}, ${emitExpression(assignment.left)}, ${emitExpression(assignment.right)})`;
      }
      if (compoundOperator && cppTypeForExpression(assignment.left) === "vexa::Value") {
        const target = emitExpression(assignment.left);
        const value = emitDynamicBinaryText(compoundOperator, "__vexa_compound_current", emitExpression(assignment.right));
        if (value) {
          return `vexa::assignWith(${target}, [&](const vexa::Value& __vexa_compound_current) { return ${value}; })`;
        }
      }
      return `(${emitExpression(assignment.left)} ${assignment.operator} ${emitExpression(assignment.right)})`;
    }
    case "ConditionalExpression": {
      const conditional = expression as ConditionalExpression;
      return `(${emitCondition(conditional.test)} ? ${emitExpression(conditional.consequent)} : ${emitExpression(conditional.alternate)})`;
    }
    case "CallExpression":
      return maybeAutoAwait(expression, emitCall(expression as CallExpression));
    case "NewExpression": {
      const construction = expression as NewExpression;
      const collectionName = identifierName(construction.callee);
      if (collectionName === "Map" || collectionName === "Set" || collectionName === "WeakMap" || collectionName === "WeakSet") {
        return emitNativeCollectionConstruction(construction, collectionName);
      }
      if (collectionName === "Date") {
        if ((construction.arguments?.length ?? 0) > 1) throw new CppEmitError("C++ Date construction expects zero or one timestamp", construction);
        const argument = construction.arguments?.[0];
        const emittedArgument = argument
          ? cppTypeForExpression(argument) === "vexa::Value"
            ? `vexa::convertValue<std::string>(${activeRuntimeName}, ${emitExpression(argument)})`
            : emitExpression(argument)
          : "";
        return `${activeRuntimeName}.make<vexa::DateObject>(${emittedArgument})`;
      }
      if (collectionName === "ArrayBuffer") {
        if ((construction.arguments?.length ?? 0) !== 1) throw new CppEmitError("C++ ArrayBuffer construction expects a byte length", construction);
        return `${activeRuntimeName}.make<vexa::ArrayBufferObject>(static_cast<std::size_t>(${emitExpression(construction.arguments![0] as Expr)}))`;
      }
      if (collectionName === "Uint8Array") {
        if ((construction.arguments?.length ?? 0) !== 1) throw new CppEmitError("C++ Uint8Array construction expects a length, ArrayBuffer, or array", construction);
        const argument = construction.arguments![0] as Expr;
        const emitted = isManagedArrayExpression(argument) ? emitManagedArrayPointer(argument) : emitExpression(argument);
        return `vexa::makeUint8Array(${activeRuntimeName}, ${emitted})`;
      }
      if (collectionName === "DataView") {
        const args = construction.arguments ?? [];
        if (args.length < 1 || args.length > 3) throw new CppEmitError("C++ DataView construction expects a buffer and optional offset/length", construction);
        return `vexa::makeDataView(${activeRuntimeName}, ${args.map(emitExpression).join(", ")})`;
      }
      return emitClassConstruction(construction.callee, construction.arguments ?? [], construction);
    }
    case "ArrowFunctionExpression":
      return emitArrowFunction(expression as ArrowFunctionExpression);
    case "FunctionExpression":
      return emitFunctionExpression(expression as FunctionExpression);
    case "MemberExpression": {
      const member = expression as MemberExpression;
      if (!member.computed && identifierName(member.object) === "super" && member.property.kind === "Identifier") {
        const currentClass = activeCurrentClassName
          ? activeClassStatements.get(activeCurrentClassName)
          : undefined;
        const baseClassName = currentClass?.extendsType?.name;
        if (!baseClassName || !activeClassNames.has(baseClassName)) {
          throw new CppEmitError("C++ super member access requires a generated base class");
        }
        return `${activeThisExpression}->${cppName(baseClassName)}::${cppName((member.property as Identifier).name)}`;
      }
      const overloaded = resolvedClassOperator(member);
      if (overloaded?.operator === "[]") {
        return emitClassOperatorCall(overloaded, member.object, computedMemberArguments(member));
      }
      const enumName = !member.computed ? identifierName(member.object) : null;
      if (enumName && activeEnumNames.has(enumName) && member.property.kind === "Identifier") {
        return `${cppName(enumName)}::${cppName((member.property as Identifier).name)}`;
      }
      if (!member.computed && identifierName(member.object) === "Math" && member.property.kind === "Identifier") {
        return `vexa::Math::${cppName((member.property as Identifier).name)}`;
      }
      if (!member.computed && isArrayExpression(member.object) && identifierName(member.property) === "length") {
        const receiver = isManagedArrayExpression(member.object)
          ? `${emitManagedArrayPointer(member.object)}->size()`
          : `${emitExpression(member.object)}.size()`;
        return `static_cast<double>(${receiver})`;
      }
      if (!member.computed && nativeCollectionKind(member.object) && identifierName(member.property) === "size") {
        return `static_cast<double>(${emitExpression(member.object)}->size())`;
      }
      const binaryKind = nativeBinaryObjectKind(member.object);
      if (!member.computed && binaryKind && member.property.kind === "Identifier") {
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
      const propertyName = !member.computed ? identifierName(member.property) : null;
      const nativeProperty = resolvedNativePropertyMember(expression);
      if (nativeProperty?.kind === "extension") {
        return emitNativePropertyGet(nativeProperty, emitExpression(member.object));
      }
      if (nativeProperty?.kind === "record" || nativeProperty?.kind === "dynamic") {
        if (member.optional) {
          return nativeProperty.kind === "record"
            ? `vexa::recordGetOptional(${emitExpression(member.object)}, ${emitNativePropertyKey(nativeProperty)})`
            : `vexa::dynamicGetOptional(${activeRuntimeName}, ${emitExpression(member.object)}, ${emitNativePropertyKey(nativeProperty)})`;
        }
        return emitNativePropertyGet(nativeProperty, emitExpression(member.object));
      }
      const interfaceProperty = propertyName
        ? interfacePropertyForMember({ object: member.object, propertyName })
        : null;
      if (interfaceProperty) {
        return `${emitExpression(member.object)}->${interfacePropertyGetterName(interfaceProperty.name.name)}(${activeRuntimeName})`;
      }
      const classGetter = propertyName
        ? classGetterForMember({ object: member.object, propertyName })
        : null;
      if (classGetter) {
        return `${emitExpression(member.object)}->${cppName(classGetter.name.name)}(${activeRuntimeName})`;
      }
      return member.computed
        ? isManagedArrayExpression(member.object)
          ? `vexa::arrayGet(${emitManagedArrayPointer(member.object)}, ${emitExpression(member.property)})`
          : `${emitExpression(member.object)}[${emitExpression(member.property)}]`
        : `${emitExpression(member.object)}${isGcObjectExpression(member.object) ? "->" : "."}${cppName((member.property as Identifier).name)}`;
    }
    case "NamedArgument":
      return emitExpression((expression as unknown as { value: Expr }).value);
    case "AsExpression": {
      const source = (expression as unknown as { expression: Expr }).expression;
      const resultType = cppTypeForExpression(expression);
      const sourceType = cppTypeForExpression(source);
      return resultType !== "auto" && resultType !== sourceType
        ? emitConvertedValue(source, resultType)
        : emitExpression(source);
    }
    case "SatisfiesExpression":
    case "NonNullExpression":
      return emitExpression((expression as unknown as { expression: Expr }).expression);
    default:
      throw new CppEmitError(`C++ emission does not support ${expression.kind} expressions yet`);
  }
}

function bindingValueType(binding: BindingName): string {
  if (binding.kind === "Identifier") {
    const mapped = cppTypeForExpression(binding as Identifier);
    return mapped === "auto" ? "vexa::Value" : mapped;
  }
  return binding.kind === "ObjectBindingPattern" ? "vexa::RecordObject*" : "auto";
}

function emitDestructuredBindings(binding: BindingName, source: string, lines: string[]): void {
  if (binding.kind === "Identifier") {
    activeLocalNames.add(binding.name);
    lines.push(`auto ${cppName(binding.name)} = ${source}`);
    return;
  }
  if (binding.kind === "ArrayBindingPattern") {
    (binding as ArrayBindingPattern).elements.forEach((element, index) => {
      if (element.kind === "BindingHole") return;
      if (element.rest) {
        emitDestructuredBindings(element.name, `vexa::slice(${activeRuntimeName}, vexa::arrayPointer(${source}), ${index})`, lines);
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
        `vexa::recordRest(${activeRuntimeName}, ${source}, {${excludedKeys.map(cppString).join(", ")}})`,
        lines
      );
      continue;
    }
    const propertyName = bindingElementPropertyName(element as BindingElement);
    if (!propertyName) throw new CppEmitError("C++ object destructuring requires static property names");
    const annotatedType = element.typeAnnotation
      ? cppTypeForDeclaredName(element.typeAnnotation.name)
      : null;
    const type = annotatedType && annotatedType !== "void"
      ? annotatedType
      : bindingValueType(element.name);
    const value = element.initializer
      ? `vexa::convertValue<${type}>(${activeRuntimeName}, vexa::destructureDefault(${activeRuntimeName}, vexa::recordGet<vexa::Value>(${activeRuntimeName}, ${source}, ${cppString(propertyName)}), [&]() { return ${emitExpression(element.initializer)}; }))`
      : `vexa::recordGet<${type}>(${activeRuntimeName}, ${source}, ${cppString(propertyName)})`;
    emitDestructuredBindings(element.name, value, lines);
  }
}

function emitVariable(statement: VarStatement, forInitializer = false): string {
  if (statement.name.kind !== "Identifier") {
    if (forInitializer || !statement.initializer) {
      throw new CppEmitError("C++ loop destructuring requires a separate declaration", statement);
    }
    const temporary = `__vexa_destructure_${activeDestructureTemporaryCounter++}`;
    const lines = [`auto ${temporary} = ${emitExpression(statement.initializer)}`];
    emitDestructuredBindings(statement.name, temporary, lines);
    return lines.join("; ");
  }
  const sourceName = (statement.name as Identifier).name;
  const name = cppName(sourceName);
  if (!statement.initializer) {
    activeLocalNames.add(sourceName);
    activeDynamicValueNames.add(sourceName);
    return `vexa::Value ${name}`;
  }
  const declaredTypeName = statement.typeAnnotation?.name;
  const declaredCppType = declaredTypeName ? cppTypeForDeclaredName(declaredTypeName) : null;
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
  const type = forInitializer
    ? cppTypeForExpression(statement.initializer)
    : declaredCppType ?? "auto";
  const emittedInitializer = declaredTypeName && activeInterfaceNames.has(parseTypeNameShape(declaredTypeName).baseName) && isRecordExpression(statement.initializer)
    ? emitRecordInterfaceAdaptation(statement.initializer, declaredTypeName)
    : emitExpression(statement.initializer);
  const initializerType = cppTypeForExpression(statement.initializer);
  const initializer = declaredCppType && declaredCppType !== initializerType &&
    !(declaredTypeName && activeInterfaceNames.has(parseTypeNameShape(declaredTypeName).baseName) && isRecordExpression(statement.initializer))
    ? emitConvertedValue(statement.initializer, declaredCppType)
    : emittedInitializer;
  const className = declaredTypeName
    ? (isNativeObjectTypeName(declaredTypeName) ? declaredTypeName : null)
    : classNameForExpression(statement.initializer);
  activeLocalNames.add(sourceName);
  if (type === "vexa::Value" || cppTypeForExpression(statement.initializer) === "vexa::Value") {
    activeDynamicValueNames.add(sourceName);
  }
  if (className) {
    activeGcObjectTypes.set(sourceName, className);
  }
  const arrayType = declaredCppType && managedArrayElementType(declaredCppType) !== null
    ? declaredCppType
    : declaredTypeName
      ? null
      : managedArrayCppTypeForExpression(statement.initializer);
  if (arrayType) activeGcArrayTypes.set(sourceName, arrayType.slice(0, -1));
  if (className && activeGeneratorResultType) {
    return `cppgc::Persistent<${cppName(className)}> ${name}(${initializer})`;
  }
  if (arrayType && activeGeneratorResultType) {
    return `cppgc::Persistent<${arrayType.slice(0, -1)}> ${name}(${initializer})`;
  }
  return `${type} ${name} = ${initializer}`;
}

function emitBlock(block: BlockStatement, indent: string, trailingStatement?: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  const previousGcArrayTypes = new Map(activeGcArrayTypes);
  const previousDynamicValueNames = new Set(activeDynamicValueNames);
  try {
    const childIndent = `${indent}  `;
    const lines = block.body.flatMap((statement) => {
      const emitted = emitStatement(statement, childIndent);
      return emitted
        ? [...emitStatementPreamble(statement, childIndent), emitted]
        : [];
    });
    if (trailingStatement) lines.push(`${childIndent}${trailingStatement}`);
    return lines.length > 0 ? `{\n${lines.join("\n")}\n${indent}}` : "{}";
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
  }
}

function emitStatementPreamble(statement: Statement, indent: string): string[] {
  const position = statement.firstToken?.range.start;
  const statementSourcePath = (statement as unknown as Record<string, unknown>)["__vexaNativeSourcePath"];
  const sourcePath = typeof statementSourcePath === "string" ? statementSourcePath : activeSourceFilePath;
  const sourceLocation = sourcePath && position
    ? [
        `${indent}#line ${position.line + 1} ${cppString(sourcePath)}`,
        `${indent}vexa::Runtime::current().setSourceLocation(${cppString(sourcePath)}, ${position.line + 1}, ${position.column + 1});`,
      ]
    : [];
  return [...sourceLocation, `${indent}vexa::Runtime::current().collectGarbageIfStressed();`];
}

function emitBody(statement: Statement, indent: string): string {
  return statement.kind === "BlockStatement"
    ? emitBlock(statement as BlockStatement, indent)
    : emitBlock({ kind: "BlockStatement", body: [statement] } as BlockStatement, indent);
}

function emitLoopBody(statement: Statement, indent: string, label?: string): string {
  activeBreakBoundaryDepths.push(activeFinallyProtectedDepth);
  activeContinueBoundaryDepths.push(activeFinallyProtectedDepth);
  try {
    const body = emitBody(statement, `${indent}  `);
    return [
      "{",
      `${indent}  try ${body}`,
      `${indent}  catch (const vexa::ContinueSignal&) { continue; }`,
      `${indent}  catch (const vexa::BreakSignal&) { break; }`,
      ...(label ? [
        `${indent}  catch (const vexa::LabeledContinueSignal& __vexa_signal) { if (__vexa_signal.label() == ${cppString(label)}) continue; throw; }`,
        `${indent}  catch (const vexa::LabeledBreakSignal& __vexa_signal) { if (__vexa_signal.label() == ${cppString(label)}) break; throw; }`,
      ] : []),
      `${indent}}`,
    ].join("\n");
  } finally {
    activeBreakBoundaryDepths.pop();
    activeContinueBoundaryDepths.pop();
  }
}

function emitFor(statement: ForStatement, indent: string, label?: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  const previousGcArrayTypes = new Map(activeGcArrayTypes);
  try {
    if (statement.iterationKind || statement.iterator || statement.iterable) {
      if ((statement.iterationKind !== "of" && statement.iterationKind !== "in") || !statement.iterator || !statement.iterable) {
        throw new CppEmitError("C++ emission supports Vexa for-in/for-of loops only", statement);
      }
      const iteratorBinding = statement.iterator.kind === "VarStatement"
        ? (statement.iterator as VarStatement).name
        : statement.iterator as BindingName;
      if (!isArrayExpression(statement.iterable) && !isGeneratorExpression(statement.iterable)) {
        throw new CppEmitError("C++ for-of emission currently supports arrays and generators only", statement);
      }
      const iterable = emitExpression(statement.iterable);
      const range = isManagedArrayExpression(statement.iterable) ? `*vexa::arrayPointer(${iterable})` : iterable;
      if (iteratorBinding.kind === "Identifier") {
        activeLocalNames.add(iteratorBinding.name);
        return `${indent}for (auto ${cppName(iteratorBinding.name)} : ${range}) ${emitLoopBody(statement.body, indent, label)}`;
      }
      const temporary = `__vexa_loop_binding_${activeDestructureTemporaryCounter++}`;
      const bindingLines: string[] = [];
      emitDestructuredBindings(iteratorBinding, temporary, bindingLines);
      const body = emitStatement(statement.body, `${indent}  `);
      return [
        `${indent}for (auto ${temporary} : ${range}) {`,
        ...bindingLines.map((line) => `${indent}  ${line};`),
        body,
        `${indent}}`,
      ].join("\n");
    }
    const initializer = statement.initializer
      ? statement.initializer.kind === "VarStatement"
        ? emitVariable(statement.initializer as VarStatement, true)
        : emitExpression(statement.initializer as Expr)
      : "";
    const condition = statement.condition ? emitCondition(statement.condition) : "";
    const compactCondition = condition.startsWith("(") && condition.endsWith(")") ? condition.slice(1, -1) : condition;
    return `${indent}for (${initializer}; ${compactCondition}; ${statement.update ? emitExpression(statement.update) : ""}) ${emitLoopBody(statement.body, indent, label)}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
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
  if (new Set(["std::int32_t", "std::int64_t", "bool"]).has(mappedType ?? "")) {
    const lines = [`${indent}switch (${emitExpression(statement.discriminant)}) {`];
    appendSwitchCases(lines, statement, indent, (index) => {
      const switchCase = statement.cases[index]!;
      return switchCase.test ? `case ${emitExpression(switchCase.test)}` : "default";
    });
    lines.push(`${indent}}`);
    return lines.join("\n");
  }

  const temporaryIndex = activeSwitchTemporaryCounter++;
  const valueName = `__vexa_switch_value_${temporaryIndex}`;
  const caseName = `__vexa_switch_case_${temporaryIndex}`;
  const defaultIndex = statement.cases.findIndex((switchCase) => !switchCase.test);
  const lines = [
    `${indent}{`,
    `${indent}  auto ${valueName} = ${emitExpression(statement.discriminant)};`,
    `${indent}  std::int32_t ${caseName} = ${defaultIndex};`,
  ];
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
  activeBreakBoundaryDepths.push(activeFinallyProtectedDepth);
  try {
    const body = emitSwitchBody(statement, `${indent}  `);
    return [
      `${indent}{`,
      `${indent}  try {`,
      body,
      `${indent}  } catch (const vexa::BreakSignal&) {}`,
      `${indent}}`,
    ].join("\n");
  } finally {
    activeBreakBoundaryDepths.pop();
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
      let catchBody = emitBlock(statement.catchClause.body, indent);
      if (parameter) {
        const binding = `auto ${cppName(parameter.name)} = ${activeRuntimeName}.string(${caughtName}.what());`;
        catchBody = catchBody === "{}"
          ? `{ ${binding} }`
          : catchBody.replace("{\n", `{\n${indent}  ${binding}\n`);
      }
      lines.push(`${indent}catch (const std::exception& ${caughtName}) ${catchBody}`);
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
    case "ReturnStatement":
      return Boolean((statement as ReturnStatement).expression);
    case "BlockStatement":
      return (statement as BlockStatement).body.some(containsValueReturn);
    case "IfStatement": {
      const branch = statement as IfStatement;
      return containsValueReturn(branch.thenBranch) || Boolean(branch.elseBranch && containsValueReturn(branch.elseBranch));
    }
    case "ForStatement":
      return containsValueReturn((statement as ForStatement).body);
    case "WhileStatement":
      return containsValueReturn((statement as WhileStatement).body);
    case "DoWhileStatement":
      return containsValueReturn((statement as DoWhileStatement).body);
    default:
      return false;
  }
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
    if (inferred?.kind === "function") {
      const inferredReturn = inferred.returnType;
      if (inferredReturn.kind === "named" && inferredReturn.name === "Promise") {
        const valueType = inferredReturn.typeArguments?.[0];
        return valueType ? cppTypeForAnalysisType(valueType) ?? "vexa::Value" : "vexa::Value";
      }
      const mapped = cppTypeForAnalysisType(inferredReturn);
      if (mapped) return mapped;
    }
    throw new CppEmitError("C++ emission could not map the inferred callable return type", owner);
  }
  const promised = /^Promise<(.+)>$/.exec(returnType.name)?.[1]?.trim();
  if (promised && !asyncLike) {
    throw new CppEmitError("C++ emission only supports Promise return annotations on async or sync callables", owner);
  }
  const declaredName = promised ?? returnType.name;
  const mapped = cppTypeForDeclaredName(declaredName);
  if (!mapped) {
    throw new CppEmitError(`C++ emission does not support return type '${returnType.name}' yet`, owner);
  }
  return mapped;
}

function callableProducesTask(callableName: Identifier, returnType: Identifier | undefined, asyncLike: boolean): boolean {
  if (asyncLike || returnType?.name.startsWith("Promise<") || returnType?.name === "Promise") return true;
  const inferred = activeCallableTypes.get(callableName as Node);
  return inferred?.kind === "function" && inferred.returnType.kind === "named" && inferred.returnType.name === "Promise";
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
  const analyzedReturn = callableType?.kind === "function" ? callableType.returnType : undefined;
  if (
    analyzedReturn?.kind === "named" &&
    (analyzedReturn.name === "Generator" || analyzedReturn.name === "AsyncGenerator")
  ) {
    const elementType = analyzedReturn.typeArguments?.[0];
    return {
      resultType: elementType ? cppTypeForAnalysisType(elementType) ?? "vexa::Value" : "vexa::Value",
      async: analyzedReturn.name === "AsyncGenerator",
    };
  }
  const fallback = returnType ? cppTypeForDeclaredName(returnType.name) : null;
  if (!fallback) {
    throw new CppEmitError("C++ emission could not map the analyzed generator element type", owner);
  }
  return { resultType: fallback, async: asyncLike };
}

function callableParameters(
  parameters: readonly FunctionParameter[],
  owner: Statement | undefined,
  allowDefaults = true,
  allowInferredTypes = false
): { text: string; names: string[]; gcTypes: Map<string, string>; gcArrayTypes: Map<string, string>; dynamicNames: Set<string> } {
  const names: string[] = [];
  const gcTypes = new Map<string, string>();
  const gcArrayTypes = new Map<string, string>();
  const dynamicNames = new Set<string>();
  const text = parameters.map((parameter) => {
    if (
      parameter.name.kind !== "Identifier" ||
      parameter.rest ||
      (parameter.optional && !parameter.defaultValue) ||
      parameter.thisParameter
    ) {
      throw new CppEmitError(
        "C++ emission currently supports required identifier parameters without defaults only",
        owner
      );
    }
    if (parameter.defaultValue && (!allowDefaults || !isSupportedDefaultExpression(parameter.defaultValue))) {
      throw new CppEmitError("C++ emission currently supports literal parameter defaults only", owner);
    }
    const sourceName = (parameter.name as Identifier).name;
    const typeName = parameter.typeAnnotation?.name;
    const type = typeName ? cppTypeForDeclaredName(typeName) : allowInferredTypes ? "auto" : null;
    if (!type || type === "void") {
      throw new CppEmitError("C++ emission requires supported type annotations on function and method parameters", owner);
    }
    names.push(sourceName);
    if (typeName && isNativeObjectTypeName(typeName)) gcTypes.set(sourceName, typeName);
    if (managedArrayElementType(type) !== null) gcArrayTypes.set(sourceName, type.slice(0, -1));
    if (type === "vexa::Value") dynamicNames.add(sourceName);
    return `${type} ${cppName(sourceName)}`;
  }).join(", ");
  return { text, names, gcTypes, gcArrayTypes, dynamicNames };
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
  return `${emittedResultType} ${cppName(emittedName)}(vexa::Runtime& __vexa_runtime${parameterText ? `, ${parameterText}` : ""})`;
}

function withCallableContext<T>(
  parameters: readonly FunctionParameter[],
  className: string | null,
  staticMethod: boolean,
  asyncResultType: string | null,
  generatorResultType: string | null,
  callableResultType: string,
  owner: Statement,
  emit: () => T
): T {
  const previousRuntimeName = activeRuntimeName;
  const previousThisExpression = activeThisExpression;
  const previousClassName = activeCurrentClassName;
  const previousMethodStatic = activeCurrentMethodStatic;
  const previousLocalNames = activeLocalNames;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousGcArrayTypes = activeGcArrayTypes;
  const previousDynamicValueNames = activeDynamicValueNames;
  const previousAsyncResultType = activeAsyncResultType;
  const previousGeneratorResultType = activeGeneratorResultType;
  const previousCallableResultType = activeCallableResultType;
  const previousFinallyProtectedDepth = activeFinallyProtectedDepth;
  const previousBreakBoundaryDepths = activeBreakBoundaryDepths;
  const previousContinueBoundaryDepths = activeContinueBoundaryDepths;
  const parameterInfo = callableParameters(parameters, owner);
  activeRuntimeName = "__vexa_runtime";
  activeThisExpression = "this";
  activeCurrentClassName = className;
  activeCurrentMethodStatic = staticMethod;
  activeLocalNames = new Set(parameterInfo.names);
  activeGcObjectTypes = new Map(parameterInfo.gcTypes);
  activeGcArrayTypes = new Map(parameterInfo.gcArrayTypes);
  activeDynamicValueNames = new Set(parameterInfo.dynamicNames);
  activeAsyncResultType = asyncResultType;
  activeGeneratorResultType = generatorResultType;
  activeCallableResultType = callableResultType;
  activeFinallyProtectedDepth = 0;
  activeBreakBoundaryDepths = [];
  activeContinueBoundaryDepths = [];
  try {
    return emit();
  } finally {
    activeRuntimeName = previousRuntimeName;
    activeThisExpression = previousThisExpression;
    activeCurrentClassName = previousClassName;
    activeCurrentMethodStatic = previousMethodStatic;
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeGcArrayTypes = previousGcArrayTypes;
    activeDynamicValueNames = previousDynamicValueNames;
    activeAsyncResultType = previousAsyncResultType;
    activeGeneratorResultType = previousGeneratorResultType;
    activeCallableResultType = previousCallableResultType;
    activeFinallyProtectedDepth = previousFinallyProtectedDepth;
    activeBreakBoundaryDepths = previousBreakBoundaryDepths;
    activeContinueBoundaryDepths = previousContinueBoundaryDepths;
  }
}

function emitCallableReturnBoundary(
  body: string,
  indent: string,
  resultType: string,
  coroutine: boolean
): string {
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

function emitAsyncCallableBlock(body: BlockStatement, indent: string, resultType: string): string {
  const trailing = resultType === "void"
    ? "co_return;"
    : `co_return vexa::defaultValue<${resultType}>();`;
  return emitBlock(body, indent, trailing);
}

function emitGeneratorCallableBlock(body: BlockStatement, indent: string, resultType: string): string {
  const childIndent = `${indent}  `;
  const roots: string[] = [];
  for (const [sourceName, className] of activeGcObjectTypes) {
    roots.push(
      `${childIndent}cppgc::Persistent<${cppName(className)}> __vexa_generator_root_${cppName(sourceName)}(${cppName(sourceName)});`
    );
  }
  for (const [sourceName, pointeeType] of activeGcArrayTypes) {
    roots.push(
      `${childIndent}cppgc::Persistent<${pointeeType}> __vexa_generator_root_${cppName(sourceName)}(vexa::arrayPointer(${cppName(sourceName)}));`
    );
  }
  const previousThisExpression = activeThisExpression;
  if (activeCurrentClassName && !activeCurrentMethodStatic) {
    roots.push(`${childIndent}cppgc::Persistent<${cppName(activeCurrentClassName)}> __vexa_generator_self(this);`);
    activeThisExpression = "__vexa_generator_self";
  }
  try {
    const emitted = emitBlock(body, indent, `co_return vexa::defaultValue<${resultType}>();`);
    return roots.length > 0
      ? emitted.replace("{\n", `{\n${roots.join("\n")}\n`)
      : emitted;
  } finally {
    activeThisExpression = previousThisExpression;
  }
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
  const propertyName = statement.name.kind === "Identifier" ? statement.name.name : "property";
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
  if (!statement.receiverType || statement.name.kind !== "Identifier") {
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
      : null;
    const getter = statement.accessors?.find((accessor) => accessor.accessorKind === "get");
    const analyzedResult = statement.initializer
      ? cppTypeForExpression(statement.initializer)
      : getter?.returnType
        ? cppTypeForDeclaredName(getter.returnType.name) ?? "auto"
        : "auto";
    const resultType = declaredResult && declaredResult !== "void"
      ? declaredResult
      : analyzedResult !== "auto" ? analyzedResult : "auto";
    if (statement.initializer) return withCallableContext(
      [],
      statement.receiverType!.name,
      false,
      null,
      null,
      resultType,
      statement,
      () => {
        const previousThisExpression = activeThisExpression;
        activeThisExpression = "__vexa_extension_self";
        try {
          return `${cppTemplatePrefix(statement.typeParameters)}${resultType} ${extensionPropertyCppName(statement)}(vexa::Runtime& __vexa_runtime, ${receiverType} __vexa_extension_self) { return ${emitExpression(statement.initializer!)}; }`;
        } finally {
          activeThisExpression = previousThisExpression;
        }
      }
    );
    return statement.accessors!.map((accessor) => {
      const setter = accessor.accessorKind === "set";
      const accessorResultType = setter ? "void" : resultType;
      const parameterInfo = callableParameters(accessor.parameters, statement);
      return withCallableContext(
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
          try {
            const signature = `${accessorResultType} ${extensionPropertyCppName(statement, setter)}(vexa::Runtime& __vexa_runtime, ${receiverType} __vexa_extension_self${parameterInfo.text ? `, ${parameterInfo.text}` : ""})`;
            const body = emitBlock(accessor.body, "  ");
            return `${cppTemplatePrefix(statement.typeParameters)}${signature} ${emitCallableReturnBoundary(body, "", accessorResultType, false)}`;
          } finally {
            activeThisExpression = previousThisExpression;
          }
        }
      );
    }).join("\n");
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
      generatorInfo ? false : callableProducesTask(statement.name, statement.returnType, asyncLike),
      generatorInfo,
      extensionCppName(statement)
    );
    if (!statement.receiverType) return signature;
    const receiverType = extensionReceiverCppType(statement);
    if (!receiverType || receiverType === "void") {
      throw new CppEmitError(`C++ cannot map extension receiver '${extensionReceiverTypeName(statement)}'`, statement);
    }
    return signature.replace(
      "(vexa::Runtime& __vexa_runtime",
      `(vexa::Runtime& __vexa_runtime, ${receiverType} __vexa_extension_self`
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
  const producesTask = !generatorInfo && callableProducesTask(statement.name, statement.returnType, asyncLike);
  const asyncResultType = !generatorInfo && (statement.async || statement.sync)
    ? callableReturnType(statement.returnType, statement.body, statement, statement.name, true)
    : null;
  const valueResultType = generatorInfo?.resultType ?? asyncResultType ??
    callableReturnType(statement.returnType, statement.body, statement, statement.name, producesTask);
  const callableResultType = producesTask && !asyncResultType
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
      if (statement.receiverType) activeThisExpression = "__vexa_extension_self";
      try {
      const body = generatorInfo
        ? emitGeneratorCallableBlock(statement.body, "  ", generatorInfo.resultType)
        : asyncResultType
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

function classFieldType(field: ClassFieldMember, statement: ClassStatement): {
  valueType: string;
  storageType: string;
  traced: boolean;
  genericTraced: boolean;
} {
  if (
    field.static ||
    field.abstract ||
    field.computed ||
    field.optional ||
    !field.typeAnnotation
  ) {
    throw new CppEmitError("C++ emission supports concrete typed instance fields only", statement);
  }
  const declaredType = field.typeAnnotation.name;
  const valueType = cppTypeForDeclaredName(declaredType);
  if (!valueType || valueType === "void") {
    throw new CppEmitError(`C++ emission does not support class field type '${declaredType}' yet`, statement);
  }
  const genericTraced = activeCppTypeParameters.has(declaredType);
  const traced = isNativeObjectTypeName(declaredType) || managedArrayElementType(valueType) !== null;
  const storageType = managedArrayElementType(valueType) !== null
    ? `cppgc::Member<${valueType.slice(0, -1)}>`
    : isNativeObjectTypeName(declaredType)
      ? `cppgc::Member<${valueType.slice(0, -1)}>`
      : valueType;
  return {
    valueType,
    storageType,
    traced,
    genericTraced,
  };
}

function emitClassFieldInitializer(expression: Expr, statement: ClassStatement): string {
  const previousRuntimeName = activeRuntimeName;
  const previousClassName = activeCurrentClassName;
  const previousMethodStatic = activeCurrentMethodStatic;
  const previousThisExpression = activeThisExpression;
  activeRuntimeName = "__vexa_runtime";
  activeCurrentClassName = statement.name.name;
  activeCurrentMethodStatic = false;
  activeThisExpression = "this";
  try {
    return emitExpression(expression);
  } finally {
    activeRuntimeName = previousRuntimeName;
    activeCurrentClassName = previousClassName;
    activeCurrentMethodStatic = previousMethodStatic;
    activeThisExpression = previousThisExpression;
  }
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
    method.static ||
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
  if (method.operator && (method.static || method.async || method.sync || method.generator)) {
    throw new CppEmitError("C++ emission supports synchronous instance operator methods only", statement);
  }
}

function emitEnumConstantExpression(expression: Expr): string {
  switch (expression.kind) {
    case "IntLiteral":
      return String((expression as unknown as { value: number }).value);
    case "Identifier":
      return cppName((expression as Identifier).name);
    case "UnaryExpression": {
      const unary = expression as UnaryExpression;
      if (!new Set(["+", "-", "~"]).has(unary.operator)) break;
      return `(${unary.operator}${emitEnumConstantExpression(unary.argument)})`;
    }
    case "BinaryExpression": {
      const binary = expression as BinaryExpression;
      if (!new Set(["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"]).has(binary.operator)) break;
      return `(${emitEnumConstantExpression(binary.left)} ${binary.operator} ${emitEnumConstantExpression(binary.right)})`;
    }
    case "MemberExpression": {
      const member = expression as MemberExpression;
      const enumName = !member.computed ? identifierName(member.object) : null;
      const memberName = !member.computed ? identifierName(member.property) : null;
      if (enumName && memberName && activeEnumNames.has(enumName)) {
        return `${cppName(enumName)}::${cppName(memberName)}`;
      }
      break;
    }
    case "AsExpression":
    case "SatisfiesExpression":
    case "NonNullExpression":
      return emitEnumConstantExpression((expression as unknown as { expression: Expr }).expression);
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
  return property.optional ? "vexa::Value" : cppTypeForDeclaredName(property.typeAnnotation.name);
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
    ? `  virtual ${type} ${interfacePropertyGetterName(property.name.name)}(vexa::Runtime&) { return vexa::Value::undefined(); }`
    : `  virtual ${type} ${interfacePropertyGetterName(property.name.name)}(vexa::Runtime& __vexa_runtime) = 0;`];
  if (isMutableInterfaceProperty(property)) {
    lines.push(property.optional
      ? `  virtual void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime&, ${type}) {}`
      : `  virtual void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime& __vexa_runtime, ${type} value) = 0;`);
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
  const signature = `  virtual ${resultType} ${cppName(method.name.name)}(vexa::Runtime& __vexa_runtime${parameters ? `, ${parameters}` : ""})`;
  return method.optional
    ? `${signature} { throw std::runtime_error("Optional interface method '${method.name.name}' is not implemented"); }`
    : `${signature} = 0;`;
}

function emitInterface(statement: InterfaceStatement): string {
  return withCppTypeParameters(statement.typeParameters, () => emitInterfaceWithActiveTypeParameters(statement));
}

function emitInterfaceWithActiveTypeParameters(statement: InterfaceStatement): string {
  const extendedInterfaces = (statement.extendsTypes ?? []).map((extendedType) => {
    const baseName = parseTypeNameShape(extendedType.name).baseName;
    if (!activeInterfaceNames.has(baseName)) {
      throw new CppEmitError(
        `C++ interface '${statement.name.name}' can only extend another emitted interface`,
        statement
      );
    }
    const mapped = cppTypeForDeclaredName(extendedType.name);
    if (!mapped?.endsWith("*")) throw new CppEmitError(`C++ cannot map interface '${extendedType.name}'`, statement);
    return `public ${mapped.slice(0, -1)}`;
  });
  const inheritance = extendedInterfaces.length > 0
    ? ` : ${extendedInterfaces.join(", ")}`
    : " : public cppgc::GarbageCollectedMixin";
  const traceBody = (statement.extendsTypes ?? [])
    .map((extendedType) => `${cppTypeForDeclaredName(extendedType.name)!.slice(0, -1)}::Trace(visitor);`)
    .join(" ");
  const trace = traceBody
    ? `  void Trace(cppgc::Visitor* visitor) const override { ${traceBody} }`
    : "  void Trace(cppgc::Visitor*) const override {}";
  return [
    `${cppTemplatePrefix(statement.typeParameters)}class ${cppName(statement.name.name)}${inheritance} {`,
    " public:",
    `  virtual ~${cppName(statement.name.name)}() = default;`,
    trace,
    ...statement.members.flatMap((member) => member.kind === "InterfaceMethodMember"
      ? [emitInterfaceMethod(member, statement)]
      : emitInterfaceProperty(member, statement)),
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
    if (member.kind === "InterfacePropertyMember") properties.set(member.name.name, member);
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
    if (member.kind === "InterfaceMethodMember") methods.set(member.name.name, member);
  }
  return [...methods.values()];
}

function recordInterfaceAdapterName(interfaceName: string): string {
  return `__vexa_record_adapter_${cppName(interfaceName)}`;
}

function emitRecordInterfaceAdaptation(expression: Expr, interfaceName: string): string {
  const statement = activeInterfaceStatements.get(interfaceName);
  if (!statement) {
    throw new CppEmitError(
      `C++ cannot adapt a structural record to unknown interface '${interfaceName}'`
    );
  }
  return `${activeRuntimeName}.make<${recordInterfaceAdapterName(interfaceName)}>(${emitExpression(expression)})`;
}

function emitRecordInterfaceAdapter(statement: InterfaceStatement): string | null {
  if (statement.typeParameters?.length) return null;
  const interfaceName = cppName(statement.name.name);
  const adapterName = recordInterfaceAdapterName(statement.name.name);
  const properties = interfaceProperties(statement).flatMap((property) => {
    const type = interfacePropertyCppType(property);
    if (!type || type === "void") {
      throw new CppEmitError(
        `C++ emission does not support interface property type '${property.typeAnnotation.name}' yet`,
        statement
      );
    }
    const lines = [
      `  ${type} ${interfacePropertyGetterName(property.name.name)}(vexa::Runtime& __vexa_runtime) override { return vexa::recordGet<${type}>(__vexa_runtime, record_, ${cppString(property.name.name)}); }`,
    ];
    if (isMutableInterfaceProperty(property)) {
      lines.push(
        `  void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime& __vexa_runtime, ${type} value) override { vexa::recordSet(__vexa_runtime, record_, ${cppString(property.name.name)}, value); }`
      );
    }
    return lines;
  });
  const methods = interfaceMethods(statement).map((method) => {
    const resultType = method.returnType ? cppTypeForDeclaredName(method.returnType.name) : "void";
    if (!resultType) {
      throw new CppEmitError(`C++ cannot map interface method '${method.name.name}'`, statement);
    }
    const parameters = callableParameters(method.parameters, statement, false);
    const dynamicArguments = parameters.names.map((name) =>
      `vexa::convertValue<vexa::Value>(__vexa_runtime, ${cppName(name)})`).join(", ");
    const invocation = `vexa::call(__vexa_runtime, vexa::recordGet<vexa::Value>(__vexa_runtime, record_, ${cppString(method.name.name)}), {${dynamicArguments}})`;
    const body = resultType === "void"
      ? `${invocation};`
      : `return vexa::convertValue<${resultType}>(__vexa_runtime, ${invocation});`;
    return `  ${resultType} ${cppName(method.name.name)}(vexa::Runtime& __vexa_runtime${parameters.text ? `, ${parameters.text}` : ""}) override { ${body} }`;
  });
  return [
    `class ${adapterName} final : public cppgc::GarbageCollected<${adapterName}>, public ${interfaceName} {`,
    " public:",
    `  explicit ${adapterName}(vexa::RecordObject* record) : record_(record) {}`,
    `  void Trace(cppgc::Visitor* visitor) const override { ${interfaceName}::Trace(visitor); visitor->Trace(record_); }`,
    ...properties,
    ...methods,
    " private:",
    "  cppgc::Member<vexa::RecordObject> record_;",
    "};",
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
  for (const [index, parameter] of (statement.typeParameters ?? []).entries()) {
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
    if (member.kind !== "InterfacePropertyMember") continue;
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

type ClassPropertyImplementation =
  | { kind: "field"; mutable: boolean }
  | { kind: "accessors"; getter: ClassMethodMember; setter: ClassMethodMember | null };

function classPropertyImplementation(
  statement: ClassStatement,
  propertyName: string
): ClassPropertyImplementation | null {
  const primaryProperty = (statement.primaryConstructorParameters ?? [])
    .find((parameter) => parameter.name.name === propertyName);
  if (primaryProperty) {
    return {
      kind: "field",
      mutable: primaryProperty.declarationKind !== "val" && primaryProperty.declarationKind !== "const",
    };
  }
  const field = statement.members.find((member): member is ClassFieldMember =>
    member.kind === "ClassFieldMember" && member.name.name === propertyName);
  if (field) {
    return {
      kind: "field",
      mutable: field.declarationKind !== "val" && field.declarationKind !== "const" && !field.readonly,
    };
  }
  const getter = classGetterForName(statement, propertyName);
  return getter ? {
    kind: "accessors",
    getter,
    setter: classSetterForName(statement, propertyName),
  } : null;
}

function emitInterfacePropertyBridges(statement: ClassStatement): string[] {
  return implementedInterfaceProperties(statement).flatMap(({ property, typeName }) => {
    const implementation = classPropertyImplementation(statement, property.name.name);
    if (!implementation) {
      if (property.optional) return [];
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
    const getterValue = implementation.kind === "accessors"
      ? `this->${propertyName}(__vexa_runtime)`
      : `this->${propertyName}`;
    const runtimeParameter = implementation.kind === "accessors"
      ? "vexa::Runtime& __vexa_runtime"
      : "vexa::Runtime&";
    const returnedValue = property.optional
      ? `vexa::convertValue<vexa::Value>(__vexa_runtime, ${getterValue})`
      : getterValue;
    const getterRuntimeParameter = property.optional ? "vexa::Runtime& __vexa_runtime" : runtimeParameter;
    const lines = [
      `  ${type} ${interfacePropertyGetterName(property.name.name)}(${getterRuntimeParameter}) override { return ${returnedValue}; }`,
    ];
    if (isMutableInterfaceProperty(property)) {
      if (implementation.kind === "field" && implementation.mutable) {
        lines.push(
          `  void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime& __vexa_runtime, ${type} __vexa_property_value) override { this->${propertyName} = ${property.optional ? `vexa::convertValue<${implementationType}>(__vexa_runtime, __vexa_property_value)` : "__vexa_property_value"}; }`
        );
      } else if (implementation.kind === "accessors" && implementation.setter) {
        lines.push(
          `  void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime& __vexa_runtime, ${type} __vexa_property_value) override { this->${propertyName}(__vexa_runtime, ${property.optional ? `vexa::convertValue<${implementationType}>(__vexa_runtime, __vexa_property_value)` : "__vexa_property_value"}); }`
        );
      } else {
        throw new CppEmitError(
          `C++ mutable interface property '${property.name.name}' requires a mutable field or setter accessor`,
          statement
        );
      }
    }
    return lines;
  });
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
    Boolean(method.async || method.sync)
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
  const virtual = activeDerivedClassNames.has(statement.name.name) && !method.static ? "virtual " : "";
  const valueResultType = generatorInfo?.resultType ?? asyncResultType ??
    callableReturnType(method.returnType, method.body, statement, method.name, producesTask);
  const callableResultType = producesTask && !asyncResultType
    ? `vexa::Task<${valueResultType}>`
    : valueResultType;
  return withCallableContext(
    method.parameters,
    statement.name.name,
    Boolean(method.static),
    asyncResultType,
    generatorInfo?.resultType ?? null,
    callableResultType,
    statement,
    () => {
      const body = generatorInfo
        ? emitGeneratorCallableBlock(method.body, "    ", generatorInfo.resultType)
        : asyncResultType
          ? emitAsyncCallableBlock(method.body, "    ", asyncResultType)
          : emitBlock(method.body, "    ");
      return `${cppTemplatePrefix(method.typeParameters, "  ", true)}  ${method.static ? "static " : virtual}${signature}${override} ${emitCallableReturnBoundary(body, "  ", callableResultType, Boolean(generatorInfo || asyncResultType))}`;
    }
  );
}

function emitClass(statement: ClassStatement): string {
  return withCppTypeParameters(statement.typeParameters, () => emitClassWithActiveTypeParameters(statement));
}

function emitClassWithActiveTypeParameters(statement: ClassStatement): string {
  const extendedBaseName = statement.extendsType
    ? parseTypeNameShape(statement.extendsType.name).baseName
    : null;
  if (
    statement.declared ||
    (extendedBaseName && !activeInterfaceNames.has(extendedBaseName) && !activeClassNames.has(extendedBaseName)) ||
    statement.implementsTypes?.some((implementedType) =>
      !activeInterfaceNames.has(parseTypeNameShape(implementedType.name).baseName)) ||
    statement.classDelegates?.length ||
    statement.members.some((member) => member.kind !== "ClassMethodMember" && member.kind !== "ClassFieldMember")
  ) {
    throw new CppEmitError(
      "C++ emission currently supports classes with fields, methods, inheritance, and emitted interfaces",
      statement
    );
  }

  const className = cppName(statement.name.name);
  const classType = statement.typeParameters?.length
    ? `${className}<${statement.typeParameters.map((parameter) => cppName(parameter.name.name)).join(", ")}>`
    : className;
  const baseClass = statement.extendsType
    ? activeClassStatements.get(parseTypeNameShape(statement.extendsType.name).baseName)
    : undefined;
  const mappedBaseType = statement.extendsType ? cppTypeForDeclaredName(statement.extendsType.name) : null;
  const constructorMethod = classConstructorMethod(statement);
  const implementedInterfaces = implementedInterfaceTypes(statement)
    .map((implementedType) => {
      const mapped = cppTypeForDeclaredName(implementedType.name);
      if (!mapped?.endsWith("*")) {
        throw new CppEmitError(`C++ cannot map interface '${implementedType.name}'`, statement);
      }
      return `public ${mapped.slice(0, -1)}`;
    });
  const parameters = statement.primaryConstructorParameters ?? [];
  if (parameters.some((parameter) => parameter.defaultValue && !isSupportedDefaultExpression(parameter.defaultValue))) {
    throw new CppEmitError("C++ emission currently supports literal class constructor defaults only", statement);
  }
  const typedParameters = parameters.map((parameter) => ({
    parameter,
    name: cppName(parameter.name.name),
    type: primaryConstructorParameterType(parameter, statement),
  }));
  const fieldMembers = statement.members.filter((member): member is ClassFieldMember => member.kind === "ClassFieldMember");
  const typedFieldMembers = fieldMembers.map((field) => ({
    field,
    name: cppName(field.name.name),
    ...classFieldType(field, statement),
  }));
  const constructorPropertyParameters = (constructorMethod?.parameters ?? []).filter((parameter) =>
    parameter.accessModifier !== undefined || parameter.readonly === true);
  const typedConstructorProperties = constructorPropertyParameters.map((parameter) => {
    const typeName = parameter.typeAnnotation?.name;
    const type = typeName ? cppTypeForDeclaredName(typeName) : null;
    if (!type || type === "void" || parameter.name.kind !== "Identifier") {
      throw new CppEmitError("C++ constructor parameter properties require supported identifier types", statement);
    }
    return { parameter, typeName: typeName!, type, name: cppName(parameter.name.name) };
  });
  const sourceConstructorParameters = typedParameters.map(({ type, name }) => `${type} ${name}`).join(", ");
  const usesRuntime = classUsesRuntimeConstructor(statement);
  const constructorParameters = usesRuntime
    ? `vexa::Runtime& __vexa_runtime${sourceConstructorParameters ? `, ${sourceConstructorParameters}` : ""}`
    : sourceConstructorParameters;
  const initializers = [
    ...typedParameters.map(({ name }) => `${name}(${name})`),
    ...typedFieldMembers.map(({ field, name, valueType }) =>
      `${name}(${field.initializer
        ? emitClassFieldInitializer(field.initializer, statement)
        : `vexa::defaultValue<${valueType}>()`})`
    ),
  ];
  let constructor = initializers.length > 0 || usesRuntime || constructorParameters
    ? `${className}(${constructorParameters})${initializers.length > 0 ? ` : ${initializers.join(", ")}` : ""} {}`
    : `${className}() = default;`;
  if (constructorMethod) {
    const superStatement = constructorMethod.body.body.find((candidate) => {
      if (candidate.kind !== "ExprStatement") return false;
      const expression = (candidate as ExprStatement).expression;
      return expression.kind === "CallExpression" && identifierName((expression as CallExpression).callee) === "super";
    });
    const superCall = superStatement
      ? (superStatement as ExprStatement).expression as CallExpression
      : null;
    if (baseClass && !superCall && (classConstructorParameters(baseClass)?.length ?? 0) > 0) {
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
        const nativeParameters = `vexa::Runtime& __vexa_runtime${methodParameters ? `, ${methodParameters}` : ""}`;
        const nativeInitializers: string[] = [];
        if (baseClass && mappedBaseType) {
          const baseArguments = superCall
            ? emitArguments(superCall.arguments, classConstructorParameters(baseClass))
            : "";
          nativeInitializers.push(
            `${mappedBaseType.slice(0, -1)}(${classUsesRuntimeConstructor(baseClass) ? withRuntimeArgument(baseArguments) : baseArguments})`
          );
        }
        nativeInitializers.push(...typedConstructorProperties.map(({ name }) => `${name}(${name})`));
        nativeInitializers.push(...typedFieldMembers.map(({ field, name, valueType }) =>
          `${name}(${field.initializer
            ? emitClassFieldInitializer(field.initializer, statement)
            : `vexa::defaultValue<${valueType}>()`})`
        ));
        const body = {
          ...constructorMethod.body,
          body: constructorMethod.body.body.filter((candidate) => candidate !== superStatement),
        } as BlockStatement;
        return `${className}(${nativeParameters})${nativeInitializers.length > 0 ? ` : ${nativeInitializers.join(", ")}` : ""} ${emitBlock(body, "  ")}`;
      }
    );
  } else if (baseClass && ((baseClass.primaryConstructorParameters?.length ?? 0) > 0 || classUsesRuntimeConstructor(baseClass))) {
    throw new CppEmitError(
      `C++ derived class '${statement.name.name}' requires an explicit constructor with super(...) for base class '${baseClass.name.name}'`,
      statement
    );
  }
  const primaryFields = [...typedParameters.map(({ parameter, type, name }) => {
    const immutable = parameter.declarationKind === "val" || parameter.declarationKind === "const";
    const declaredType = parameter.typeAnnotation?.name;
    const storageType = managedArrayElementType(type) !== null
      ? `cppgc::Member<${type.slice(0, -1)}>`
      : declaredType && isNativeObjectTypeName(declaredType)
        ? `cppgc::Member<${type.slice(0, -1)}>`
        : type;
    return `  ${immutable ? "const " : ""}${storageType} ${name};`;
  }), ...typedConstructorProperties.map(({ parameter, typeName, type, name }) => {
    const immutable = parameter.readonly === true;
    const storageType = managedArrayElementType(type) !== null
      ? `cppgc::Member<${type.slice(0, -1)}>`
      : isNativeObjectTypeName(typeName)
        ? `cppgc::Member<${type.slice(0, -1)}>`
        : type;
    return `  ${immutable ? "const " : ""}${storageType} ${name};`;
  })];
  const explicitFields = typedFieldMembers.map(({ field, name, storageType }) => {
    const immutable = field.declarationKind === "val" || field.declarationKind === "const" || field.readonly;
    return { access: field.accessModifier ?? "public", text: `  ${immutable ? "const " : ""}${storageType} ${name};` };
  });
  const fieldLines = [...primaryFields];
  let activeAccess: "public" | "private" | "protected" = "public";
  for (const field of explicitFields) {
    if (field.access !== activeAccess) {
      fieldLines.push(` ${field.access}:`);
      activeAccess = field.access;
    }
    fieldLines.push(field.text);
  }
  const tracedFields = typedParameters
    .filter(({ parameter, type }) => Boolean(
      (parameter.typeAnnotation && isNativeObjectTypeName(parameter.typeAnnotation.name)) ||
      managedArrayElementType(type) !== null
    ))
    .map(({ name }) => `visitor->Trace(${name});`);
  tracedFields.push(...typedParameters
    .filter(({ parameter }) => Boolean(
      parameter.typeAnnotation && activeCppTypeParameters.has(parameter.typeAnnotation.name)))
    .map(({ name }) => `vexa::traceManagedValue(visitor, ${name});`));
  tracedFields.push(...typedConstructorProperties
    .filter(({ typeName, type }) => isNativeObjectTypeName(typeName) || managedArrayElementType(type) !== null)
    .map(({ name }) => `visitor->Trace(${name});`));
  tracedFields.push(...typedConstructorProperties
    .filter(({ typeName }) => activeCppTypeParameters.has(typeName))
    .map(({ name }) => `vexa::traceManagedValue(visitor, ${name});`));
  tracedFields.push(...typedFieldMembers
    .filter(({ traced }) => traced)
    .map(({ name }) => `visitor->Trace(${name});`));
  tracedFields.push(...typedFieldMembers
    .filter(({ genericTraced }) => genericTraced)
    .map(({ name }) => `vexa::traceManagedValue(visitor, ${name});`));
  const implementedInterfaceTraceCalls = implementedInterfaceTypes(statement)
    .map((implementedType) => `${cppTypeForDeclaredName(implementedType.name)!.slice(0, -1)}::Trace(visitor);`);
  const baseTrace = baseClass && mappedBaseType ? [`${mappedBaseType.slice(0, -1)}::Trace(visitor);`] : [];
  const traceStatements = [...baseTrace, ...implementedInterfaceTraceCalls, ...tracedFields];
  const traceOverrides = true;
  const traceVirtual = !traceOverrides && (Boolean(statement.abstract) || activeDerivedClassNames.has(statement.name.name));
  const traceQualifier = traceOverrides ? (statement.abstract || activeDerivedClassNames.has(statement.name.name) ? " override" : " final") : "";
  const trace = traceStatements.length > 0
    ? `  ${traceVirtual ? "virtual " : ""}void Trace(cppgc::Visitor* visitor) const${traceQualifier} { ${traceStatements.join(" ")} }`
    : `  ${traceVirtual ? "virtual " : ""}void Trace(cppgc::Visitor*) const${traceQualifier} {}`;
  const methods = statement.members.filter((member): member is ClassMethodMember =>
    member.kind === "ClassMethodMember" && member.name.name !== "constructor");
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
  const nativeBases = [
    baseClass && mappedBaseType
      ? `public ${mappedBaseType.slice(0, -1)}`
      : `public cppgc::GarbageCollected<${classType}>`,
    ...(!baseClass ? ["public vexa::DynamicValueObject"] : []),
    ...implementedInterfaces,
  ];
  const dynamicCastBranches = [
    `if (__vexa_type == vexa::nativeTypeToken<${classType}>()) return this;`,
    ...implementedInterfaceTypes(statement).map((implementedType) => {
      const interfaceType = cppTypeForDeclaredName(implementedType.name)!.slice(0, -1);
      return `if (__vexa_type == vexa::nativeTypeToken<${interfaceType}>()) return static_cast<${interfaceType}*>(this);`;
    }),
    ...(baseClass && mappedBaseType
      ? [`if (auto* __vexa_base = ${mappedBaseType.slice(0, -1)}::dynamicCast(__vexa_type)) return __vexa_base;`]
      : []),
  ];
  const dynamicMethods = [
    `  const void* dynamicTypeToken() const override { return vexa::nativeTypeToken<${classType}>(); }`,
    `  void* dynamicCast(const void* __vexa_type) override { ${dynamicCastBranches.join(" ")} return nullptr; }`,
    '  std::string dynamicToString() const override { return "[object Object]"; }',
  ];
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
  if (statement.body.kind === "ForStatement") {
    return emitFor(statement.body as ForStatement, indent, label);
  }
  if (statement.body.kind === "WhileStatement") {
    const loop = statement.body as WhileStatement;
    return `${indent}while ${emitParenthesizedCondition(loop.condition)} ${emitLoopBody(loop.body, indent, label)}`;
  }
  if (statement.body.kind === "DoWhileStatement") {
    const loop = statement.body as DoWhileStatement;
    return `${indent}do ${emitLoopBody(loop.body, indent, label)} while ${emitParenthesizedCondition(loop.condition)};`;
  }
  const body = emitStatement(statement.body, `${indent}  `);
  return [
    `${indent}try {`,
    body,
    `${indent}} catch (const vexa::LabeledBreakSignal& __vexa_signal) {`,
    `${indent}  if (__vexa_signal.label() != ${cppString(label)}) throw;`,
    `${indent}}`,
  ].join("\n");
}

function emitStatement(statement: Statement, indent = ""): string {
  switch (statement.kind) {
    case "BlockStatement":
      return `${indent}${emitBlock(statement as BlockStatement, indent)}`;
    case "ExprStatement": {
      const expression = (statement as ExprStatement).expression;
      if (expression.kind === "UnaryExpression" && (expression as UnaryExpression).operator === "yield*") {
        if (!activeGeneratorResultType) throw new CppEmitError("C++ yield* emission requires a generator callable", statement);
        const temporary = `__vexa_yield_value_${activeYieldTemporaryCounter++}`;
        const argument = (expression as UnaryExpression).argument;
        const emittedIterable = emitExpression(argument);
        const iterable = isManagedArrayExpression(argument)
          ? `*vexa::arrayPointer(${emittedIterable})`
          : emittedIterable;
        return [
          `${indent}for (auto&& ${temporary} : ${iterable}) {`,
          `${indent}  co_yield vexa::convertValue<${activeGeneratorResultType}>(${activeRuntimeName}, ${temporary});`,
          `${indent}}`,
        ].join("\n");
      }
      return `${indent}${emitExpression(expression)};`;
    }
    case "VarStatement":
      return `${indent}${emitVariable(statement as VarStatement)};`;
    case "ForStatement":
      return emitFor(statement as ForStatement, indent);
    case "SwitchStatement":
      return emitSwitch(statement as SwitchStatement, indent);
    case "IfStatement": {
      const branch = statement as IfStatement;
      const alternate = branch.elseBranch ? ` else ${emitBody(branch.elseBranch, indent)}` : "";
      return `${indent}if ${emitParenthesizedCondition(branch.condition)} ${emitBody(branch.thenBranch, indent)}${alternate}`;
    }
    case "WhileStatement": {
      const loop = statement as WhileStatement;
      return `${indent}while ${emitParenthesizedCondition(loop.condition)} ${emitLoopBody(loop.body, indent)}`;
    }
    case "DoWhileStatement": {
      const loop = statement as DoWhileStatement;
      return `${indent}do ${emitLoopBody(loop.body, indent)} while ${emitParenthesizedCondition(loop.condition)};`;
    }
    case "LabeledStatement":
      return emitLabeledStatement(statement as LabeledStatement, indent);
    case "ReturnStatement": {
      const returned = (statement as ReturnStatement).expression;
      if (activeFinallyProtectedDepth > 0 && activeCallableResultType) {
        if (!returned || activeCallableResultType === "void") {
          return `${indent}throw vexa::ReturnSignal<${activeCallableResultType}>();`;
        }
        const emitted = emitExpression(returned);
        const returnedType = activeExpressionTypes.get(returned as Node);
        const flattened = activeAsyncResultType && returnedType?.kind === "named" && returnedType.name === "Promise"
          ? `(co_await ${emitted})`
          : emitted;
        return `${indent}throw vexa::ReturnSignal<${activeCallableResultType}>(${flattened});`;
      }
      if (activeGeneratorResultType) {
        return `${indent}co_return ${returned
          ? emitExpression(returned)
          : `vexa::defaultValue<${activeGeneratorResultType}>()`};`;
      }
      if (activeAsyncResultType) {
        if (!returned) return `${indent}co_return;`;
        const emitted = emitExpression(returned);
        const returnedType = activeExpressionTypes.get(returned as Node);
        const flattened = returnedType?.kind === "named" && returnedType.name === "Promise"
          ? `(co_await ${emitted})`
          : emitted;
        return `${indent}co_return ${flattened};`;
      }
      return `${indent}return${returned ? ` ${emitExpression(returned)}` : ""};`;
    }
    case "ThrowStatement":
      return `${indent}vexa::throwValue(${emitExpression((statement as ThrowStatement).expression)});`;
    case "TryStatement":
      return emitTry(statement as TryStatement, indent);
    case "BreakStatement": {
      const control = statement as BreakStatement;
      if (control.label) {
        return `${indent}throw vexa::LabeledBreakSignal(${cppString(control.label.name)});`;
      }
      const boundaryDepth = activeBreakBoundaryDepths.at(-1) ?? activeFinallyProtectedDepth;
      return activeFinallyProtectedDepth > boundaryDepth
        ? `${indent}throw vexa::BreakSignal();`
        : `${indent}break;`;
    }
    case "ContinueStatement": {
      const control = statement as ContinueStatement;
      if (control.label) {
        return `${indent}throw vexa::LabeledContinueSignal(${cppString(control.label.name)});`;
      }
      const boundaryDepth = activeContinueBoundaryDepths.at(-1) ?? activeFinallyProtectedDepth;
      return activeFinallyProtectedDepth > boundaryDepth
        ? `${indent}throw vexa::ContinueSignal();`
        : `${indent}continue;`;
    }
    case "FunctionStatement":
      return `${indent}${emitFunction(statement as FunctionStatement)}`;
    case "ClassStatement":
      return `${indent}${emitClass(statement as ClassStatement)}`;
    case "ExportStatement": {
      const declaration = (statement as ExportStatement).declaration;
      return declaration ? emitStatement(declaration, indent) : "";
    }
    case "EmptyStatement":
      return `${indent};`;
    case "DebuggerStatement":
      return `${indent}/* debugger */;`;
    case "TypeAliasStatement":
    case "InterfaceStatement":
    case "EnumStatement":
    case "ImportStatement":
      return "";
    default:
      throw new CppEmitError(`C++ emission does not support ${statement.kind} statements yet`, statement);
  }
}

export interface CppEmitSemantics {
  sourceFilePath?: string;
  expressionTypes?: ReadonlyMap<Node, AnalysisType>;
  implicitReceiverIdentifiers?: ReadonlySet<Node>;
  implicitReceiverExtensionIdentifiers?: ReadonlyMap<Node, string>;
  staticImplicitReceiverIdentifiers?: ReadonlyMap<Node, string>;
  autoAwaitExpressions?: ReadonlySet<Node>;
  callableTypes?: ReadonlyMap<Node, AnalysisType>;
  operatorResolutions?: ReadonlyMap<Node, AnalysisSymbol>;
  extensionPropertyResolutions?: ReadonlyMap<Node, ExtensionPropertyResolution>;
}

function interfacesInDependencyOrder(interfaces: readonly InterfaceStatement[]): InterfaceStatement[] {
  const byName = new Map(interfaces.map((statement) => [statement.name.name, statement]));
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const result: InterfaceStatement[] = [];
  const visit = (statement: InterfaceStatement): void => {
    const name = statement.name.name;
    if (emitted.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const extendedType of statement.extendsTypes ?? []) {
      const parent = byName.get(parseTypeNameShape(extendedType.name).baseName);
      if (parent) visit(parent);
    }
    visiting.delete(name);
    emitted.add(name);
    result.push(statement);
  };
  interfaces.forEach(visit);
  return result;
}

function classesInDependencyOrder(classes: readonly ClassStatement[]): ClassStatement[] {
  const byName = new Map(classes.map((statement) => [statement.name.name, statement]));
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const result: ClassStatement[] = [];
  const visit = (statement: ClassStatement): void => {
    const name = statement.name.name;
    if (emitted.has(name) || visiting.has(name)) return;
    visiting.add(name);
    const parent = statement.extendsType
      ? byName.get(parseTypeNameShape(statement.extendsType.name).baseName)
      : undefined;
    if (parent) visit(parent);
    visiting.delete(name);
    emitted.add(name);
    result.push(statement);
  };
  classes.forEach(visit);
  return result;
}

export function emitCppProgram(program: Program, semantics: CppEmitSemantics = {}): string {
  const statements = program.body.map((statement) =>
    statement.kind === "ExportStatement" && (statement as ExportStatement).declaration
      ? (statement as ExportStatement).declaration!
      : statement
  );
  const interfaces = statements.filter(
    (statement): statement is InterfaceStatement => statement.kind === "InterfaceStatement"
  );
  const enums = statements.filter(
    (statement): statement is EnumStatement => statement.kind === "EnumStatement"
  );
  const typeAliases = statements.filter(
    (statement): statement is TypeAliasStatement => statement.kind === "TypeAliasStatement"
  );
  const classes = statements.filter((statement): statement is ClassStatement => statement.kind === "ClassStatement");
  const functions = statements.filter((statement): statement is FunctionStatement => statement.kind === "FunctionStatement");
  const extensionProperties = statements.filter(
    (statement): statement is VarStatement => statement.kind === "VarStatement" && Boolean((statement as VarStatement).receiverType)
  );
  activeClassStatements = new Map(classes.map((statement) => [statement.name.name, statement]));
  activeClassNames = new Set(activeClassStatements.keys());
  activeDerivedClassNames = new Set(classes
    .map((statement) => statement.extendsType
      ? parseTypeNameShape(statement.extendsType.name).baseName
      : undefined)
    .filter((name): name is string => Boolean(name && activeClassNames.has(name))));
  activeInterfaceStatements = new Map(interfaces.map((statement) => [statement.name.name, statement]));
  activeInterfaceNames = new Set(activeInterfaceStatements.keys());
  activeEnumNames = new Set(enums.map((statement) => statement.name.name));
  activeTypeAliases = new Map(typeAliases
    .filter((statement) => !statement.typeParameters?.length)
    .map((statement) => [statement.name.name, statement.targetType.name]));
  activeCppTypeParameters = new Set();
  activeFunctionStatements = new Map(functions
    .filter((statement) => !statement.receiverType)
    .map((statement) => [statement.name.name, statement]));
  const extensionFunctions = new Map<string, FunctionStatement[]>();
  for (const statement of functions) {
    if (!statement.receiverType) continue;
    const existing = extensionFunctions.get(statement.receiverType.name) ?? [];
    existing.push(statement);
    extensionFunctions.set(statement.receiverType.name, existing);
  }
  activeExtensionFunctions = extensionFunctions;
  activeExtensionProperties = new Map(extensionProperties
    .filter((statement) => statement.name.kind === "Identifier" && statement.receiverType)
    .map((statement) => [`${statement.receiverType!.name}.${(statement.name as Identifier).name}`, statement]));
  activeGcObjectTypes = new Map();
  activeGcArrayTypes = new Map();
  activeDynamicValueNames = new Set();
  activeFunctionObjectCapture = false;
  activeFunctionObjectCaptureNames = null;
  activeExpressionTypes = semantics.expressionTypes ?? new Map();
  activeImplicitReceiverIdentifiers = semantics.implicitReceiverIdentifiers ?? new Set();
  activeImplicitReceiverExtensionIdentifiers = semantics.implicitReceiverExtensionIdentifiers ?? new Map();
  activeStaticImplicitReceiverIdentifiers = semantics.staticImplicitReceiverIdentifiers ?? new Map();
  activeAutoAwaitExpressions = semantics.autoAwaitExpressions ?? new Set();
  activeCallableTypes = semantics.callableTypes ?? new Map();
  activeOperatorResolutions = semantics.operatorResolutions ?? new Map();
  activeExtensionPropertyResolutions = semantics.extensionPropertyResolutions ?? new Map();
  activeSourceFilePath = semantics.sourceFilePath ?? null;
  activeOperatorMethodsByNameNode = new Map(
    classes.flatMap((statement) => statement.members
      .filter((member): member is ClassMethodMember => member.kind === "ClassMethodMember" && Boolean(member.operator))
      .map((member) => [member.name as Node, member] as const))
  );
  activeSuppressAutoAwait = false;
  activeAsyncResultType = null;
  activeGeneratorResultType = null;
  activeYieldTemporaryCounter = 0;
  activeExceptionTemporaryCounter = 0;
  activeSwitchTemporaryCounter = 0;
  activeDestructureTemporaryCounter = 0;
  activeCurrentClassName = null;
  activeCurrentMethodStatic = false;
  activeLocalNames = new Set();
  activeRuntimeName = "runtime";

  const forwardInterfaces = interfaces.map((statement) =>
    `${cppTemplatePrefix(statement.typeParameters, "", true)}class ${cppName(statement.name.name)};`
  );
  const forwardClasses = classes.map((statement) =>
    `${cppTemplatePrefix(statement.typeParameters, "", true)}class ${cppName(statement.name.name)};`
  );
  const enumDefinitions = enums.map(emitEnum);
  const interfaceDefinitions = interfacesInDependencyOrder(interfaces).map(emitInterface);
  const recordInterfaceAdapters = interfacesInDependencyOrder(interfaces)
    .map(emitRecordInterfaceAdapter)
    .filter((definition): definition is string => definition !== null);
  const functionPrototypes = functions.map((statement) =>
    `${cppTemplatePrefix(statement.typeParameters, "", true)}${functionSignature(statement)};`
  );
  const classDefinitions = classesInDependencyOrder(classes).map(emitClass);
  const functionDefinitions = functions.map(emitFunction);
  const extensionPropertyDefinitions = extensionProperties.map(emitExtensionProperty);
  const declarationSections = [
    [...forwardInterfaces, ...forwardClasses],
    enumDefinitions,
    interfaceDefinitions,
    recordInterfaceAdapters,
    functionPrototypes,
    classDefinitions,
    functionDefinitions,
    extensionPropertyDefinitions,
  ]
    .filter((section) => section.length > 0);
  const declarations = declarationSections.flatMap((section, index) =>
    index === declarationSections.length - 1 ? section : [...section, ""]
  );

  activeGcObjectTypes = new Map();
  activeGcArrayTypes = new Map();
  activeDynamicValueNames = new Set();
  activeCurrentClassName = null;
  activeCurrentMethodStatic = false;
  activeLocalNames = new Set();
  activeRuntimeName = "runtime";
  const entryStatements: string[] = [];
  for (const statement of statements) {
    if (
      statement.kind === "FunctionStatement" ||
      statement.kind === "ClassStatement" ||
      (statement.kind === "VarStatement" && Boolean((statement as VarStatement).receiverType))
    ) continue;
    const emitted = emitStatement(statement, "    ");
    if (!emitted) continue;
    entryStatements.push(...emitStatementPreamble(statement, "    "));
    entryStatements.push(emitted);
  }

  return [
    "// Generated by VexaScript. Compile through `vexa build <file> --emit cpp --native`.",
    '#include "runtime.cpp"',
    "",
    ...declarations,
    declarations.length > 0 ? "" : null,
    "int main() {",
    "  vexa::Runtime runtime;",
    "  try {",
    ...entryStatements,
    "    runtime.runEventLoop();",
    "  } catch (const std::exception& error) {",
    '    std::cerr << "Uncaught " << error.what();',
    "    const auto location = runtime.sourceLocation();",
    '    if (!location.empty()) std::cerr << " at " << location;',
    "    std::cerr << std::endl;",
    "    return 1;",
    "  }",
    "  return 0;",
    "}",
    "",
  ].filter((line): line is string => line !== null).join("\n");
}
