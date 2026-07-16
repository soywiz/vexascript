import type {
  ArrayLiteral,
  ArrowFunctionExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ClassMethodMember,
  ClassPrimaryConstructorParameter,
  ClassStatement,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ExportStatement,
  ForStatement,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  IfStatement,
  MemberExpression,
  NamedArgument,
  Node,
  Program,
  ReturnStatement,
  Statement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
} from "compiler/ast/ast";
import type { AnalysisType, BuiltinTypeName } from "compiler/analysis/types";

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
let activeGcObjectTypes: Map<string, string> = new Map();
let activeExpressionTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeFunctionStatements: ReadonlyMap<string, FunctionStatement> = new Map();
let activeClassStatements: ReadonlyMap<string, ClassStatement> = new Map();
let activeCurrentClassName: string | null = null;
let activeCurrentMethodStatic = false;
let activeLocalNames: Set<string> = new Set();
let activeRuntimeName = "runtime";
let activeThisExpression = "this";
let activeImplicitReceiverIdentifiers: ReadonlySet<Node> = new Set();
let activeStaticImplicitReceiverIdentifiers: ReadonlyMap<Node, string> = new Map();
let activeAutoAwaitExpressions: ReadonlySet<Node> = new Set();
let activeCallableTypes: ReadonlyMap<Node, AnalysisType> = new Map();
let activeSuppressAutoAwait = false;
let activeAsyncResultType: string | null = null;
let activeGeneratorResultType: string | null = null;
let activeYieldTemporaryCounter = 0;

function cppName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const withValidStart = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return CPP_RESERVED_WORDS.has(withValidStart) ? `vexa_${withValidStart}` : withValidStart;
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
    ? `${emitted}.get()`
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
  if (type.kind === "tuple") {
    const elementTypes = new Set(type.elements.map(cppArrayElementType));
    const elementType = elementTypes.size === 1 ? [...elementTypes][0] : null;
    return elementType ? `std::vector<${elementType}>` : null;
  }
  if (type.kind === "named" && activeClassNames.has(type.name)) {
    return `${cppName(type.name)}*`;
  }
  return null;
}

function cppTypeForDeclaredName(typeName: string): string | null {
  const builtin = cppTypeForBuiltin(typeName as BuiltinTypeName);
  if (builtin) return builtin;
  return activeClassNames.has(typeName) ? `${cppName(typeName)}*` : null;
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
  return type?.kind === "array" || type?.kind === "tuple" || expression.kind === "ArrayLiteral";
}

function isGeneratorExpression(expression: Expr): boolean {
  const type = activeExpressionTypes.get(expression as Node);
  if (type?.kind === "named" && (type.name === "Generator" || type.name === "AsyncGenerator")) return true;
  if (expression.kind !== "CallExpression") return false;
  const call = expression as CallExpression;
  const functionName = identifierName(call.callee);
  if (functionName && activeFunctionStatements.get(functionName)?.generator) return true;
  const member = memberParts(call.callee);
  return Boolean(member && classMethodForMember(member)?.generator);
}

function emitConvertedValue(expression: Expr, resultType: string): string {
  return `vexa::convertValue<${resultType}>(${activeRuntimeName}, ${emitExpression(expression)})`;
}

function emitArrayLiteral(array: ArrayLiteral): string {
  if (array.elements.some((element) => element.kind === "ArrayHole")) {
    throw new CppEmitError("C++ emission does not support array holes yet");
  }
  const type = cppTypeForExpression(array as unknown as Expr);
  if (!type.startsWith("std::vector<")) {
    throw new CppEmitError("C++ emission requires arrays with one supported element type");
  }
  const emitElement = (element: Expr): string => {
    const emitted = emitExpression(element);
    return type === "std::vector<std::string>" ? `vexa::toString(${emitted})` : emitted;
  };
  const elements = type === "std::vector<vexa::Value>"
    ? array.elements.map((element) => emitConvertedValue(element as Expr, "vexa::Value"))
    : array.elements.map((element) => emitElement(element as Expr));
  return `${type}{${elements.join(", ")}}`;
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

function emitCallArguments(call: CallExpression, parameters?: readonly CallableParameter[]): string {
  if (!parameters) {
    return call.arguments.map(emitExpression).join(", ");
  }

  const ordered: Array<Expr | undefined> = new Array(parameters.length);
  let positionalIndex = 0;
  for (const argument of call.arguments) {
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
  return ordered.map((argument) => emitExpression(argument!)).join(", ");
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
    if (activeClassNames.has(name)) return null;
  }
  if (expression.kind === "CallExpression") {
    const calleeName = identifierName((expression as CallExpression).callee);
    if (calleeName && activeClassNames.has(calleeName)) return calleeName;
  }
  const type = activeExpressionTypes.get(expression as Node);
  return type?.kind === "named" && activeClassNames.has(type.name) ? type.name : null;
}

function staticClassNameForExpression(expression: Expr): string | null {
  if (expression.kind !== "Identifier") return null;
  const name = (expression as Identifier).name;
  return activeClassNames.has(name) && !activeLocalNames.has(name) ? name : null;
}

function classMethodForMember(member: { object: Expr; propertyName: string }): ClassMethodMember | null {
  const className = staticClassNameForExpression(member.object) ?? classNameForExpression(member.object);
  const statement = className ? activeClassStatements.get(className) : undefined;
  return (statement?.members.find((candidate): candidate is ClassMethodMember =>
    candidate.kind === "ClassMethodMember" && candidate.name.name === member.propertyName) ?? null);
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

function emitArrowFunction(expression: ArrowFunctionExpression): string {
  if (expression.async || expression.sync || expression.parameters.length > 0) {
    throw new CppEmitError("C++ emission currently supports synchronous zero-argument callbacks only");
  }
  const capture = nativeLambdaCapture("__vexa_callback_self", true);
  const previousThisExpression = activeThisExpression;
  activeThisExpression = capture.thisExpression;
  try {
    const prefix = `${capture.text}()${activeRuntimeName === "runtime" ? "" : " mutable"}`;
    return expression.body.kind === "BlockStatement"
      ? `${prefix} ${emitBlock(expression.body as BlockStatement, "")}`
      : `${prefix} { return ${emitExpression(expression.body as Expr)}; }`;
  } finally {
    activeThisExpression = previousThisExpression;
  }
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
  const arrayRuntimeMethods = new Set(["push", "includes", "indexOf", "join", "reverse"]);
  if (member && isArrayExpression(member.object) && arrayRuntimeMethods.has(member.propertyName)) {
    const receiver = emitExpression(member.object);
    const arrayArguments = cppTypeForExpression(member.object) === "std::vector<vexa::Value>"
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
      if (method.static) {
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
    const classStatement = activeClassStatements.get(calleeName);
    const constructorArguments = emitCallArguments(call, classStatement?.primaryConstructorParameters);
    return `${activeRuntimeName}.make<${cppName(calleeName)}>(${constructorArguments})`;
  }
  return `${emitExpression(call.callee)}(${argumentsText})`;
}

function isGcObjectExpression(expression: Expr): boolean {
  return classNameForExpression(expression) !== null;
}

function emitBinary(expression: BinaryExpression): string {
  if (expression.operator === "**") {
    return `vexa::Math::pow(${emitExpression(expression.left)}, ${emitExpression(expression.right)})`;
  }
  const operator = expression.operator === "==="
    ? "=="
    : expression.operator === "!=="
      ? "!="
      : expression.operator;
  if (operator === "in" || operator === "is" || operator === "instanceof" || operator === "<=>" || operator === "??") {
    throw new CppEmitError(`C++ emission does not support the '${operator}' operator yet`);
  }
  return `(${emitExpression(expression.left)} ${operator} ${emitExpression(expression.right)})`;
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
    case "ArrayLiteral":
      return emitArrayLiteral(expression as unknown as ArrayLiteral);
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
      if (unary.operator === "typeof") return `vexa::typeOf(${emitExpression(unary.argument)})`;
      if (unary.operator === "void") return `(static_cast<void>(${emitExpression(unary.argument)}), vexa::Value::undefined())`;
      if (unary.operator === "await") return `(${emitWithoutAutoAwait(unary.argument)}).get()`;
      if (unary.operator === "go") return emitWithoutAutoAwait(unary.argument);
      if (unary.operator === "yield") {
        if (!activeGeneratorResultType) throw new CppEmitError("C++ yield emission requires a generator callable");
        return `co_yield ${emitExpression(unary.argument)}`;
      }
      if (unary.operator === "delete" || unary.operator === "yield*") {
        throw new CppEmitError(`C++ emission does not support unary '${unary.operator}' yet`);
      }
      return `(${unary.operator}${emitExpression(unary.argument)})`;
    }
    case "UpdateExpression": {
      const update = expression as UpdateExpression;
      const text = `${emitExpression(update.argument)}${update.operator}`;
      return update.prefix ? `${update.operator}${emitExpression(update.argument)}` : text;
    }
    case "AssignmentExpression": {
      const assignment = expression as AssignmentExpression;
      return `(${emitExpression(assignment.left)} ${assignment.operator} ${emitExpression(assignment.right)})`;
    }
    case "ConditionalExpression": {
      const conditional = expression as ConditionalExpression;
      return `(${emitExpression(conditional.test)} ? ${emitExpression(conditional.consequent)} : ${emitExpression(conditional.alternate)})`;
    }
    case "CallExpression":
      return maybeAutoAwait(expression, emitCall(expression as CallExpression));
    case "ArrowFunctionExpression":
      return emitArrowFunction(expression as ArrowFunctionExpression);
    case "MemberExpression": {
      const member = expression as MemberExpression;
      if (!member.computed && identifierName(member.object) === "Math" && member.property.kind === "Identifier") {
        return `vexa::Math::${cppName((member.property as Identifier).name)}`;
      }
      if (!member.computed && isArrayExpression(member.object) && identifierName(member.property) === "length") {
        return `static_cast<double>(${emitExpression(member.object)}.size())`;
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

function emitVariable(statement: VarStatement, forInitializer = false): string {
  if (statement.name.kind !== "Identifier") {
    throw new CppEmitError("C++ emission currently supports identifier variable bindings only", statement);
  }
  const sourceName = (statement.name as Identifier).name;
  const name = cppName(sourceName);
  if (!statement.initializer) {
    activeLocalNames.add(sourceName);
    return `vexa::Value ${name}`;
  }
  const type = forInitializer ? cppTypeForExpression(statement.initializer) : "auto";
  const initializer = emitExpression(statement.initializer);
  const className = classNameForExpression(statement.initializer);
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

function emitFor(statement: ForStatement, indent: string): string {
  const previousLocalNames = new Set(activeLocalNames);
  const previousGcObjectTypes = new Map(activeGcObjectTypes);
  try {
    if (statement.iterationKind || statement.iterator || statement.iterable) {
      if (statement.iterationKind !== "of" || !statement.iterator || !statement.iterable) {
        throw new CppEmitError("C++ emission supports for-of loops only", statement);
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
      return `${indent}for (auto ${cppName(iteratorName)} : ${iterable}) ${emitBody(statement.body, indent)}`;
    }
    const initializer = statement.initializer
      ? statement.initializer.kind === "VarStatement"
        ? emitVariable(statement.initializer as VarStatement, true)
        : emitExpression(statement.initializer as Expr)
      : "";
    const condition = statement.condition ? emitExpression(statement.condition) : "";
    const compactCondition = condition.startsWith("(") && condition.endsWith(")") ? condition.slice(1, -1) : condition;
    return `${indent}for (${initializer}; ${compactCondition}; ${statement.update ? emitExpression(statement.update) : ""}) ${emitBody(statement.body, indent)}`;
  } finally {
    activeLocalNames = previousLocalNames;
    activeGcObjectTypes = previousGcObjectTypes;
  }
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

function callableParameters(parameters: readonly FunctionParameter[], owner: Statement): {
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
    if (parameter.defaultValue && !isSupportedDefaultExpression(parameter.defaultValue)) {
      throw new CppEmitError("C++ emission currently supports literal parameter defaults only", owner);
    }
    const sourceName = (parameter.name as Identifier).name;
    const typeName = parameter.typeAnnotation?.name;
    const type = typeName ? cppTypeForDeclaredName(typeName) : null;
    if (!type || type === "void") {
      throw new CppEmitError("C++ emission requires supported type annotations on function and method parameters", owner);
    }
    names.push(sourceName);
    if (typeName && activeClassNames.has(typeName)) gcTypes.set(sourceName, typeName);
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
  generatorInfo: CallableGeneratorInfo | null
): string {
  const resultType = generatorInfo?.resultType ?? callableReturnType(returnType, body, owner, name, taskResult);
  const parameterText = callableParameters(parameters, owner).text;
  const emittedResultType = generatorInfo
    ? `vexa::${generatorInfo.async ? "AsyncGenerator" : "Generator"}<${resultType}>`
    : taskResult
      ? `vexa::Task<${resultType}>`
      : resultType;
  return `${emittedResultType} ${cppName(name.name)}(vexa::Runtime& __vexa_runtime${parameterText ? `, ${parameterText}` : ""})`;
}

function withCallableContext<T>(
  parameters: readonly FunctionParameter[],
  className: string | null,
  staticMethod: boolean,
  asyncResultType: string | null,
  generatorResultType: string | null,
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
  const parameterInfo = callableParameters(parameters, owner);
  activeRuntimeName = "__vexa_runtime";
  activeThisExpression = "this";
  activeCurrentClassName = className;
  activeCurrentMethodStatic = staticMethod;
  activeLocalNames = new Set(parameterInfo.names);
  activeGcObjectTypes = new Map(parameterInfo.gcTypes);
  activeAsyncResultType = asyncResultType;
  activeGeneratorResultType = generatorResultType;
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
  }
}

function emitScheduledCallableBlock(body: BlockStatement, indent: string, resultType: string): string {
  const capture = nativeLambdaCapture("__vexa_self", false);
  const previousThisExpression = activeThisExpression;
  activeThisExpression = capture.thisExpression;
  try {
    const work = emitBlock(body, `${indent}    `);
    return [
      "{",
      `${indent}  return vexa::Task<${resultType}>::schedule(`,
      `${indent}    ${activeRuntimeName},`,
      `${indent}    ${capture.text}() mutable -> ${resultType} ${work}`,
      `${indent}  );`,
      `${indent}}`,
    ].join("\n");
  } finally {
    activeThisExpression = previousThisExpression;
  }
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
  const generatorInfo = callableGeneratorInfo(
    statement.name,
    statement.returnType,
    Boolean(statement.generator),
    Boolean(statement.async || statement.sync),
    statement
  );
  const asyncResultType = !generatorInfo && (statement.async || statement.sync)
    ? callableReturnType(statement.returnType, statement.body, statement, statement.name, true)
    : null;
  return withCallableContext(statement.parameters, null, false, asyncResultType, generatorInfo?.resultType ?? null, statement, () =>
    `${signature} ${generatorInfo
      ? emitGeneratorCallableBlock(statement.body, "", generatorInfo.resultType)
      : asyncResultType
        ? emitScheduledCallableBlock(statement.body, "", asyncResultType)
        : emitBlock(statement.body, "")}`
  );
}

function primaryConstructorParameterType(parameter: ClassPrimaryConstructorParameter, statement: ClassStatement): string {
  const typeName = parameter.typeAnnotation?.name;
  const mapped = typeName ? cppTypeForBuiltin(typeName as BuiltinTypeName) : null;
  if (mapped && mapped !== "void") return mapped;
  throw new CppEmitError(
    `C++ emission currently requires primitive type annotations on class primary constructor properties`,
    statement
  );
}

function validateClassMethod(method: ClassMethodMember, statement: ClassStatement): void {
  if (
    method.abstract ||
    method.accessorKind ||
    method.getterShorthand ||
    method.computed ||
    method.operator ||
    method.optional ||
    method.missingBody ||
    method.typeParameters?.length
  ) {
    throw new CppEmitError(
      "C++ emission supports concrete, non-generic methods only",
      statement
    );
  }
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
  const asyncResultType = !generatorInfo && (method.async || method.sync)
    ? callableReturnType(method.returnType, method.body, statement, method.name, true)
    : null;
  const signature = callableSignature(
    method.name,
    method.parameters,
    method.returnType,
    method.body,
    statement,
    generatorInfo ? false : callableProducesTask(method.name, method.returnType, asyncResultType !== null),
    generatorInfo
  );
  return withCallableContext(method.parameters, statement.name.name, Boolean(method.static), asyncResultType, generatorInfo?.resultType ?? null, statement, () =>
    `  ${method.static ? "static " : ""}${signature} ${generatorInfo
      ? emitGeneratorCallableBlock(method.body, "  ", generatorInfo.resultType)
      : asyncResultType
        ? emitScheduledCallableBlock(method.body, "  ", asyncResultType)
        : emitBlock(method.body, "  ")}`
  );
}

function emitClass(statement: ClassStatement): string {
  if (
    statement.declared ||
    statement.abstract ||
    statement.typeParameters?.length ||
    statement.extendsType ||
    statement.implementsTypes?.length ||
    statement.classDelegates?.length ||
    statement.members.some((member) => member.kind !== "ClassMethodMember")
  ) {
    throw new CppEmitError(
      "C++ emission currently supports concrete primary-constructor classes with instance methods only",
      statement
    );
  }

  const className = cppName(statement.name.name);
  const parameters = statement.primaryConstructorParameters ?? [];
  if (parameters.some((parameter) => parameter.defaultValue && !isSupportedDefaultExpression(parameter.defaultValue))) {
    throw new CppEmitError("C++ emission currently supports literal class constructor defaults only", statement);
  }
  const typedParameters = parameters.map((parameter) => ({
    parameter,
    name: cppName(parameter.name.name),
    type: primaryConstructorParameterType(parameter, statement),
  }));
  const constructorParameters = typedParameters.map(({ type, name }) => `${type} ${name}`).join(", ");
  const initializers = typedParameters.map(({ name }) => `${name}(${name})`).join(", ");
  const constructor = initializers
    ? `${className}(${constructorParameters}) : ${initializers} {}`
    : `${className}() = default;`;
  const fields = typedParameters.map(({ parameter, type, name }) => {
    const immutable = parameter.declarationKind === "val" || parameter.declarationKind === "const";
    return `  ${immutable ? "const " : ""}${type} ${name};`;
  });
  const methods = statement.members as ClassMethodMember[];
  const methodLines: string[] = [];
  let activeAccess: "public" | "private" | "protected" = "public";
  for (const method of methods) {
    const access = method.accessModifier ?? "public";
    if (access !== activeAccess) {
      methodLines.push(` ${access}:`);
      activeAccess = access;
    }
    methodLines.push(emitClassMethod(method, statement));
  }

  return [
    `class ${className} final : public cppgc::GarbageCollected<${className}> {`,
    " public:",
    `  ${constructor}`,
    "  void Trace(cppgc::Visitor*) const {}",
    ...fields,
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
    case "IfStatement": {
      const branch = statement as IfStatement;
      const alternate = branch.elseBranch ? ` else ${emitBody(branch.elseBranch, indent)}` : "";
      return `${indent}if (${emitExpression(branch.condition)}) ${emitBody(branch.thenBranch, indent)}${alternate}`;
    }
    case "WhileStatement": {
      const loop = statement as WhileStatement;
      return `${indent}while (${emitExpression(loop.condition)}) ${emitBody(loop.body, indent)}`;
    }
    case "DoWhileStatement": {
      const loop = statement as DoWhileStatement;
      return `${indent}do ${emitBody(loop.body, indent)} while (${emitExpression(loop.condition)});`;
    }
    case "ReturnStatement": {
      const returned = (statement as ReturnStatement).expression;
      if (activeGeneratorResultType) {
        return `${indent}co_return ${returned
          ? emitExpression(returned)
          : `vexa::defaultValue<${activeGeneratorResultType}>()`};`;
      }
      if (activeAsyncResultType) {
        if (!returned) return `${indent}return;`;
        const emitted = emitExpression(returned);
        const returnedType = activeExpressionTypes.get(returned as Node);
        const flattened = returnedType?.kind === "named" && returnedType.name === "Promise"
          ? `(${emitted}).get()`
          : emitted;
        return `${indent}return ${flattened};`;
      }
      return `${indent}return${returned ? ` ${emitExpression(returned)}` : ""};`;
    }
    case "BreakStatement":
      return `${indent}break${(statement as BreakStatement).label ? ` /* ${(statement as BreakStatement).label!.name} */` : ""};`;
    case "ContinueStatement":
      return `${indent}continue${(statement as ContinueStatement).label ? ` /* ${(statement as ContinueStatement).label!.name} */` : ""};`;
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
    case "TypeAliasStatement":
    case "InterfaceStatement":
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
}

export function emitCppProgram(program: Program, semantics: CppEmitSemantics = {}): string {
  const statements = program.body.map((statement) =>
    statement.kind === "ExportStatement" && (statement as ExportStatement).declaration
      ? (statement as ExportStatement).declaration!
      : statement
  );
  const classes = statements.filter((statement): statement is ClassStatement => statement.kind === "ClassStatement");
  const functions = statements.filter((statement): statement is FunctionStatement => statement.kind === "FunctionStatement");
  activeClassStatements = new Map(classes.map((statement) => [statement.name.name, statement]));
  activeClassNames = new Set(activeClassStatements.keys());
  activeFunctionStatements = new Map(functions.map((statement) => [statement.name.name, statement]));
  activeGcObjectTypes = new Map();
  activeExpressionTypes = semantics.expressionTypes ?? new Map();
  activeImplicitReceiverIdentifiers = semantics.implicitReceiverIdentifiers ?? new Set();
  activeStaticImplicitReceiverIdentifiers = semantics.staticImplicitReceiverIdentifiers ?? new Map();
  activeAutoAwaitExpressions = semantics.autoAwaitExpressions ?? new Set();
  activeCallableTypes = semantics.callableTypes ?? new Map();
  activeSuppressAutoAwait = false;
  activeAsyncResultType = null;
  activeGeneratorResultType = null;
  activeYieldTemporaryCounter = 0;
  activeCurrentClassName = null;
  activeCurrentMethodStatic = false;
  activeLocalNames = new Set();
  activeRuntimeName = "runtime";

  const forwardClasses = classes.map((statement) => `class ${cppName(statement.name.name)};`);
  const functionPrototypes = functions.map((statement) => `${functionSignature(statement)};`);
  const classDefinitions = classes.map(emitClass);
  const functionDefinitions = functions.map(emitFunction);
  const declarationSections = [forwardClasses, functionPrototypes, classDefinitions, functionDefinitions]
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
