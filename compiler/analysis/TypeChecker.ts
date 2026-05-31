import type {
  ArrayLiteral,
  AssignmentExpression,
  BigIntLiteral,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionParameter,
  FunctionStatement,
  IfStatement,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  LongLiteral
} from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import type {
  AnalysisSymbol,
  BoundAnalysis,
  CheckedAnalysis,
  FlowContext,
  IdentifierResolution,
  Scope
} from "./model";
import {
  type AnalysisType,
  UNKNOWN_TYPE,
  arrayType,
  builtinType,
  functionType,
  isSameType,
  isUnknownType,
  namedType,
  objectType,
  rangeType,
  typeToString
} from "./types";

export class TypeChecker {
  private readonly issues: CheckedAnalysis["issues"] = [];
  private readonly identifierResolutions: IdentifierResolution[] = [];
  private readonly expressionTypes: Map<Node, AnalysisType> = new Map();
  private static readonly BUILTIN_TYPE_NAMES = new Set([
    "int",
    "number",
    "string",
    "boolean",
    "bigint",
    "long"
  ]);

  constructor(
    private readonly program: Program,
    private readonly bound: BoundAnalysis
  ) {}

  check(): CheckedAnalysis {
    this.visitProgram(this.program, this.bound.rootScope, { loopDepth: 0, switchDepth: 0 });
    return {
      issues: [...this.issues],
      identifierResolutions: [...this.identifierResolutions],
      expressionTypes: this.expressionTypes
    };
  }

  private scopeFor(node: Node, fallback: Scope): Scope {
    return this.bound.scopeByNode.get(node) ?? fallback;
  }

  private visitProgram(program: Program, scope: Scope, flow: FlowContext): void {
    for (const statement of program.body) {
      this.visitStatement(statement, scope, flow);
    }
  }

  private visitStatement(statement: Statement, scope: Scope, flow: FlowContext): void {
    switch (statement.kind) {
      case "VarStatement":
        this.visitVarStatement(statement as VarStatement, scope);
        return;
      case "FunctionStatement":
        this.visitFunctionStatement(statement as FunctionStatement, scope);
        return;
      case "ClassStatement":
        this.visitClassStatement(statement as ClassStatement, scope);
        return;
      case "ExprStatement":
        this.visitExpression((statement as ExprStatement).expression, scope);
        return;
      case "BlockStatement":
        this.visitBlockStatement(statement as BlockStatement, scope, flow);
        return;
      case "WhileStatement": {
        const whileStatement = statement as WhileStatement;
        this.visitExpression(whileStatement.condition, scope);
        const loopFlow: FlowContext = {
          loopDepth: flow.loopDepth + 1,
          switchDepth: flow.switchDepth
        };
        const loopScope = this.scopeFor(whileStatement, scope);
        this.visitStatement(whileStatement.body, loopScope, loopFlow);
        return;
      }
      case "DoWhileStatement": {
        const doWhileStatement = statement as DoWhileStatement;
        const loopFlow: FlowContext = {
          loopDepth: flow.loopDepth + 1,
          switchDepth: flow.switchDepth
        };
        const loopScope = this.scopeFor(doWhileStatement, scope);
        this.visitStatement(doWhileStatement.body, loopScope, loopFlow);
        this.visitExpression(doWhileStatement.condition, scope);
        return;
      }
      case "ForStatement":
        this.visitForStatement(statement as ForStatement, scope, flow);
        return;
      case "IfStatement":
        this.visitIfStatement(statement as IfStatement, scope, flow);
        return;
      case "SwitchStatement":
        this.visitSwitchStatement(statement as SwitchStatement, scope, flow);
        return;
      case "ReturnStatement": {
        const returnStatement = statement as ReturnStatement;
        if (returnStatement.expression) {
          this.visitExpression(returnStatement.expression, scope);
        }
        return;
      }
      case "ThrowStatement": {
        const throwStatement = statement as ThrowStatement;
        this.visitExpression(throwStatement.expression, scope);
        return;
      }
      case "TryStatement":
        this.visitTryStatement(statement as TryStatement, scope, flow);
        return;
      case "ContinueStatement":
        if (flow.loopDepth <= 0) {
          this.issues.push({
            message: "Illegal 'continue' statement outside of a loop",
            node: statement
          });
        }
        return;
      case "BreakStatement":
        if (flow.loopDepth <= 0 && flow.switchDepth <= 0) {
          this.issues.push({
            message: "Illegal 'break' statement outside of a loop or switch",
            node: statement
          });
        }
        return;
      default:
        return;
    }
  }

  private visitVarStatement(statement: VarStatement, scope: Scope): void {
    if (statement.declarations && statement.declarations.length > 0) {
      for (const declaration of statement.declarations) {
        const explicitType = this.resolveTypeAnnotation(declaration.typeAnnotation, scope);
        const initializerType = declaration.initializer
          ? this.visitExpression(declaration.initializer, scope)
          : undefined;
        if (
          explicitType &&
          initializerType &&
          !isUnknownType(explicitType) &&
          !isUnknownType(initializerType) &&
          !this.isTypeAssignable(initializerType, explicitType)
        ) {
          this.issues.push({
            message: `Type '${typeToString(initializerType)}' is not assignable to type '${typeToString(explicitType)}'`,
            node: declaration.name
          });
        }
        const inferredType = explicitType ?? initializerType ?? UNKNOWN_TYPE;
        this.updateSymbolType(scope, declaration.name.name, inferredType);
      }
      return;
    }

    const explicitType = this.resolveTypeAnnotation(statement.typeAnnotation, scope);
    const initializerType = statement.initializer
      ? this.visitExpression(statement.initializer, scope)
      : undefined;
    if (
      explicitType &&
      initializerType &&
      !isUnknownType(explicitType) &&
      !isUnknownType(initializerType) &&
      !this.isTypeAssignable(initializerType, explicitType)
    ) {
      this.issues.push({
        message: `Type '${typeToString(initializerType)}' is not assignable to type '${typeToString(explicitType)}'`,
        node: statement.name
      });
    }
    const inferredType = explicitType ?? initializerType ?? UNKNOWN_TYPE;
    this.updateSymbolType(scope, statement.name.name, inferredType);
  }

  private visitFunctionStatement(statement: FunctionStatement, scope: Scope): void {
    const returnType = this.resolveTypeAnnotation(statement.returnType, scope) ?? UNKNOWN_TYPE;
    const fnType = this.buildFunctionType(statement.parameters, returnType, scope);
    this.updateSymbolType(scope, statement.name.name, fnType);

    const functionScope = this.scopeFor(statement, scope);
    for (const parameter of statement.parameters) {
      const parameterType =
        this.resolveTypeAnnotation(parameter.typeAnnotation, functionScope) ??
        (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, functionScope) : UNKNOWN_TYPE);
      this.updateSymbolType(functionScope, parameter.name.name, parameterType);
    }

    for (const bodyStatement of statement.body.body) {
      this.visitStatement(bodyStatement, functionScope, { loopDepth: 0, switchDepth: 0 });
    }
  }

  private visitClassStatement(statement: ClassStatement, scope: Scope): void {
    const classType = namedType(statement.name.name);
    this.updateSymbolType(scope, statement.name.name, classType);

    const classScope = this.scopeFor(statement, scope);
    for (const member of statement.members) {
      if (member.kind === "ClassFieldMember") {
        const field = member as ClassFieldMember;
        if (field.initializer) {
          this.visitExpression(field.initializer, classScope);
        }
        continue;
      }

      const method = member as ClassMethodMember;
      const methodType = this.buildFunctionType(
        method.parameters,
        this.resolveTypeAnnotation(method.returnType, classScope) ?? UNKNOWN_TYPE,
        classScope
      );
      this.updateSymbolType(classScope, method.name.name, methodType);

      const methodScope = this.scopeFor(method, classScope);
      for (const parameter of method.parameters) {
        const parameterType =
          this.resolveTypeAnnotation(parameter.typeAnnotation, methodScope) ??
          (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, methodScope) : UNKNOWN_TYPE);
        this.updateSymbolType(methodScope, parameter.name.name, parameterType);
      }
      for (const bodyStatement of method.body.body) {
        this.visitStatement(bodyStatement, methodScope, { loopDepth: 0, switchDepth: 0 });
      }
    }
  }

  private visitBlockStatement(statement: BlockStatement, scope: Scope, flow: FlowContext): void {
    const blockScope = this.scopeFor(statement, scope);
    for (const child of statement.body) {
      this.visitStatement(child, blockScope, flow);
    }
  }

  private visitForStatement(statement: ForStatement, scope: Scope, flow: FlowContext): void {
    const loopScope = this.scopeFor(statement, scope);
    const loopFlow: FlowContext = {
      loopDepth: flow.loopDepth + 1,
      switchDepth: flow.switchDepth
    };

    if (statement.iterationKind && statement.iterator && statement.iterable) {
      if (statement.iterator.kind !== "VarStatement" && statement.iterator.kind !== "Identifier") {
        this.visitExpression(statement.iterator as Expr, loopScope);
      }

      this.visitExpression(statement.iterable, loopScope);
      this.visitStatement(statement.body, loopScope, loopFlow);
      return;
    }

    if (statement.initializer) {
      if (statement.initializer.kind === "VarStatement") {
        this.visitVarStatement(statement.initializer as VarStatement, loopScope);
      } else {
        this.visitExpression(statement.initializer as Expr, loopScope);
      }
    }
    if (statement.condition) {
      this.visitExpression(statement.condition, loopScope);
    }
    if (statement.update) {
      this.visitExpression(statement.update, loopScope);
    }
    this.visitStatement(statement.body, loopScope, loopFlow);
  }

  private visitIfStatement(statement: IfStatement, scope: Scope, flow: FlowContext): void {
    this.visitExpression(statement.condition, scope);
    const thenScope = this.scopeFor(statement.thenBranch, scope);
    this.visitStatement(statement.thenBranch, thenScope, flow);
    if (statement.elseBranch) {
      const elseScope = this.scopeFor(statement.elseBranch, scope);
      this.visitStatement(statement.elseBranch, elseScope, flow);
    }
  }

  private visitSwitchStatement(statement: SwitchStatement, scope: Scope, flow: FlowContext): void {
    this.visitExpression(statement.discriminant, scope);
    const switchScope = this.scopeFor(statement, scope);
    const switchFlow: FlowContext = {
      loopDepth: flow.loopDepth,
      switchDepth: flow.switchDepth + 1
    };

    for (const switchCase of statement.cases) {
      const caseScope = this.scopeFor(switchCase, switchScope);
      if (switchCase.test) {
        this.visitExpression(switchCase.test, caseScope);
      }
      for (const consequent of switchCase.consequent) {
        this.visitStatement(consequent, caseScope, switchFlow);
      }
    }
  }

  private visitTryStatement(statement: TryStatement, scope: Scope, flow: FlowContext): void {
    const tryScope = this.scopeFor(statement.tryBlock, scope);
    for (const child of statement.tryBlock.body) {
      this.visitStatement(child, tryScope, flow);
    }

    if (statement.catchClause) {
      const catchScope = this.scopeFor(statement.catchClause, scope);
      for (const child of statement.catchClause.body.body) {
        this.visitStatement(child, catchScope, flow);
      }
    }

    if (statement.finallyBlock) {
      const finallyScope = this.scopeFor(statement.finallyBlock, scope);
      for (const child of statement.finallyBlock.body) {
        this.visitStatement(child, finallyScope, flow);
      }
    }
  }

  private visitExpression(expression: Expr, scope: Scope): AnalysisType {
    let result: AnalysisType;
    switch (expression.kind) {
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        const leftType = this.visitExpression(binary.left, scope);
        const rightType = this.visitExpression(binary.right, scope);
        result = this.inferBinaryType(binary.operator, leftType, rightType);
        break;
      }
      case "RangeExpression": {
        const range = expression as RangeExpression;
        this.visitExpression(range.start, scope);
        this.visitExpression(range.end, scope);
        result = rangeType(builtinType("int"));
        break;
      }
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        if (!this.isLValueExpression(assignment.left)) {
          this.issues.push({
            message: "Invalid assignment target: left side must be an identifier or member access",
            node: assignment.left
          });
        }
        this.visitExpression(assignment.left, scope);
        result = this.visitExpression(assignment.right, scope);
        break;
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        this.visitExpression(member.object, scope);
        if (member.computed) {
          this.visitExpression(member.property, scope);
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        this.visitExpression(call.callee, scope);
        for (const argument of call.arguments) {
          this.visitExpression(argument, scope);
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        const calleeType = this.visitExpression(newExpression.callee, scope);
        for (const argument of newExpression.arguments ?? []) {
          this.visitExpression(argument, scope);
        }
        if (!isUnknownType(calleeType)) {
          result = calleeType;
          break;
        }

        if (newExpression.callee.kind === "Identifier") {
          result = namedType(newExpression.callee.name);
          break;
        }

        result = calleeType;
        break;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        const argumentType = this.visitExpression(unary.argument, scope);
        if ((unary.operator === "+" || unary.operator === "-") && this.isIntType(argumentType)) {
          result = builtinType("int");
          break;
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "UpdateExpression":
        this.visitExpression((expression as UpdateExpression).argument, scope);
        result = builtinType("int");
        break;
      case "ArrayLiteral":
        result = this.inferArrayLiteralType(expression as ArrayLiteral, scope);
        break;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          this.visitExpression(property.value, scope);
        }
        result = objectType();
        break;
      case "Identifier":
        result = this.resolveIdentifierType(expression as Node & { kind: "Identifier"; name: string }, scope);
        break;
      case "IntLiteral":
        result = builtinType("int");
        break;
      case "FloatLiteral":
        result = builtinType("number");
        break;
      case "BigIntLiteral":
        result = builtinType("bigint");
        break;
      case "LongLiteral":
        result = builtinType("long");
        break;
      case "StringLiteral":
        result = builtinType("string");
        break;
      default:
        result = UNKNOWN_TYPE;
        break;
    }

    this.expressionTypes.set(expression, result);
    return result;
  }

  private inferBinaryType(
    operator: BinaryExpression["operator"],
    leftType: AnalysisType,
    rightType: AnalysisType
  ): AnalysisType {
    if (
      operator === "+" &&
      ((leftType.kind === "builtin" && leftType.name === "string") ||
        (rightType.kind === "builtin" && rightType.name === "string"))
    ) {
      return builtinType("string");
    }

    if (
      operator === "+" ||
      operator === "-" ||
      operator === "*" ||
      operator === "/" ||
      operator === "%" ||
      operator === "**" ||
      operator === "<<" ||
      operator === ">>" ||
      operator === ">>>" ||
      operator === "&" ||
      operator === "|" ||
      operator === "^"
    ) {
      if (this.isBigIntType(leftType) && this.isBigIntType(rightType)) {
        return builtinType("bigint");
      }
      if (this.isLongType(leftType) && this.isLongType(rightType)) {
        return builtinType("long");
      }
      return this.isIntType(leftType) && this.isIntType(rightType) ? builtinType("int") : UNKNOWN_TYPE;
    }

    if (
      operator === "<" ||
      operator === ">" ||
      operator === "<=" ||
      operator === ">=" ||
      operator === "==" ||
      operator === "!=" ||
      operator === "===" ||
      operator === "!==" ||
      operator === "||" ||
      operator === "&&"
    ) {
      return builtinType("boolean");
    }

    return UNKNOWN_TYPE;
  }

  private isTypeAssignable(sourceType: AnalysisType, targetType: AnalysisType): boolean {
    if (isSameType(sourceType, targetType)) {
      return true;
    }

    if (this.isIntType(sourceType) && this.isNumberType(targetType)) {
      return true;
    }

    return false;
  }

  private buildFunctionType(
    parameters: FunctionParameter[],
    returnType: AnalysisType,
    scope: Scope
  ): AnalysisType {
    return functionType(
      parameters.map((parameter) => ({
        name: parameter.name.name,
        type: parameter.typeAnnotation
          ? this.resolveTypeAnnotation(parameter.typeAnnotation, scope) ?? UNKNOWN_TYPE
          : UNKNOWN_TYPE
      })),
      returnType
    );
  }

  private resolveTypeAnnotation(
    typeAnnotation: Node & { kind: "Identifier"; name: string } | undefined,
    scope: Scope
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }

    if (TypeChecker.BUILTIN_TYPE_NAMES.has(typeAnnotation.name)) {
      return builtinType(
        typeAnnotation.name as "int" | "number" | "string" | "boolean" | "bigint" | "long"
      );
    }

    const symbol = this.resolve(typeAnnotation.name, scope, undefined);
    if (symbol && symbol.kind === "class") {
      return namedType(typeAnnotation.name);
    }

    this.issues.push({
      message: `Unknown type '${typeAnnotation.name}'. Expected builtin type (int, number, string, boolean, bigint, long) or declared class/interface`,
      node: typeAnnotation
    });
    return UNKNOWN_TYPE;
  }

  private isLValueExpression(expression: Expr): boolean {
    return expression.kind === "Identifier" || expression.kind === "MemberExpression";
  }

  private resolve(
    name: string,
    scope: Scope,
    usageOffset: number | undefined
  ): AnalysisSymbol | null {
    let current: Scope | undefined = scope;
    while (current) {
      const symbol = current.symbols.get(name);
      if (symbol) {
        if (!current.parent) {
          return symbol;
        }
        if (usageOffset === undefined || symbol.declaredOffset < 0 || symbol.declaredOffset <= usageOffset) {
          return symbol;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private resolveIdentifierType(
    identifier: Node & { kind: "Identifier"; name: string },
    scope: Scope
  ): AnalysisType {
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
    if (symbol) {
      this.identifierResolutions.push({ identifier, symbol });
      return symbol.type ?? UNKNOWN_TYPE;
    }
    this.issues.push({
      message: `Undefined variable '${identifier.name}'`,
      node: identifier
    });
    return UNKNOWN_TYPE;
  }

  private updateSymbolType(scope: Scope, name: string, type: AnalysisType): void {
    const symbol = scope.symbols.get(name);
    if (!symbol) {
      return;
    }
    symbol.type = type;
    symbol.valueType = typeToString(type);
  }

  private isIntType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "int";
  }

  private isBigIntType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "bigint";
  }

  private isLongType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "long";
  }

  private isNumberType(type: AnalysisType): boolean {
    return type.kind === "builtin" && (type.name === "int" || type.name === "number");
  }

  private inferArrayLiteralType(arrayLiteral: ArrayLiteral, scope: Scope): AnalysisType {
    let inferredElementType: AnalysisType | undefined;

    for (const element of arrayLiteral.elements) {
      const currentType = this.visitExpression(element, scope);
      if (!inferredElementType) {
        inferredElementType = currentType;
        continue;
      }

      if (this.isTypeAssignable(currentType, inferredElementType)) {
        continue;
      }
      if (this.isTypeAssignable(inferredElementType, currentType)) {
        inferredElementType = currentType;
        continue;
      }

      inferredElementType = UNKNOWN_TYPE;
    }

    return arrayType(inferredElementType ?? UNKNOWN_TYPE);
  }
}
