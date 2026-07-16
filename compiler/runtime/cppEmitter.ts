import type {
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ExportStatement,
  ForStatement,
  FunctionStatement,
  Identifier,
  IfStatement,
  MemberExpression,
  Program,
  ReturnStatement,
  Statement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
} from "compiler/ast/ast";

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

function cppName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  const withValidStart = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return CPP_RESERVED_WORDS.has(withValidStart) ? `vexa_${withValidStart}` : withValidStart;
}

function identifierName(expression: Expr): string | null {
  return expression.kind === "Identifier" ? (expression as Identifier).name : null;
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

function emitCall(call: CallExpression): string {
  const argumentsText = call.arguments.map(emitExpression).join(", ");
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

  const calleeName = identifierName(call.callee);
  const runtimeGlobals = new Set(["String", "Number", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite"]);
  if (calleeName && runtimeGlobals.has(calleeName)) {
    return `vexa::${cppName(calleeName)}(${argumentsText})`;
  }
  return `${emitExpression(call.callee)}(${argumentsText})`;
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
      return `runtime.string(${cppString((expression as unknown as { value: string }).value)})`;
    case "NullLiteral":
      return "vexa::Value::null()";
    case "UndefinedLiteral":
      return "vexa::Value::undefined()";
    case "Identifier":
      return cppName((expression as Identifier).name);
    case "BinaryExpression":
      return emitBinary(expression as BinaryExpression);
    case "UnaryExpression": {
      const unary = expression as UnaryExpression;
      if (unary.operator === "typeof") return `vexa::typeOf(${emitExpression(unary.argument)})`;
      if (unary.operator === "void") return `(static_cast<void>(${emitExpression(unary.argument)}), vexa::Value::undefined())`;
      if (unary.operator === "delete" || unary.operator === "await" || unary.operator.startsWith("yield") || unary.operator === "go") {
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
      return emitCall(expression as CallExpression);
    case "MemberExpression": {
      const member = expression as MemberExpression;
      if (!member.computed && identifierName(member.object) === "Math" && member.property.kind === "Identifier") {
        return `vexa::Math::${cppName((member.property as Identifier).name)}`;
      }
      return member.computed
        ? `${emitExpression(member.object)}[${emitExpression(member.property)}]`
        : `${emitExpression(member.object)}.${emitExpression(member.property)}`;
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
  const name = cppName((statement.name as Identifier).name);
  if (!statement.initializer) return `vexa::Value ${name}`;
  const type = forInitializer ? "double" : "auto";
  return `${type} ${name} = ${emitExpression(statement.initializer)}`;
}

function emitBlock(block: BlockStatement, indent: string): string {
  const childIndent = `${indent}  `;
  const body = block.body.map((statement) => emitStatement(statement, childIndent)).join("\n");
  return body ? `{\n${body}\n${indent}}` : "{}";
}

function emitBody(statement: Statement, indent: string): string {
  return statement.kind === "BlockStatement"
    ? emitBlock(statement as BlockStatement, indent)
    : `{\n${emitStatement(statement, `${indent}  `)}\n${indent}}`;
}

function emitFor(statement: ForStatement, indent: string): string {
  if (statement.iterationKind || statement.iterator || statement.iterable) {
    throw new CppEmitError("C++ range loops must be lowered before emission", statement);
  }
  const initializer = statement.initializer
    ? statement.initializer.kind === "VarStatement"
      ? emitVariable(statement.initializer as VarStatement, true)
      : emitExpression(statement.initializer as Expr)
    : "";
  const condition = statement.condition ? emitExpression(statement.condition) : "";
  const compactCondition = condition.startsWith("(") && condition.endsWith(")") ? condition.slice(1, -1) : condition;
  return `${indent}for (${initializer}; ${compactCondition}; ${statement.update ? emitExpression(statement.update) : ""}) ${emitBody(statement.body, indent)}`;
}

function emitFunction(statement: FunctionStatement): string {
  if (statement.async || statement.generator || statement.receiverType) {
    throw new CppEmitError(`C++ emission does not support async, generator, or extension functions yet`, statement);
  }
  const parameters = statement.parameters.map((parameter) => {
    if (parameter.name.kind !== "Identifier") {
      throw new CppEmitError("C++ emission currently supports identifier function parameters only", statement);
    }
    return `double ${cppName((parameter.name as Identifier).name)}`;
  }).join(", ");
  return `auto ${cppName(statement.name.name)}(${parameters}) ${emitBlock(statement.body, "")}`;
}

function emitStatement(statement: Statement, indent = ""): string {
  switch (statement.kind) {
    case "BlockStatement":
      return `${indent}${emitBlock(statement as BlockStatement, indent)}`;
    case "ExprStatement":
      return `${indent}${emitExpression((statement as ExprStatement).expression)};`;
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
      return `${indent}return${returned ? ` ${emitExpression(returned)}` : ""};`;
    }
    case "BreakStatement":
      return `${indent}break${(statement as BreakStatement).label ? ` /* ${(statement as BreakStatement).label!.name} */` : ""};`;
    case "ContinueStatement":
      return `${indent}continue${(statement as ContinueStatement).label ? ` /* ${(statement as ContinueStatement).label!.name} */` : ""};`;
    case "FunctionStatement":
      return `${indent}${emitFunction(statement as FunctionStatement)}`;
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

export function emitCppProgram(program: Program): string {
  const declarations: string[] = [];
  const entryStatements: string[] = [];
  for (const statement of program.body) {
    const emitted = emitStatement(statement, "  ");
    if (!emitted) continue;
    if (statement.kind === "FunctionStatement") {
      declarations.push(emitted.trimStart());
    } else {
      entryStatements.push(emitted);
    }
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
    "  return 0;",
    "}",
    "",
  ].filter((line): line is string => line !== null).join("\n");
}
