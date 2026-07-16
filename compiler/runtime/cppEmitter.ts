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
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
} from "compiler/ast/ast";
import { compoundAssignmentBinaryOperator } from "compiler/ast/ast";
import { bindingElementPropertyName } from "compiler/ast/bindingPatterns";
import type { AnalysisType, BuiltinTypeName } from "compiler/analysis/types";
import type { AnalysisSymbol } from "compiler/analysis/model";
import { splitArraySuffixTypeName } from "compiler/analysis/typeNames";
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
let activeGcObjectTypes: Map<string, string> = new Map();
let activeExpressionTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeFunctionStatements: ReadonlyMap<string, FunctionStatement> = new Map();
let activeClassStatements: ReadonlyMap<string, ClassStatement> = new Map();
let activeDerivedClassNames: ReadonlySet<string> = new Set();
let activeInterfaceStatements: ReadonlyMap<string, InterfaceStatement> = new Map();
let activeCurrentClassName: string | null = null;
let activeCurrentMethodStatic = false;
let activeLocalNames: Set<string> = new Set();
let activeRuntimeName = "runtime";
let activeThisExpression = "this";
let activeImplicitReceiverIdentifiers: ReadonlySet<Node> = new Set();
let activeStaticImplicitReceiverIdentifiers: ReadonlyMap<Node, string> = new Map();
let activeAutoAwaitExpressions: ReadonlySet<Node> = new Set();
let activeCallableTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeOperatorResolutions: ReadonlyMap<Node, AnalysisSymbol> = new Map();
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

function cppName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const withValidStart = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return CPP_RESERVED_WORDS.has(withValidStart) ? `vexa_${withValidStart}` : withValidStart;
}

function cppOperatorMethodName(operator: OverloadableOperator, parameters: readonly FunctionParameter[]): string {
  return cppName(operatorMethodRuntimeName(operator, parameters));
}

function identifierName(expression: Expr): string | null {
  return expression.kind === "Identifier" ? (expression as Identifier).name : null;
}

function emitIdentifier(identifier: Identifier): string {
  if (identifier.name === "this") return activeThisExpression;
  const staticClassName = activeStaticImplicitReceiverIdentifiers.get(identifier as Node);
  if (staticClassName) {
    return `${cppName(staticClassName)}::${cppName(identifier.name)}`;
  }
  if (activeImplicitReceiverIdentifiers.has(identifier as Node)) {
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
  if (type.kind === "literal") {
    return cppTypeForBuiltin(type.base === "number" ? "number" : type.base);
  }
  if (type.kind === "array") {
    const elementType = cppArrayElementType(type.elementType);
    return elementType ? `std::vector<${elementType}>` : null;
  }
  if (type.kind === "range") {
    const elementType = cppArrayElementType(type.elementType);
    return elementType ? `std::vector<${elementType}>` : null;
  }
  if (type.kind === "tuple") {
    const elementTypes = new Set(type.elements.map(cppArrayElementType));
    const elementType = elementTypes.size === 1 ? [...elementTypes][0] : null;
    return elementType ? `std::vector<${elementType}>` : null;
  }
  if (type.kind === "object") return "vexa::RecordObject*";
  if (type.kind === "named" && type.name === "Promise") {
    const resultType = cppTypeForAnalysisType(type.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" });
    return `vexa::Task<${resultType ?? "vexa::Value"}>`;
  }
  if (type.kind === "named" && type.name === "RegExp") return "vexa::RegExp";
  if (type.kind === "named" && activeEnumNames.has(type.name)) return "std::int32_t";
  if (type.kind === "named" && isNativeObjectTypeName(type.name)) {
    return `${cppName(type.name)}*`;
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
      result = `std::vector<${result}>`;
    }
    return result;
  }
  const builtin = cppTypeForBuiltin(typeName as BuiltinTypeName);
  if (builtin) return builtin;
  if (activeEnumNames.has(typeName)) return "std::int32_t";
  if (isNativeObjectTypeName(typeName)) return `${cppName(typeName)}*`;
  if (visitedAliases.has(typeName)) return null;
  const aliasTarget = activeTypeAliases.get(typeName);
  if (!aliasTarget) return null;
  visitedAliases.add(typeName);
  return cppTypeForDeclaredName(aliasTarget, visitedAliases);
}

function isNativeObjectTypeName(typeName: string): boolean {
  return activeClassNames.has(typeName) || activeInterfaceNames.has(typeName);
}

function cppArrayElementType(type: AnalysisType): string | null {
  if (type.kind === "builtin" && type.name === "string") return "std::string";
  if (type.kind === "literal" && type.base === "string") return "std::string";
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
  if (expression.kind === "FloatLiteral") return "double";
  return "auto";
}

function isArrayExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === "array" || type?.kind === "tuple" || type?.kind === "range" ||
    expression.kind === "ArrayLiteral" || expression.kind === "RangeExpression";
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
  return `vexa::convertValue<${resultType}>(${activeRuntimeName}, ${emitExpression(expression)})`;
}

function emitArrayLiteral(array: ArrayLiteral): string {
  const type = cppTypeForExpression(array as unknown as Expr);
  if (!type.startsWith("std::vector<")) {
    throw new CppEmitError("C++ emission requires arrays with one supported element type");
  }
  const emitElement = (element: Expr): string => {
    const emitted = emitExpression(element);
    return type === "std::vector<std::string>" ? `vexa::toString(${emitted})` : emitted;
  };
  const hasExpandedElements = array.elements.some((element) =>
    element.kind === "ArrayHole" || element.kind === "SpreadExpression");
  if (hasExpandedElements) {
    const operations = array.elements.map((element) => {
      if (element.kind === "ArrayHole") {
        if (type !== "std::vector<vexa::Value>") {
          throw new CppEmitError("C++ sparse arrays require a dynamic value element type");
        }
        return "__vexa_array.push_back(vexa::Value::undefined())";
      }
      if (element.kind === "SpreadExpression") {
        const argument = (element as SpreadExpression).argument;
        return type === "std::vector<vexa::Value>"
          ? `vexa::appendAllConverted(${activeRuntimeName}, __vexa_array, ${emitExpression(argument)})`
          : `vexa::appendAll(__vexa_array, ${emitExpression(argument)})`;
      }
      const value = type === "std::vector<vexa::Value>"
        ? emitConvertedValue(element as Expr, "vexa::Value")
        : emitElement(element as Expr);
      return `__vexa_array.push_back(${value})`;
    });
    return `([&]() { ${type} __vexa_array; ${operations.join("; ")}; return __vexa_array; }())`;
  }
  const elements = type === "std::vector<vexa::Value>"
    ? array.elements.map((element) => emitConvertedValue(element as Expr, "vexa::Value"))
    : array.elements.map((element) => emitElement(element as Expr));
  return `${type}{${elements.join(", ")}}`;
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
    if (objectProperty.method) {
      throw new CppEmitError("C++ object method emission is not implemented yet");
    }
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
  return ordered.map((argument, index) => {
    const parameterType = parameters[index]?.typeAnnotation?.name;
    return parameterType && activeInterfaceNames.has(parameterType) && isRecordExpression(argument!)
      ? emitRecordInterfaceAdaptation(argument!, parameterType)
      : emitExpression(argument!);
  }).join(", ");
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
    if (tracked) return tracked;
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
  return type?.kind === "named" && isNativeObjectTypeName(type.name) ? type.name : null;
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
    const parent = activeInterfaceStatements.get(extendedType.name);
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
  kind: "method" | "record";
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
  const propertyName = !member.computed ? identifierName(member.property) : null;
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
  const keyDeclaration = property.kind === "record" && property.keyExpression
    ? ` auto __vexa_property_key = ${emitNativePropertyKey(property)};`
    : "";
  const key = property.kind === "record" && property.keyExpression
    ? "__vexa_property_key"
    : undefined;
  if (assignment.operator === "=") {
    return `([&]() { auto* __vexa_property_receiver = ${receiver};${keyDeclaration} auto __vexa_property_value = ${emitExpression(assignment.right)}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)}; return __vexa_property_value; }())`;
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
  const value = binaryOperator === "+" && propertyType === "vexa::Value"
    ? `vexa::add(${activeRuntimeName}, __vexa_property_current, __vexa_property_operand)`
    : `(__vexa_property_current ${binaryOperator} __vexa_property_operand)`;
  return `([&]() { auto* __vexa_property_receiver = ${receiver};${keyDeclaration} auto __vexa_property_current = ${emitNativePropertyGet(property, "__vexa_property_receiver", key)}; auto __vexa_property_operand = ${emitExpression(assignment.right)}; auto __vexa_property_value = ${value}; ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)}; return __vexa_property_value; }())`;
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
  const keyDeclaration = property.kind === "record" && property.keyExpression
    ? ` auto __vexa_property_key = ${emitNativePropertyKey(property)};`
    : "";
  const key = property.kind === "record" && property.keyExpression
    ? "__vexa_property_key"
    : undefined;
  return `([&]() { auto* __vexa_property_receiver = ${receiver};${keyDeclaration} auto __vexa_property_current = ${emitNativePropertyGet(property, "__vexa_property_receiver", key)}; auto __vexa_property_value = (__vexa_property_current ${delta} 1); ${emitNativePropertySet(property, "__vexa_property_receiver", "__vexa_property_value", key)}; return ${returned}; }())`;
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
    ? activeClassStatements.get(statement.extendsType.name)
    : undefined;
  return parent ? classMethodForName(parent, methodName, visited) : null;
}

function inheritedClassMethodForName(statement: ClassStatement, methodName: string): ClassMethodMember | null {
  const parent = statement.extendsType
    ? activeClassStatements.get(statement.extendsType.name)
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
  return Boolean(statement?.members.some((member) => member.kind === "ClassFieldMember"));
}

function nativeLambdaCapture(selfName: string, referenceEntryLocals: boolean): {
  text: string;
  thisExpression: string;
} {
  if (referenceEntryLocals && activeRuntimeName === "runtime") {
    return { text: "[&]", thisExpression: activeThisExpression };
  }
  const captures = ["="];
  for (const [sourceName, className] of activeGcObjectTypes) {
    const name = cppName(sourceName);
    captures.push(`${name} = cppgc::Persistent<${cppName(className)}>(${name})`);
  }
  const rootThis = activeCurrentClassName !== null && !activeCurrentMethodStatic;
  if (rootThis) {
    captures.push(`${selfName} = cppgc::Persistent<${cppName(activeCurrentClassName!)}>(this)`);
  }
  captures.push(`&${activeRuntimeName}`);
  return {
    text: `[${captures.join(", ")}]`,
    thisExpression: rootThis ? selfName : activeThisExpression,
  };
}

function emitNativeLambda(parametersList: readonly FunctionParameter[], body: Expr | BlockStatement): string {
  const capture = nativeLambdaCapture("__vexa_callback_self", true);
  const parameters = callableParameters(parametersList, undefined, false);
  const previousLocalNames = activeLocalNames;
  const previousGcObjectTypes = activeGcObjectTypes;
  const previousThisExpression = activeThisExpression;
  activeLocalNames = new Set([...activeLocalNames, ...parameters.names]);
  activeGcObjectTypes = new Map([...activeGcObjectTypes, ...parameters.gcTypes]);
  activeThisExpression = capture.thisExpression;
  try {
    const prefix = `${capture.text}(${parameters.text})${activeRuntimeName === "runtime" ? "" : " mutable"}`;
    return body.kind === "BlockStatement"
      ? `${prefix} ${emitBlock(body as BlockStatement, "")}`
      : `${prefix} { return ${emitExpression(body as Expr)}; }`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
    activeThisExpression = previousThisExpression;
  }
}

function emitArrowFunction(expression: ArrowFunctionExpression): string {
  if (expression.async || expression.sync) {
    throw new CppEmitError("C++ emission currently supports synchronous arrow functions only");
  }
  return emitNativeLambda(expression.parameters, expression.body);
}

function emitFunctionExpression(expression: FunctionExpression): string {
  if (expression.async || expression.sync || expression.generator || expression.name || expression.typeParameters?.length) {
    throw new CppEmitError("C++ emission currently supports anonymous synchronous non-generic function expressions only");
  }
  return emitNativeLambda(expression.parameters, expression.body);
}

function emitClassConstruction(callee: Expr, argumentsList: readonly Expr[]): string {
  const className = identifierName(callee);
  if (!className || !activeClassNames.has(className)) {
    throw new CppEmitError("C++ explicit construction currently supports generated classes only");
  }
  const classStatement = activeClassStatements.get(className);
  const constructorArguments = emitArguments(argumentsList, classStatement?.primaryConstructorParameters);
  const nativeArguments = classUsesRuntimeConstructor(classStatement)
    ? withRuntimeArgument(constructorArguments)
    : constructorArguments;
  return `${activeRuntimeName}.make<${cppName(className)}>(${nativeArguments})`;
}

function emitTimerCallback(expression: Expr): string {
  const functionName = identifierName(expression);
  const statement = functionName ? activeFunctionStatements.get(functionName) : undefined;
  if (!statement) return emitExpression(expression);
  if (statement.parameters.length > 0) {
    throw new CppEmitError("C++ timer callbacks cannot require arguments");
  }
  const capture = `[&${activeRuntimeName}]()`;
  return `${capture} { ${cppName(functionName!)}(${activeRuntimeName}); }`;
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

function emitCall(call: CallExpression): string {
  const calleeName = identifierName(call.callee);
  if (calleeName === "Promise") return emitPromiseCall(call);
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
  if (member?.objectName === "Object" && new Set(["keys", "values"]).has(member.propertyName)) {
    if (call.arguments.length !== 1) throw new CppEmitError(`C++ Object.${member.propertyName} expects one object`);
    return `vexa::record${member.propertyName === "keys" ? "Keys" : "Values"}(${emitExpression(call.arguments[0]!)})`;
  }
  if (member?.objectName === "Promise") {
    if (member.propertyName === "resolve") {
      if (call.arguments.length > 1) throw new CppEmitError("C++ Promise.resolve expects zero or one argument");
      return call.arguments.length === 0
        ? `vexa::resolvedTask(${activeRuntimeName}, vexa::Value::undefined())`
        : `vexa::resolvedTask(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)})`;
    }
    if (member.propertyName === "reject") {
      if (call.arguments.length !== 1) throw new CppEmitError("C++ Promise.reject expects one reason");
      const promiseType = activeExpressionTypes.get(call as Node);
      const valueType = promiseType?.kind === "named" && promiseType.name === "Promise"
        ? cppTypeForAnalysisType(promiseType.typeArguments?.[0] ?? { kind: "builtin", name: "unknown" }) ?? "vexa::Value"
        : "vexa::Value";
      return `vexa::rejectedTask<${valueType}>(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)})`;
    }
    if (member.propertyName === "all") {
      if (call.arguments.length !== 1) throw new CppEmitError("C++ Promise.all expects one task array");
      return `vexa::promiseAll(${activeRuntimeName}, ${emitExpression(call.arguments[0]!)})`;
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
  const arrayRuntimeMethods = new Set([
    "push", "pop", "shift", "unshift", "includes", "indexOf", "join", "reverse",
    "slice", "concat", "map", "filter", "reduce",
  ]);
  if (member && isArrayExpression(member.object) && arrayRuntimeMethods.has(member.propertyName)) {
    const receiver = emitExpression(member.object);
    const convertsValueArguments = new Set(["push", "unshift", "includes", "indexOf", "concat"])
      .has(member.propertyName);
    const arrayArguments = cppTypeForExpression(member.object) === "std::vector<vexa::Value>" && convertsValueArguments
      ? call.arguments.map((argument) => emitConvertedValue(argument, "vexa::Value")).join(", ")
      : argumentsText;
    return `vexa::${member.propertyName}(${receiver}${arrayArguments ? `, ${arrayArguments}` : ""})`;
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
      return `vexa::${primitiveMethod}(${receiver}${argumentsText ? `, ${argumentsText}` : ""})`;
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
        return `${cppName(className)}::${cppName(method.name.name)}(${withRuntimeArgument(methodArguments)})`;
      }
      return `${emitExpression(call.callee)}(${withRuntimeArgument(methodArguments)})`;
    }
  }

  if (calleeName === "setTimeout" || calleeName === "setInterval") {
    if (call.arguments.length < 1 || call.arguments.length > 2) {
      throw new CppEmitError(`C++ ${calleeName} expects a callback and an optional delay`);
    }
    const callback = emitTimerCallback(call.arguments[0]!);
    const delay = call.arguments[1] ? `, ${emitExpression(call.arguments[1])}` : "";
    return `${activeRuntimeName}.${calleeName}(${callback}${delay})`;
  }
  if (calleeName === "clearTimeout" || calleeName === "clearInterval") {
    if (call.arguments.length !== 1) {
      throw new CppEmitError(`C++ ${calleeName} expects one timer id`);
    }
    return `${activeRuntimeName}.${calleeName}(${emitExpression(call.arguments[0]!)})`;
  }
  const runtimeGlobals = new Set(["String", "Number", "Boolean", "Error", "parseInt", "parseFloat", "isNaN", "isFinite"]);
  if (calleeName && runtimeGlobals.has(calleeName)) {
    return `vexa::${cppName(calleeName)}(${argumentsText})`;
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
      return `${cppName(activeCurrentClassName!)}::${cppName(calleeName)}(${withRuntimeArgument(methodArguments)})`;
    }
    if (activeCurrentMethodStatic) {
      throw new CppEmitError("C++ static methods cannot make implicit instance method calls");
    }
    return `${activeThisExpression}->${cppName(calleeName)}(${withRuntimeArgument(methodArguments)})`;
  }
  const functionStatement = calleeName ? activeFunctionStatements.get(calleeName) : undefined;
  if (calleeName && functionStatement) {
    const functionArguments = emitCallArguments(call, functionStatement.parameters);
    return `${cppName(calleeName)}(${withRuntimeArgument(functionArguments)})`;
  }
  if (calleeName && activeClassNames.has(calleeName)) {
    return emitClassConstruction(call.callee, call.arguments);
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

function emitBinary(expression: BinaryExpression): string {
  const overloaded = emitResolvedBinaryOperator(expression);
  if (overloaded) return overloaded;
  if (expression.operator === "**") {
    return `vexa::Math::pow(${emitExpression(expression.left)}, ${emitExpression(expression.right)})`;
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
  if (expression.operator === "+" && cppTypeForExpression(expression) === "vexa::Value") {
    return `vexa::add(${activeRuntimeName}, ${emitExpression(expression.left)}, ${emitExpression(expression.right)})`;
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
    const value = cppTypeForExpression(expression.right) === "std::vector<vexa::Value>"
      ? emitConvertedValue(expression.left, "vexa::Value")
      : emitExpression(expression.left);
    return `vexa::includes(${emitExpression(expression.right)}, ${value})`;
  }
  if (expression.operator === "in" && isRecordExpression(expression.right)) {
    return `vexa::recordHas(${emitExpression(expression.right)}, vexa::propertyKey(${emitExpression(expression.left)}))`;
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
    if (operator === "==" || operator === "!=") return `(${left} ${operator} ${right})`;
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

function emitExpression(expression: Expr): string {
  switch (expression.kind) {
    case "IntLiteral":
    case "FloatLiteral":
      return String((expression as unknown as { value: number }).value);
    case "BigIntLiteral":
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
        throw new CppEmitError("C++ delete emission supports record properties only");
      }
      if (unary.operator === "yield*") {
        throw new CppEmitError(`C++ emission does not support unary '${unary.operator}' yet`);
      }
      return `(${unary.operator}${emitExpression(unary.argument)})`;
    }
    case "UpdateExpression": {
      const update = expression as UpdateExpression;
      const property = resolvedNativePropertyMember(update.argument);
      if (property) {
        return emitPropertyUpdate(update, property);
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
      return emitClassConstruction(construction.callee, construction.arguments ?? []);
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
        return `static_cast<double>(${emitExpression(member.object)}.size())`;
      }
      const propertyName = !member.computed ? identifierName(member.property) : null;
      const nativeProperty = resolvedNativePropertyMember(expression);
      if (nativeProperty?.kind === "record") {
        if (member.optional) {
          return `vexa::recordGetOptional(${emitExpression(member.object)}, ${emitNativePropertyKey(nativeProperty)})`;
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
        ? `${emitExpression(member.object)}[${emitExpression(member.property)}]`
        : `${emitExpression(member.object)}${isGcObjectExpression(member.object) ? "->" : "."}${cppName((member.property as Identifier).name)}`;
    }
    case "NamedArgument":
      return emitExpression((expression as unknown as { value: Expr }).value);
    case "AsExpression":
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
      if (element.initializer) {
        throw new CppEmitError("C++ destructuring defaults are not implemented yet");
      }
      if (element.rest) {
        if (element.name.kind !== "Identifier") {
          throw new CppEmitError("C++ nested rest destructuring is not implemented yet");
        }
        emitDestructuredBindings(element.name, `vexa::slice(${source}, ${index})`, lines);
      } else {
        emitDestructuredBindings(element.name, `${source}[${index}]`, lines);
      }
    });
    return;
  }
  for (const element of (binding as ObjectBindingPattern).elements) {
    if (element.initializer || element.rest) {
      throw new CppEmitError("C++ object destructuring defaults and rest are not implemented yet");
    }
    const propertyName = bindingElementPropertyName(element as BindingElement);
    if (!propertyName) throw new CppEmitError("C++ object destructuring requires static property names");
    const type = bindingValueType(element.name);
    emitDestructuredBindings(
      element.name,
      `vexa::recordGet<${type}>(${activeRuntimeName}, ${source}, ${cppString(propertyName)})`,
      lines
    );
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
    return `vexa::Value ${name}`;
  }
  const type = forInitializer ? cppTypeForExpression(statement.initializer) : "auto";
  const declaredTypeName = statement.typeAnnotation?.name;
  const initializer = declaredTypeName && activeInterfaceNames.has(declaredTypeName) && isRecordExpression(statement.initializer)
    ? emitRecordInterfaceAdaptation(statement.initializer, declaredTypeName)
    : emitExpression(statement.initializer);
  const className = declaredTypeName && isNativeObjectTypeName(declaredTypeName)
    ? declaredTypeName
    : classNameForExpression(statement.initializer);
  activeLocalNames.add(sourceName);
  if (className) {
    activeGcObjectTypes.set(sourceName, className);
  }
  if (className && activeGeneratorResultType) {
    return `cppgc::Persistent<${cppName(className)}> ${name}(${initializer})`;
  }
  return `${type} ${name} = ${initializer}`;
}

function emitBlock(block: BlockStatement, indent: string, trailingStatement?: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  try {
    const childIndent = `${indent}  `;
    const lines = block.body.map((statement) => emitStatement(statement, childIndent));
    if (trailingStatement) lines.push(`${childIndent}${trailingStatement}`);
    return lines.length > 0 ? `{\n${lines.join("\n")}\n${indent}}` : "{}";
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
  }
}

function emitBody(statement: Statement, indent: string): string {
  return statement.kind === "BlockStatement"
    ? emitBlock(statement as BlockStatement, indent)
    : emitBlock({ kind: "BlockStatement", body: [statement] } as BlockStatement, indent);
}

function emitLoopBody(statement: Statement, indent: string): string {
  activeBreakBoundaryDepths.push(activeFinallyProtectedDepth);
  activeContinueBoundaryDepths.push(activeFinallyProtectedDepth);
  try {
    const body = emitBody(statement, `${indent}  `);
    return [
      "{",
      `${indent}  try ${body}`,
      `${indent}  catch (const vexa::ContinueSignal&) { continue; }`,
      `${indent}  catch (const vexa::BreakSignal&) { break; }`,
      `${indent}}`,
    ].join("\n");
  } finally {
    activeBreakBoundaryDepths.pop();
    activeContinueBoundaryDepths.pop();
  }
}

function emitFor(statement: ForStatement, indent: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  try {
    if (statement.iterationKind || statement.iterator || statement.iterable) {
      if ((statement.iterationKind !== "of" && statement.iterationKind !== "in") || !statement.iterator || !statement.iterable) {
        throw new CppEmitError("C++ emission supports Vexa for-in/for-of loops only", statement);
      }
      const iteratorName = statement.iterator.kind === "Identifier"
        ? (statement.iterator as Identifier).name
        : statement.iterator.kind === "VarStatement" && (statement.iterator as VarStatement).name.kind === "Identifier"
          ? ((statement.iterator as VarStatement).name as Identifier).name
          : null;
      if (!iteratorName) {
        throw new CppEmitError("C++ for-of emission currently supports identifier bindings only", statement);
      }
      if (!isArrayExpression(statement.iterable) && !isGeneratorExpression(statement.iterable)) {
        throw new CppEmitError("C++ for-of emission currently supports arrays and generators only", statement);
      }
      const iterable = emitExpression(statement.iterable);
      activeLocalNames.add(iteratorName);
      return `${indent}for (auto ${cppName(iteratorName)} : ${iterable}) ${emitLoopBody(statement.body, indent)}`;
    }
    const initializer = statement.initializer
      ? statement.initializer.kind === "VarStatement"
        ? emitVariable(statement.initializer as VarStatement, true)
        : emitExpression(statement.initializer as Expr)
      : "";
    const condition = statement.condition ? emitCondition(statement.condition) : "";
    const compactCondition = condition.startsWith("(") && condition.endsWith(")") ? condition.slice(1, -1) : condition;
    return `${indent}for (${initializer}; ${compactCondition}; ${statement.update ? emitExpression(statement.update) : ""}) ${emitLoopBody(statement.body, indent)}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
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

function callableParameters(parameters: readonly FunctionParameter[], owner: Statement | undefined, allowDefaults = true): {
  text: string;
  names: string[];
  gcTypes: Map<string, string>;
} {
  const names: string[] = [];
  const gcTypes = new Map<string, string>();
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
    const type = typeName ? cppTypeForDeclaredName(typeName) : null;
    if (!type || type === "void") {
      throw new CppEmitError("C++ emission requires supported type annotations on function and method parameters", owner);
    }
    names.push(sourceName);
    if (typeName && isNativeObjectTypeName(typeName)) gcTypes.set(sourceName, typeName);
    return `${type} ${cppName(sourceName)}`;
  }).join(", ");
  return { text, names, gcTypes };
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
    statement.receiverType ||
    statement.operator ||
    statement.typeParameters?.length
  ) {
    throw new CppEmitError(
      "C++ emission supports concrete, non-generic top-level functions only",
      statement
    );
  }
}

function functionSignature(statement: FunctionStatement): string {
  validateFunction(statement);
  const asyncLike = Boolean(statement.async || statement.sync);
  const generatorInfo = callableGeneratorInfo(
    statement.name,
    statement.returnType,
    Boolean(statement.generator),
    asyncLike,
    statement
  );
  return callableSignature(
    statement.name,
    statement.parameters,
    statement.returnType,
    statement.body,
    statement,
    generatorInfo ? false : callableProducesTask(statement.name, statement.returnType, asyncLike),
    generatorInfo
  );
}

function emitFunction(statement: FunctionStatement): string {
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
    null,
    false,
    asyncResultType,
    generatorInfo?.resultType ?? null,
    callableResultType,
    statement,
    () => {
      const body = generatorInfo
        ? emitGeneratorCallableBlock(statement.body, "  ", generatorInfo.resultType)
        : asyncResultType
          ? emitAsyncCallableBlock(statement.body, "  ", asyncResultType)
          : emitBlock(statement.body, "  ");
      return `${signature} ${emitCallableReturnBoundary(body, "", callableResultType, Boolean(generatorInfo || asyncResultType))}`;
    }
  );
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
  const traced = isNativeObjectTypeName(declaredType);
  return {
    valueType,
    storageType: traced ? `cppgc::Member<${cppName(declaredType)}>` : valueType,
    traced,
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
    (method.missingBody && !method.abstract) ||
    method.typeParameters?.length
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

function emitInterfaceProperty(property: InterfacePropertyMember, statement: InterfaceStatement): string[] {
  if (property.optional) {
    throw new CppEmitError("C++ emission supports required interface properties only", statement);
  }
  const type = cppTypeForDeclaredName(property.typeAnnotation.name);
  if (!type || type === "void") {
    throw new CppEmitError(
      `C++ emission does not support interface property type '${property.typeAnnotation.name}' yet`,
      statement
    );
  }
  const lines = [
    `  virtual ${type} ${interfacePropertyGetterName(property.name.name)}(vexa::Runtime& __vexa_runtime) = 0;`,
  ];
  if (isMutableInterfaceProperty(property)) {
    lines.push(
      `  virtual void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime& __vexa_runtime, ${type} value) = 0;`
    );
  }
  return lines;
}

function emitInterfaceMethod(method: InterfaceMethodMember, statement: InterfaceStatement): string {
  if (
    method.accessorKind ||
    method.computed ||
    method.optional ||
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
  return `  virtual ${resultType} ${cppName(method.name.name)}(vexa::Runtime& __vexa_runtime${parameters ? `, ${parameters}` : ""}) = 0;`;
}

function emitInterface(statement: InterfaceStatement): string {
  if (
    statement.typeParameters?.length ||
    (statement.extendsTypes?.length ?? 0) > 1
  ) {
    throw new CppEmitError("C++ emission supports non-generic interfaces with at most one base interface", statement);
  }
  const extendedInterfaces = (statement.extendsTypes ?? []).map((extendedType) => {
    if (!activeInterfaceNames.has(extendedType.name)) {
      throw new CppEmitError(
        `C++ interface '${statement.name.name}' can only extend another emitted interface`,
        statement
      );
    }
    return `public ${cppName(extendedType.name)}`;
  });
  const inheritance = extendedInterfaces.length > 0
    ? ` : ${extendedInterfaces.join(", ")}`
    : " : public cppgc::GarbageCollectedMixin";
  const traceBody = (statement.extendsTypes ?? [])
    .map((extendedType) => `${cppName(extendedType.name)}::Trace(visitor);`)
    .join(" ");
  const trace = traceBody
    ? `  void Trace(cppgc::Visitor* visitor) const override { ${traceBody} }`
    : "  void Trace(cppgc::Visitor*) const override {}";
  return [
    `class ${cppName(statement.name.name)}${inheritance} {`,
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
    const interfaceStatement = activeInterfaceStatements.get(implementedType.name);
    return Boolean(interfaceStatement && interfaceMethodForName(interfaceStatement, methodName));
  });
}

function implementedInterfaceTypes(statement: ClassStatement): Identifier[] {
  return [
    ...(statement.extendsType && activeInterfaceNames.has(statement.extendsType.name)
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
    const parent = activeInterfaceStatements.get(extendedType.name);
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
    const parent = activeInterfaceStatements.get(extendedType.name);
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
  if (!statement || interfaceMethods(statement).length > 0) {
    throw new CppEmitError(
      `C++ structural record adaptation currently supports property-only interface '${interfaceName}'`
    );
  }
  return `${activeRuntimeName}.make<${recordInterfaceAdapterName(interfaceName)}>(${emitExpression(expression)})`;
}

function emitRecordInterfaceAdapter(statement: InterfaceStatement): string | null {
  if (interfaceMethods(statement).length > 0) return null;
  const interfaceName = cppName(statement.name.name);
  const adapterName = recordInterfaceAdapterName(statement.name.name);
  const properties = interfaceProperties(statement).flatMap((property) => {
    const type = cppTypeForDeclaredName(property.typeAnnotation.name);
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
  return [
    `class ${adapterName} final : public cppgc::GarbageCollected<${adapterName}>, public ${interfaceName} {`,
    " public:",
    `  explicit ${adapterName}(vexa::RecordObject* record) : record_(record) {}`,
    `  void Trace(cppgc::Visitor* visitor) const override { ${interfaceName}::Trace(visitor); visitor->Trace(record_); }`,
    ...properties,
    " private:",
    "  cppgc::Member<vexa::RecordObject> record_;",
    "};",
  ].join("\n");
}

function implementedInterfaceProperties(statement: ClassStatement): InterfacePropertyMember[] {
  const properties = new Map<string, InterfacePropertyMember>();
  for (const implementedType of implementedInterfaceTypes(statement)) {
    const interfaceStatement = activeInterfaceStatements.get(implementedType.name);
    for (const property of interfaceStatement ? interfaceProperties(interfaceStatement) : []) {
      properties.set(property.name.name, property);
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
  return implementedInterfaceProperties(statement).flatMap((property) => {
    const implementation = classPropertyImplementation(statement, property.name.name);
    if (!implementation) {
      throw new CppEmitError(
        `C++ interface property '${property.name.name}' requires a field or getter implementation`,
        statement
      );
    }
    const type = cppTypeForDeclaredName(property.typeAnnotation.name);
    if (!type || type === "void") {
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
    const lines = [
      `  ${type} ${interfacePropertyGetterName(property.name.name)}(${runtimeParameter}) override { return ${getterValue}; }`,
    ];
    if (isMutableInterfaceProperty(property)) {
      if (implementation.kind === "field" && implementation.mutable) {
        lines.push(
          `  void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime&, ${type} __vexa_property_value) override { this->${propertyName} = __vexa_property_value; }`
        );
      } else if (implementation.kind === "accessors" && implementation.setter) {
        lines.push(
          `  void ${interfacePropertySetterName(property.name.name)}(vexa::Runtime& __vexa_runtime, ${type} __vexa_property_value) override { this->${propertyName}(__vexa_runtime, __vexa_property_value); }`
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
      return `  ${method.static ? "static " : virtual}${signature}${override} ${emitCallableReturnBoundary(body, "  ", callableResultType, Boolean(generatorInfo || asyncResultType))}`;
    }
  );
}

function emitClass(statement: ClassStatement): string {
  if (
    statement.declared ||
    statement.typeParameters?.length ||
    (statement.extendsType && !activeInterfaceNames.has(statement.extendsType.name) && !activeClassNames.has(statement.extendsType.name)) ||
    statement.implementsTypes?.some((implementedType) => !activeInterfaceNames.has(implementedType.name)) ||
    statement.classDelegates?.length ||
    statement.members.some((member) => member.kind !== "ClassMethodMember" && member.kind !== "ClassFieldMember")
  ) {
    throw new CppEmitError(
      "C++ emission currently supports non-generic classes with fields, methods, inheritance, and emitted interfaces",
      statement
    );
  }

  const className = cppName(statement.name.name);
  const baseClass = statement.extendsType
    ? activeClassStatements.get(statement.extendsType.name)
    : undefined;
  if (baseClass && ((baseClass.primaryConstructorParameters?.length ?? 0) > 0 || classUsesRuntimeConstructor(baseClass))) {
    throw new CppEmitError(
      `C++ derived class '${statement.name.name}' currently requires base class '${baseClass.name.name}' to have a default constructor`,
      statement
    );
  }
  const implementedInterfaces = implementedInterfaceTypes(statement)
    .map((implementedType) => `public ${cppName(implementedType.name)}`);
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
  ].join(", ");
  const constructor = initializers || usesRuntime || constructorParameters
    ? `${className}(${constructorParameters})${initializers ? ` : ${initializers}` : ""} {}`
    : `${className}() = default;`;
  const primaryFields = typedParameters.map(({ parameter, type, name }) => {
    const immutable = parameter.declarationKind === "val" || parameter.declarationKind === "const";
    const declaredType = parameter.typeAnnotation?.name;
    const storageType = declaredType && isNativeObjectTypeName(declaredType)
      ? `cppgc::Member<${cppName(declaredType)}>`
      : type;
    return `  ${immutable ? "const " : ""}${storageType} ${name};`;
  });
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
    .filter(({ parameter }) => Boolean(parameter.typeAnnotation && isNativeObjectTypeName(parameter.typeAnnotation.name)))
    .map(({ name }) => `visitor->Trace(${name});`);
  tracedFields.push(...typedFieldMembers.filter(({ traced }) => traced).map(({ name }) => `visitor->Trace(${name});`));
  const implementedInterfaceTraceCalls = implementedInterfaceTypes(statement)
    .map((implementedType) => `${cppName(implementedType.name)}::Trace(visitor);`);
  const baseTrace = baseClass ? [`${cppName(baseClass.name.name)}::Trace(visitor);`] : [];
  const traceStatements = [...baseTrace, ...implementedInterfaceTraceCalls, ...tracedFields];
  const traceOverrides = Boolean(baseClass || implementedInterfaceTraceCalls.length > 0);
  const traceVirtual = !traceOverrides && (Boolean(statement.abstract) || activeDerivedClassNames.has(statement.name.name));
  const traceQualifier = traceOverrides ? (statement.abstract || activeDerivedClassNames.has(statement.name.name) ? " override" : " final") : "";
  const trace = traceStatements.length > 0
    ? `  ${traceVirtual ? "virtual " : ""}void Trace(cppgc::Visitor* visitor) const${traceQualifier} { ${traceStatements.join(" ")} }`
    : `  ${traceVirtual ? "virtual " : ""}void Trace(cppgc::Visitor*) const${traceQualifier} {}`;
  const methods = statement.members.filter((member): member is ClassMethodMember => member.kind === "ClassMethodMember");
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
    baseClass ? `public ${cppName(baseClass.name.name)}` : `public cppgc::GarbageCollected<${className}>`,
    ...implementedInterfaces,
  ];
  return [
    `class ${className}${final} : ${nativeBases.join(", ")} {`,
    " public:",
    `  ${constructor}`,
    trace,
    ...fieldLines,
    ...methodLines,
    "};",
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
        const iterable = emitExpression((expression as UnaryExpression).argument);
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
      return `${indent}if (${emitCondition(branch.condition)}) ${emitBody(branch.thenBranch, indent)}${alternate}`;
    }
    case "WhileStatement": {
      const loop = statement as WhileStatement;
      return `${indent}while (${emitCondition(loop.condition)}) ${emitLoopBody(loop.body, indent)}`;
    }
    case "DoWhileStatement": {
      const loop = statement as DoWhileStatement;
      return `${indent}do ${emitLoopBody(loop.body, indent)} while (${emitCondition(loop.condition)});`;
    }
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
      if (control.label) throw new CppEmitError("C++ emission does not support labeled break yet", statement);
      const boundaryDepth = activeBreakBoundaryDepths.at(-1) ?? activeFinallyProtectedDepth;
      return activeFinallyProtectedDepth > boundaryDepth
        ? `${indent}throw vexa::BreakSignal();`
        : `${indent}break;`;
    }
    case "ContinueStatement": {
      const control = statement as ContinueStatement;
      if (control.label) throw new CppEmitError("C++ emission does not support labeled continue yet", statement);
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
  expressionTypes?: ReadonlyMap<Node, AnalysisType>;
  implicitReceiverIdentifiers?: ReadonlySet<Node>;
  staticImplicitReceiverIdentifiers?: ReadonlyMap<Node, string>;
  autoAwaitExpressions?: ReadonlySet<Node>;
  callableTypes?: ReadonlyMap<Node, AnalysisType>;
  operatorResolutions?: ReadonlyMap<Node, AnalysisSymbol>;
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
      const parent = byName.get(extendedType.name);
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
    const parent = statement.extendsType ? byName.get(statement.extendsType.name) : undefined;
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
  activeClassStatements = new Map(classes.map((statement) => [statement.name.name, statement]));
  activeClassNames = new Set(activeClassStatements.keys());
  activeDerivedClassNames = new Set(classes
    .map((statement) => statement.extendsType?.name)
    .filter((name): name is string => Boolean(name && activeClassNames.has(name))));
  activeInterfaceStatements = new Map(interfaces.map((statement) => [statement.name.name, statement]));
  activeInterfaceNames = new Set(activeInterfaceStatements.keys());
  activeEnumNames = new Set(enums.map((statement) => statement.name.name));
  activeTypeAliases = new Map(typeAliases
    .filter((statement) => !statement.typeParameters?.length)
    .map((statement) => [statement.name.name, statement.targetType.name]));
  activeFunctionStatements = new Map(functions.map((statement) => [statement.name.name, statement]));
  activeGcObjectTypes = new Map();
  activeExpressionTypes = semantics.expressionTypes ?? new Map();
  activeImplicitReceiverIdentifiers = semantics.implicitReceiverIdentifiers ?? new Set();
  activeStaticImplicitReceiverIdentifiers = semantics.staticImplicitReceiverIdentifiers ?? new Map();
  activeAutoAwaitExpressions = semantics.autoAwaitExpressions ?? new Set();
  activeCallableTypes = semantics.callableTypes ?? new Map();
  activeOperatorResolutions = semantics.operatorResolutions ?? new Map();
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

  const forwardInterfaces = interfaces.map((statement) => `class ${cppName(statement.name.name)};`);
  const forwardClasses = classes.map((statement) => `class ${cppName(statement.name.name)};`);
  const enumDefinitions = enums.map(emitEnum);
  const interfaceDefinitions = interfacesInDependencyOrder(interfaces).map(emitInterface);
  const recordInterfaceAdapters = interfacesInDependencyOrder(interfaces)
    .map(emitRecordInterfaceAdapter)
    .filter((definition): definition is string => definition !== null);
  const functionPrototypes = functions.map((statement) => `${functionSignature(statement)};`);
  const classDefinitions = classesInDependencyOrder(classes).map(emitClass);
  const functionDefinitions = functions.map(emitFunction);
  const declarationSections = [
    [...forwardInterfaces, ...forwardClasses],
    enumDefinitions,
    interfaceDefinitions,
    recordInterfaceAdapters,
    functionPrototypes,
    classDefinitions,
    functionDefinitions,
  ]
    .filter((section) => section.length > 0);
  const declarations = declarationSections.flatMap((section, index) =>
    index === declarationSections.length - 1 ? section : [...section, ""]
  );

  activeGcObjectTypes = new Map();
  activeCurrentClassName = null;
  activeCurrentMethodStatic = false;
  activeLocalNames = new Set();
  activeRuntimeName = "runtime";
  const entryStatements: string[] = [];
  for (const statement of statements) {
    if (statement.kind === "FunctionStatement" || statement.kind === "ClassStatement") continue;
    const emitted = emitStatement(statement, "  ");
    if (!emitted) continue;
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
    ...entryStatements,
    "  runtime.runEventLoop();",
    "  return 0;",
    "}",
    "",
  ].filter((line): line is string => line !== null).join("\n");
}
