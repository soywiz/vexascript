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
  LabeledStatement,
  ImportStatement,
  IntLiteral,
  LongLiteral,
  MemberExpression,
  NewExpression,
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
import type { AnalysisType } from "compiler/analysis/types";

type Assoc = "left" | "right";

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
    case "CommaExpression":
      return PREC_COMMA;
    case "AssignmentExpression":
      return PREC_ASSIGNMENT;
    case "AsExpression":
      return PREC_RELATIONAL;
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

function emitIdentifier(identifier: Identifier): string {
  return identifier.name;
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
  const text = emitExpression(expression);
  return expression.kind === "CommaExpression" ? `(${text})` : text;
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
      case "AsExpression":
        return emitExpression((expression as AsExpression).expression, parentPrecedence, side);
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
          return member.optional
            ? `${objectText}?.[${emitExpression(member.property)}]`
            : `${objectText}[${emitExpression(member.property)}]`;
        }
        const access = member.optional ? "?." : member.nonNullAsserted ? "!." : ".";
        return `${objectText}${access}${emitExpression(member.property, PREC_MEMBER, "right")}`;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const calleeText = emitExpression(call.callee, PREC_MEMBER, "left");
        return `${calleeText}${call.optional ? "?." : ""}(${call.arguments.map((argument) => emitListElement(argument)).join(", ")})`;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        const calleeText = emitExpression(newExpression.callee, PREC_MEMBER, "left");
        if (newExpression.arguments) {
          return `new ${calleeText}(${newExpression.arguments.map((argument) => emitListElement(argument)).join(", ")})`;
        }
        return `new ${calleeText}`;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
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
        const parameters = `(${emitFunctionParameters(arrow.parameters)})`;
        if (arrow.body.kind === "BlockStatement") {
          return `${arrow.async === true ? "async " : ""}${parameters} => ${emitBlock(arrow.body as BlockStatement)}`;
        }
        const bodyExpression = arrow.body as Expr;
        const bodyText = emitExpression(bodyExpression);
        if (bodyExpression.kind === "ObjectLiteral") {
          return `${arrow.async === true ? "async " : ""}${parameters} => (${bodyText})`;
        }
        return `${arrow.async === true ? "async " : ""}${parameters} => ${bodyText}`;
      }
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        const name = fn.name ? ` ${fn.name.name}` : "";
        return `${fn.async === true ? "async " : ""}function${fn.generator === true ? "*" : ""}${name}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`;
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
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => {
      const restPrefix = parameter.rest ? "..." : "";
      if (parameter.defaultValue) {
        return `${restPrefix}${parameter.name.name} = ${emitListElement(parameter.defaultValue)}`;
      }
      return `${restPrefix}${parameter.name.name}`;
    })
    .join(", ");
}

function emitVarDeclarator(declarator: VarDeclarator): string {
  if (declarator.initializer) {
    return `${declarator.name.name} = ${emitListElement(declarator.initializer)}`;
  }
  return declarator.name.name;
}

function emitVarStatementBody(statement: VarStatement): string {
  if (statement.declarations && statement.declarations.length > 0) {
    return statement.declarations.map((declaration) => emitVarDeclarator(declaration)).join(", ");
  }
  if (statement.initializer) {
    return `${statement.name.name} = ${emitListElement(statement.initializer)}`;
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
  const asyncPrefix = method.async === true ? "async " : "";
  const generatorPrefix = method.generator === true ? "*" : "";
  return `${staticPrefix}${asyncPrefix}${accessorPrefix}${generatorPrefix}${method.name.name}(${emitFunctionParameters(method.parameters)}) ${emitBlock(method.body)}`;
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

  const name = statement.name.name;
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

export function emitStatement(statement: Statement): string {
  switch (statement.kind) {
    case "ExportStatement": {
      const exportStatement = statement as ExportStatement;
      if (exportStatement.typeOnly) {
        return "";
      }
      if (exportStatement.exportAll) {
        return exportStatement.from ? `export * from ${JSON.stringify(exportStatement.from.value)};` : "";
      }
      if (exportStatement.specifiers) {
        const names = exportStatement.specifiers
          .map((specifier) => specifier.local
            ? `${specifier.local.name} as ${specifier.exported.name}`
            : specifier.exported.name)
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
      if (importStatement.namespaceImport) {
        clauses.push(`* as ${importStatement.namespaceImport.name}`);
      } else if (importStatement.specifiers.length > 0) {
        const names = importStatement.specifiers
          .map((specifier) => specifier.local
            ? `${specifier.imported.name} as ${specifier.local.name}`
            : specifier.imported.name)
          .join(", ");
        clauses.push(`{ ${names} }`);
      }
      return `import ${clauses.join(", ")} from ${source};`;
    }
    case "VarStatement":
      return emitVarStatement(statement as VarStatement);
    case "EnumStatement":
      return emitEnumStatement(statement as EnumStatement);
    case "FunctionStatement": {
      const fn = statement as FunctionStatement;
      if (fn.declared) {
        return "";
      }
      return `${fn.async === true ? "async " : ""}function${fn.generator === true ? "*" : ""} ${fn.name.name}(${emitFunctionParameters(fn.parameters)}) ${emitBlock(fn.body)}`;
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
      return `class ${classStatement.name.name}${extendsClause} {${memberLines.length > 0 ? `\n${memberLines.join("\n")}\n` : ""}}`;
    }
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
  expressionTypes?: ReadonlyMap<Node, AnalysisType>
): string {
  return emitProgramStatements(program, expressionTypes).join("\n");
}

export function emitProgramStatements(
  program: Program,
  expressionTypes?: ReadonlyMap<Node, AnalysisType>
): string[] {
  const previous = activeExpressionTypes;
  activeExpressionTypes = expressionTypes;
  try {
    return program.body
      .map((statement) => emitStatement(statement))
      .filter((statement) => statement.trim().length > 0);
  } finally {
    activeExpressionTypes = previous;
  }
}
