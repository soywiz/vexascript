import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassPrimaryConstructorParameter,
  ClassStatement,
  ContinueStatement,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IfStatement,
  IntLiteral,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  StringLiteral,
  SwitchStatement,
  UnaryExpression,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";

function normalizeVarKind(kind: string): "let" | "var" | "const" {
  if (kind === "val") {
    return "const";
  }
  if (kind === "const" || kind === "var") {
    return kind;
  }
  return "let";
}

function emitIdentifier(identifier: Identifier): string {
  return identifier.name;
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

function emitForIterator(iterator: ForStatement["iterator"]): string | null {
  if (!iterator) {
    return null;
  }

  if (iterator.kind === "Identifier") {
    return (iterator as Identifier).name;
  }

  if (iterator.kind !== "VarStatement") {
    return null;
  }

  const varStatement = iterator as VarStatement;
  const firstDeclaration = varStatement.declarations?.[0];
  if (firstDeclaration) {
    return firstDeclaration.name.name;
  }
  return varStatement.name.name;
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

function emitRangeAsGenerator(range: RangeExpression): string {
  return `(function*(s, e) { for (let n = s; n < e; n++) yield n })(${emitExpression(range.start)}, ${emitExpression(range.end)})`;
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

export function emitExpression(expression: Expr): string {
  switch (expression.kind) {
    case "IntLiteral":
      return String((expression as IntLiteral).value);
    case "StringLiteral":
      return JSON.stringify((expression as StringLiteral).value);
    case "Identifier":
      return emitIdentifier(expression as Identifier);
    case "BinaryExpression": {
      const binary = expression as BinaryExpression;
      return `${emitExpression(binary.left)} ${binary.operator} ${emitExpression(binary.right)}`;
    }
    case "RangeExpression":
      return emitRangeAsGenerator(expression as RangeExpression);
    case "AssignmentExpression": {
      const assignment = expression as AssignmentExpression;
      return `${emitExpression(assignment.left)} ${assignment.operator} ${emitExpression(assignment.right)}`;
    }
    case "MemberExpression": {
      const member = expression as MemberExpression;
      if (member.computed) {
        return `${emitExpression(member.object)}[${emitExpression(member.property)}]`;
      }
      const access = member.optional ? "?." : member.nonNullAsserted ? "!." : ".";
      return `${emitExpression(member.object)}${access}${emitExpression(member.property)}`;
    }
    case "CallExpression": {
      const call = expression as CallExpression;
      return `${emitExpression(call.callee)}(${call.arguments.map((argument) => emitExpression(argument)).join(", ")})`;
    }
    case "NewExpression": {
      const newExpression = expression as NewExpression;
      if (newExpression.arguments) {
        return `new ${emitExpression(newExpression.callee)}(${newExpression.arguments
          .map((argument) => emitExpression(argument))
          .join(", ")})`;
      }
      return `new ${emitExpression(newExpression.callee)}`;
    }
    case "UnaryExpression": {
      const unary = expression as UnaryExpression;
      return `${unary.operator}${emitExpression(unary.argument)}`;
    }
    case "UpdateExpression": {
      const update = expression as UpdateExpression;
      if (update.prefix) {
        return `${update.operator}${emitExpression(update.argument)}`;
      }
      return `${emitExpression(update.argument)}${update.operator}`;
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
}

function emitForStatement(statement: ForStatement): string {
  if (statement.iterationKind && statement.iterator && statement.iterable) {
    if (statement.iterationKind === "of" && statement.iterable.kind === "RangeExpression") {
      const iteratorName = emitForIterator(statement.iterator);
      if (iteratorName) {
        const range = statement.iterable as RangeExpression;
        return `for (let ${iteratorName} = ${emitExpression(range.start)}; ${iteratorName} < ${emitExpression(range.end)}; ${iteratorName}++) ${emitStatement(statement.body)}`;
      }
    }

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
    case "ContinueStatement":
      return "continue;";
    case "BreakStatement":
      return "break;";
    default:
      return "";
  }
}

export function emitProgram(program: Program): string {
  return program.body
    .map((statement) => emitStatement(statement))
    .filter((statement) => statement.trim().length > 0)
    .join("\n");
}
