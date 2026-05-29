import {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  ClassFieldMember,
  ClassMember,
  ClassMethodMember,
  ClassStatement,
  ContinueStatement,
  DoWhileStatement,
  Expr,
  ExprStatement,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IntLiteral,
  MemberExpression,
  ObjectLiteral,
  Program,
  ReturnStatement,
  Statement,
  StringLiteral,
  UnaryExpression,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";

const INDENT = "  ";

type KnownExpr =
  | IntLiteral
  | StringLiteral
  | Identifier
  | ArrayLiteral
  | ObjectLiteral
  | UnaryExpression
  | BinaryExpression
  | AssignmentExpression
  | MemberExpression;

type KnownStatement =
  | VarStatement
  | FunctionStatement
  | ClassStatement
  | ExprStatement
  | BlockStatement
  | WhileStatement
  | DoWhileStatement
  | ReturnStatement
  | ContinueStatement
  | BreakStatement;

const BINARY_PRECEDENCE: Record<BinaryExpression["operator"], number> = {
  "**": 13,
  "*": 12,
  "/": 12,
  "%": 12,
  "+": 11,
  "-": 11,
  "<": 10,
  ">": 10,
  "<=": 10,
  ">=": 10,
  "===": 9,
  "!==": 9,
  "&": 8,
  "^": 7,
  "|": 6,
  "&&": 5,
  "||": 4
};

const ASSIGNMENT_PRECEDENCE = 1;
const UNARY_PRECEDENCE = 14;
const MEMBER_PRECEDENCE = 15;
const PRIMARY_PRECEDENCE = 16;

function indent(level: number): string {
  return INDENT.repeat(level);
}

function formatIdentifier(identifier: Identifier): string {
  return identifier.name;
}

function exprPrecedence(expr: Expr): number {
  const node = expr as KnownExpr;
  if (node.kind === "AssignmentExpression") {
    return ASSIGNMENT_PRECEDENCE;
  }
  if (node.kind === "BinaryExpression") {
    return BINARY_PRECEDENCE[node.operator];
  }
  if (node.kind === "UnaryExpression") {
    return UNARY_PRECEDENCE;
  }
  if (node.kind === "MemberExpression") {
    return MEMBER_PRECEDENCE;
  }
  return PRIMARY_PRECEDENCE;
}

function shouldParenthesizeChild(
  child: Expr,
  parentPrecedence: number,
  side: "left" | "right",
  associativity: "left" | "right"
): boolean {
  const childPrecedence = exprPrecedence(child);
  if (childPrecedence < parentPrecedence) {
    return true;
  }
  if (childPrecedence > parentPrecedence) {
    return false;
  }

  if (side === "left") {
    return associativity === "right";
  }
  return associativity === "left";
}

function withOptionalParens(value: string, shouldWrap: boolean): string {
  return shouldWrap ? `(${value})` : value;
}

function formatAssignmentExpression(expr: AssignmentExpression): string {
  const left = withOptionalParens(
    formatExpression(expr.left),
    shouldParenthesizeChild(expr.left, ASSIGNMENT_PRECEDENCE, "left", "right")
  );
  const right = withOptionalParens(
    formatExpression(expr.right),
    shouldParenthesizeChild(expr.right, ASSIGNMENT_PRECEDENCE, "right", "right")
  );
  return `${left} ${expr.operator} ${right}`;
}

function formatBinaryExpression(expr: BinaryExpression): string {
  const precedence = BINARY_PRECEDENCE[expr.operator];
  const associativity: "left" | "right" = expr.operator === "**" ? "right" : "left";

  const left = withOptionalParens(
    formatExpression(expr.left),
    shouldParenthesizeChild(expr.left, precedence, "left", associativity)
  );
  const right = withOptionalParens(
    formatExpression(expr.right),
    shouldParenthesizeChild(expr.right, precedence, "right", associativity)
  );

  return `${left} ${expr.operator} ${right}`;
}

function formatExpression(expr: Expr): string {
  const node = expr as KnownExpr;

  if (node.kind === "IntLiteral") {
    return String(node.value);
  }
  if (node.kind === "StringLiteral") {
    return JSON.stringify(node.value);
  }
  if (node.kind === "Identifier") {
    return formatIdentifier(node);
  }
  if (node.kind === "ArrayLiteral") {
    return `[${node.elements.map((element) => formatExpression(element)).join(", ")}]`;
  }
  if (node.kind === "ObjectLiteral") {
    const properties = node.properties.map(
      (property) => `${formatIdentifier(property.key)}: ${formatExpression(property.value)}`
    );
    return `{${properties.length > 0 ? ` ${properties.join(", ")} ` : ""}}`;
  }
  if (node.kind === "UnaryExpression") {
    const argument = withOptionalParens(
      formatExpression(node.argument),
      exprPrecedence(node.argument) < UNARY_PRECEDENCE
    );
    return `${node.operator}${argument}`;
  }
  if (node.kind === "BinaryExpression") {
    return formatBinaryExpression(node);
  }
  if (node.kind === "AssignmentExpression") {
    return formatAssignmentExpression(node);
  }
  if (node.kind === "MemberExpression") {
    const object = withOptionalParens(
      formatExpression(node.object),
      exprPrecedence(node.object) < MEMBER_PRECEDENCE
    );

    if (node.computed) {
      return `${object}[${formatExpression(node.property)}]`;
    }

    const accessor = node.optional ? "?." : node.nonNullAsserted ? "!." : ".";
    return `${object}${accessor}${formatExpression(node.property)}`;
  }

  throw new Error("Unsupported expression kind");
}

function formatParameter(parameter: FunctionParameter): string {
  const optionalMarker = parameter.optional ? "?" : "";
  const typeAnnotation = parameter.typeAnnotation
    ? `: ${formatIdentifier(parameter.typeAnnotation)}`
    : "";
  const defaultValue = parameter.defaultValue ? ` = ${formatExpression(parameter.defaultValue)}` : "";
  return `${formatIdentifier(parameter.name)}${optionalMarker}${typeAnnotation}${defaultValue}`;
}

function formatParameterList(parameters: FunctionParameter[]): string {
  return parameters.map((parameter) => formatParameter(parameter)).join(", ");
}

function formatBlockInline(block: BlockStatement, level: number): string {
  if (block.body.length === 0) {
    return "{\n" + `${indent(level)}}`;
  }

  const body = block.body.map((statement) => formatStatement(statement, level + 1)).join("\n");
  return "{\n" + `${body}\n${indent(level)}}`;
}

function formatFunctionStatement(statement: FunctionStatement, level: number): string {
  const returnType = statement.returnType ? `: ${formatIdentifier(statement.returnType)}` : "";
  const signature =
    `${indent(level)}${statement.declarationKind} ${formatIdentifier(statement.name)}` +
    `(${formatParameterList(statement.parameters)})${returnType}`;
  return `${signature} ${formatBlockInline(statement.body, level)}`;
}

function formatWhileStatement(statement: WhileStatement, level: number): string {
  const header = `${indent(level)}while (${formatExpression(statement.condition)})`;
  const bodyNode = statement.body as KnownStatement;
  if (bodyNode.kind === "BlockStatement") {
    return `${header} ${formatBlockInline(bodyNode, level)}`;
  }
  return `${header}\n${formatStatement(statement.body, level + 1)}`;
}

function formatDoWhileStatement(statement: DoWhileStatement, level: number): string {
  const whileSuffix = `while (${formatExpression(statement.condition)});`;
  const bodyNode = statement.body as KnownStatement;

  if (bodyNode.kind === "BlockStatement") {
    return `${indent(level)}do ${formatBlockInline(bodyNode, level)} ${whileSuffix}`;
  }

  return `${indent(level)}do\n${formatStatement(statement.body, level + 1)}\n${indent(level)}${whileSuffix}`;
}

function formatClassMethodMember(member: ClassMethodMember, level: number): string {
  const returnType = member.returnType ? `: ${formatIdentifier(member.returnType)}` : "";
  const header =
    `${indent(level)}${formatIdentifier(member.name)}(${formatParameterList(member.parameters)})${returnType}`;
  return `${header} ${formatBlockInline(member.body, level)}`;
}

function formatClassFieldMember(member: ClassFieldMember, level: number): string {
  const typeAnnotation = member.typeAnnotation ? `: ${formatIdentifier(member.typeAnnotation)}` : "";
  const initializer = member.initializer ? ` = ${formatExpression(member.initializer)}` : "";
  return `${indent(level)}${formatIdentifier(member.name)}${typeAnnotation}${initializer};`;
}

function formatClassMember(member: ClassMember, level: number): string {
  if (member.kind === "ClassFieldMember") {
    return formatClassFieldMember(member, level);
  }
  return formatClassMethodMember(member, level);
}

function formatClassStatement(statement: ClassStatement, level: number): string {
  if (statement.members.length === 0) {
    return `${indent(level)}class ${formatIdentifier(statement.name)} {\n${indent(level)}}`;
  }

  const members = statement.members.map((member) => formatClassMember(member, level + 1)).join("\n\n");
  return `${indent(level)}class ${formatIdentifier(statement.name)} {\n${members}\n${indent(level)}}`;
}

function formatStatement(statement: Statement, level: number): string {
  const node = statement as KnownStatement;

  if (node.kind === "VarStatement") {
    const typeAnnotation = node.typeAnnotation ? `: ${formatIdentifier(node.typeAnnotation)}` : "";
    const initializer = node.initializer ? ` = ${formatExpression(node.initializer)}` : "";
    return `${indent(level)}${node.declarationKind} ${formatIdentifier(node.name)}${typeAnnotation}${initializer};`;
  }
  if (node.kind === "FunctionStatement") {
    return formatFunctionStatement(node, level);
  }
  if (node.kind === "ClassStatement") {
    return formatClassStatement(node, level);
  }
  if (node.kind === "ExprStatement") {
    return `${indent(level)}${formatExpression(node.expression)};`;
  }
  if (node.kind === "BlockStatement") {
    return `${indent(level)}${formatBlockInline(node, level)}`;
  }
  if (node.kind === "WhileStatement") {
    return formatWhileStatement(node, level);
  }
  if (node.kind === "DoWhileStatement") {
    return formatDoWhileStatement(node, level);
  }
  if (node.kind === "ReturnStatement") {
    return node.expression
      ? `${indent(level)}return ${formatExpression(node.expression)};`
      : `${indent(level)}return;`;
  }
  if (node.kind === "ContinueStatement") {
    return `${indent(level)}continue;`;
  }
  if (node.kind === "BreakStatement") {
    return `${indent(level)}break;`;
  }

  throw new Error("Unsupported statement kind");
}

function formatProgram(program: Program): string {
  return program.body.map((statement) => formatStatement(statement, 0)).join("\n");
}

export function formatSource(source: string): string {
  const ast = parseFile(tokenizeReader(source));
  return formatProgram(ast);
}
