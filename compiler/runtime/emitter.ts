import type {
  ArrayLiteral,
  AssignmentExpression,
  BigIntLiteral,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassPrimaryConstructorParameter,
  ClassStatement,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FloatLiteral,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IfStatement,
  ImportStatement,
  IntLiteral,
  LongLiteral,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  StringLiteral,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";

type Assoc = "left" | "right";

const PREC_ASSIGNMENT = 1;
const PREC_CONDITIONAL = 2;
const PREC_LOGICAL_OR = 3;
const PREC_LOGICAL_AND = 4;
const PREC_BITWISE_OR = 5;
const PREC_BITWISE_XOR = 6;
const PREC_BITWISE_AND = 7;
const PREC_EQUALITY = 8;
const PREC_RELATIONAL = 9;
const PREC_SHIFT = 10;
const PREC_ADDITIVE = 11;
const PREC_MULTIPLICATIVE = 12;
const PREC_EXPONENT = 13;
const PREC_UNARY = 14;
const PREC_UPDATE = 15;
const PREC_MEMBER = 16;
const PREC_PRIMARY = 17;
let activeExpressionTypes: ReadonlyMap<Node, AnalysisType> | undefined;

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
    case "AssignmentExpression":
      return PREC_ASSIGNMENT;
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
    default:
      return PREC_PRIMARY;
  }
}

function maybeWrap(text: string, shouldWrap: boolean): string {
  return shouldWrap ? `(${text})` : text;
}

function emitIdentifier(identifier: Identifier): string {
  return identifier.name;
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
      case "Identifier":
        return emitIdentifier(expression as Identifier);
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
        const binaryText = `${leftText} ${binary.operator} ${rightText}`;
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
        if (member.computed) {
          return `${objectText}[${emitExpression(member.property)}]`;
        }
        const access = member.optional ? "?." : member.nonNullAsserted ? "!." : ".";
        return `${objectText}${access}${emitExpression(member.property, PREC_MEMBER, "right")}`;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const calleeText = emitExpression(call.callee, PREC_MEMBER, "left");
        return `${calleeText}(${call.arguments.map((argument) => emitExpression(argument)).join(", ")})`;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        const calleeText = emitExpression(newExpression.callee, PREC_MEMBER, "left");
        if (newExpression.arguments) {
          return `new ${calleeText}(${newExpression.arguments.map((argument) => emitExpression(argument)).join(", ")})`;
        }
        return `new ${calleeText}`;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        const unaryOperator =
          unary.operator === "typeof" ||
          unary.operator === "void" ||
          unary.operator === "delete" ||
          unary.operator === "await"
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
      case "ArrayLiteral":
        return `[${(expression as ArrayLiteral).elements.map((element) => emitExpression(element)).join(", ")}]`;
      case "ObjectLiteral": {
        const objectLiteral = expression as ObjectLiteral;
        return `{${objectLiteral.properties
          .map((property) => `${property.key.name}: ${emitExpression(property.value)}`)
          .join(", ")}}`;
      }
      default:
        return "undefined";
    }
  };

  const self = emitSelf();

  if (currentPrecedence < parentPrecedence) {
    return `(${self})`;
  }

  if (currentPrecedence === parentPrecedence && expression.kind === "AssignmentExpression" && side === "left") {
    return `(${self})`;
  }

  return self;
}

function emitFunctionParameters(parameters: FunctionParameter[]): string {
  return parameters
    .map((parameter) => {
      if (parameter.defaultValue) {
        return `${parameter.name.name} = ${emitExpression(parameter.defaultValue)}`;
      }
      return parameter.name.name;
    })
    .join(", ");
}

function emitVarDeclarator(declarator: VarDeclarator): string {
  if (declarator.initializer) {
    return `${declarator.name.name} = ${emitExpression(declarator.initializer)}`;
  }
  return declarator.name.name;
}

function emitVarStatementBody(statement: VarStatement): string {
  if (statement.declarations && statement.declarations.length > 0) {
    return statement.declarations.map((declaration) => emitVarDeclarator(declaration)).join(", ");
  }
  if (statement.initializer) {
    return `${statement.name.name} = ${emitExpression(statement.initializer)}`;
  }
  return statement.name.name;
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
    assignments.push(`this.${parameter.name.name} = ${parameter.name.name};`);
  }

  return `constructor(${params}) {${assignments.length > 0 ? ` ${assignments.join(" ")}` : ""} }`;
}

function emitClassMember(member: ClassFieldMember | ClassMethodMember): string {
  if (member.kind === "ClassFieldMember") {
    const field = member as ClassFieldMember;
    if (field.initializer) {
      return `${field.name.name} = ${emitExpression(field.initializer)};`;
    }
    return `${field.name.name};`;
  }

  const method = member as ClassMethodMember;
  return `${method.name.name}(${emitFunctionParameters(method.parameters)}) ${emitBlock(method.body)}`;
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

export function emitStatement(statement: Statement): string {
  switch (statement.kind) {
    case "ImportStatement": {
      const importStatement = statement as ImportStatement;
      const names = importStatement.specifiers
        .map((specifier) => specifier.imported.name)
        .join(", ");
      return `import { ${names} } from ${JSON.stringify(importStatement.from.value)};`;
    }
    case "VarStatement":
      return emitVarStatement(statement as VarStatement);
    case "FunctionStatement": {
      const fn = statement as FunctionStatement;
      if (fn.declared) {
        return "";
      }
      return `function ${fn.name.name}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`;
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
      return `class ${classStatement.name.name} {${memberLines.length > 0 ? `\n${memberLines.join("\n")}\n` : ""}}`;
    }
    case "ExprStatement":
      return `${emitExpression((statement as ExprStatement).expression)};`;
    case "BlockStatement":
      return emitBlock(statement as BlockStatement);
    case "WhileStatement": {
      const whileStatement = statement as WhileStatement;
      return `while (${emitExpression(whileStatement.condition)}) ${emitStatement(whileStatement.body)}`;
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
    case "ContinueStatement":
      return "continue;";
    case "BreakStatement":
      return "break;";
    default:
      return "";
  }
}

export function emitProgram(
  program: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>
): string {
  const previous = activeExpressionTypes;
  activeExpressionTypes = expressionTypes;
  try {
    return program.body
      .map((statement) => emitStatement(statement))
      .filter((statement) => statement.trim().length > 0)
      .join("\n");
  } finally {
    activeExpressionTypes = previous;
  }
}
