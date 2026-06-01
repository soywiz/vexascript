import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionParameter,
  FunctionStatement,
  InterfaceStatement,
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
  WhileStatement
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
  objectTypeWithProperties,
  rangeType,
  typeToString
} from "./types";
import { parseTypeNameShape } from "./typeNames";

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
  private readonly classStatementsByName: Map<string, ClassStatement> = new Map();
  private readonly interfaceStatementsByName: Map<string, InterfaceStatement> = new Map();
  private readonly activeTypeParameterScopes: Array<Set<string>> = [];
  private readonly namedTypeMembersCache: Map<string, Map<string, AnalysisType> | null> = new Map();

  constructor(
    private readonly program: Program,
    private readonly bound: BoundAnalysis
  ) {
    this.collectClassStatements(program);
    this.collectInterfaceStatements(program);
  }

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
      case "InterfaceStatement":
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
          this.reportTypeMismatch(initializerType, explicitType, declaration.name, declaration.initializer);
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
      this.reportTypeMismatch(initializerType, explicitType, statement.name, statement.initializer);
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
    this.withTypeParameters(statement.typeParameters?.map((parameter) => parameter.name.name) ?? [], () => {
      if (statement.extendsType) {
        this.resolveTypeAnnotation(statement.extendsType, classScope);
      }
      for (const implementedType of statement.implementsTypes ?? []) {
        this.resolveTypeAnnotation(implementedType, classScope);
      }

      for (const member of statement.members) {
        if (member.kind === "ClassFieldMember") {
          const field = member as ClassFieldMember;
          if (field.typeAnnotation) {
            this.resolveTypeAnnotation(field.typeAnnotation, classScope);
          }
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
    });
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

      const iterableType = this.visitExpression(statement.iterable, loopScope);
      const iteratorType = this.elementTypeFromIterable(iterableType);
      this.propagateIteratorType(statement.iterator, iteratorType, loopScope);
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
        this.validateReadonlyAssignmentTarget(assignment.left, scope);
        const leftType = this.visitExpression(assignment.left, scope);
        const rightType = this.visitExpression(assignment.right, scope);
        if (
          !isUnknownType(leftType) &&
          !isUnknownType(rightType) &&
          !this.isTypeAssignable(rightType, leftType)
        ) {
          this.reportTypeMismatch(rightType, leftType, assignment.right, assignment.right);
        }
        if (assignment.left.kind === "Identifier" && isUnknownType(leftType) && !isUnknownType(rightType)) {
          const identifier = assignment.left as Node & { kind: "Identifier"; name: string };
          this.updateResolvedSymbolType(scope, identifier, rightType);
        }
        result = rightType;
        break;
      }
      case "ConditionalExpression": {
        const conditional = expression as ConditionalExpression;
        this.visitExpression(conditional.test, scope);
        const consequentType = this.visitExpression(conditional.consequent, scope);
        const alternateType = this.visitExpression(conditional.alternate, scope);
        if (this.isTypeAssignable(consequentType, alternateType)) {
          result = alternateType;
          break;
        }
        if (this.isTypeAssignable(alternateType, consequentType)) {
          result = consequentType;
          break;
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        const objectType = this.visitExpression(member.object, scope);
        if (member.computed) {
          const propertyType = this.visitExpression(member.property, scope);
          result = this.resolveComputedMemberType(objectType, propertyType);
          break;
        }
        this.validateKnownMemberAccess(member, objectType);
        result = this.resolveKnownMemberType(member, objectType) ?? UNKNOWN_TYPE;
        break;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const calleeType = this.visitExpression(call.callee, scope);
        const argumentTypes: AnalysisType[] = [];
        for (const argument of call.arguments) {
          argumentTypes.push(this.visitExpression(argument, scope));
        }
        if (calleeType.kind === "function") {
          this.validateCallArguments(call, calleeType, argumentTypes);
          result = calleeType.returnType;
          break;
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
        const explicitTypeArguments = (newExpression.typeArguments ?? []).map((typeArgument) =>
          this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
        );
        if (!isUnknownType(calleeType)) {
          if (calleeType.kind === "named" && explicitTypeArguments.length > 0) {
            result = namedType(calleeType.name, explicitTypeArguments);
            break;
          }
          result = calleeType;
          break;
        }

        if (newExpression.callee.kind === "Identifier") {
          const calleeIdentifier = newExpression.callee as Node & { kind: "Identifier"; name: string };
          result = namedType(calleeIdentifier.name, explicitTypeArguments);
          break;
        }

        result = calleeType;
        break;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        const argumentType = this.visitExpression(unary.argument, scope);
        if (unary.operator === "!") {
          result = builtinType("boolean");
          break;
        }
        if (unary.operator === "typeof") {
          result = builtinType("string");
          break;
        }
        if (unary.operator === "void") {
          result = builtinType("undefined");
          break;
        }
        if (unary.operator === "delete") {
          result = builtinType("boolean");
          break;
        }
        if (unary.operator === "await") {
          result = argumentType;
          break;
        }
        if ((unary.operator === "+" || unary.operator === "-") && this.isIntType(argumentType)) {
          result = builtinType("int");
          break;
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "UpdateExpression":
        this.validateReadonlyAssignmentTarget((expression as UpdateExpression).argument, scope);
        this.visitExpression((expression as UpdateExpression).argument, scope);
        result = builtinType("int");
        break;
      case "ArrayLiteral":
        result = this.inferArrayLiteralType(expression as ArrayLiteral, scope);
        break;
      case "ObjectLiteral":
        result = this.inferObjectLiteralType(expression as ObjectLiteral, scope);
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

    if (operator === "??") {
      if (isUnknownType(leftType)) {
        return rightType;
      }
      return leftType;
    }

    if (
      operator === "<" ||
      operator === ">" ||
      operator === "<=" ||
      operator === ">=" ||
      operator === "in" ||
      operator === "instanceof" ||
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

    if (sourceType.kind === "function" && targetType.kind === "function") {
      const targetRequiredCount = targetType.parameters.filter((parameter) => !parameter.optional).length;
      if (sourceType.parameters.length < targetRequiredCount) {
        return false;
      }

      for (let index = 0; index < targetType.parameters.length; index += 1) {
        const targetParameter = targetType.parameters[index];
        const sourceParameter = sourceType.parameters[index];
        if (!targetParameter || !sourceParameter) {
          return false;
        }
        if (!this.isTypeAssignable(sourceParameter.type, targetParameter.type)) {
          return false;
        }
        if ((targetParameter.optional ?? false) === false && (sourceParameter.optional ?? false) === true) {
          return false;
        }
      }

      return this.isTypeAssignable(sourceType.returnType, targetType.returnType);
    }

    if (sourceType.kind === "array" && targetType.kind === "array") {
      return this.isTypeAssignable(sourceType.elementType, targetType.elementType);
    }

    if (sourceType.kind === "range" && targetType.kind === "range") {
      return this.isTypeAssignable(sourceType.elementType, targetType.elementType);
    }

    if (sourceType.kind === "range" && targetType.kind === "array") {
      return this.isTypeAssignable(sourceType.elementType, targetType.elementType);
    }

    if (sourceType.kind === "object" && targetType.kind === "object") {
      for (const [propertyName, targetPropertyType] of Object.entries(targetType.properties)) {
        const sourcePropertyType = sourceType.properties[propertyName];
        if (!sourcePropertyType) {
          return false;
        }
        if (!this.isTypeAssignable(sourcePropertyType, targetPropertyType)) {
          return false;
        }
      }
      return true;
    }

    if (sourceType.kind === "object" && targetType.kind === "named") {
      const namedMembers = this.resolveNamedTypeMembers(targetType);
      if (!namedMembers) {
        return false;
      }
      for (const [propertyName, targetPropertyType] of namedMembers) {
        const sourcePropertyType = sourceType.properties[propertyName];
        if (!sourcePropertyType) {
          return false;
        }
        if (!this.isTypeAssignable(sourcePropertyType, targetPropertyType)) {
          return false;
        }
      }
      return true;
    }

    if (this.isIntType(sourceType) && this.isNumberType(targetType)) {
      return true;
    }

    if (this.isLongType(sourceType) && this.isBigIntType(targetType)) {
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
          : UNKNOWN_TYPE,
        optional: parameter.optional === true || parameter.defaultValue !== undefined
      })),
      returnType
    );
  }

  private validateCallArguments(
    call: CallExpression,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): void {
    const requiredCount = calleeType.parameters.filter((parameter) => !parameter.optional).length;
    const providedCount = argumentTypes.length;
    const totalCount = calleeType.parameters.length;

    if (providedCount < requiredCount) {
      this.issues.push({
        message: `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
        node: call
      });
    } else if (providedCount > totalCount) {
      this.issues.push({
        message: `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
        node: call
      });
      for (let index = totalCount; index < providedCount; index += 1) {
        this.issues.push({
          message: `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
          node: call.arguments[index] ?? call
        });
      }
    }

    const comparableCount = Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const parameter = calleeType.parameters[index]!;
      const argumentType = argumentTypes[index]!;
      if (isUnknownType(parameter.type) || isUnknownType(argumentType)) {
        continue;
      }
      if (this.isTypeAssignable(argumentType, parameter.type)) {
        continue;
      }

      this.issues.push({
        message: `Argument ${index + 1} of type '${typeToString(argumentType)}' is not assignable to parameter '${parameter.name}' of type '${typeToString(parameter.type)}'`,
        node: call.arguments[index] ?? call
      });
      const argumentExpression = call.arguments[index];
      if (argumentExpression) {
        this.reportNestedMismatchContext(argumentType, parameter.type, argumentExpression);
      }
    }
  }

  private reportTypeMismatch(
    sourceType: AnalysisType,
    targetType: AnalysisType,
    node: Node,
    expressionForContext?: Expr
  ): void {
    this.issues.push({
      message: `Type '${typeToString(sourceType)}' is not assignable to type '${typeToString(targetType)}'`,
      node
    });
    if (!expressionForContext) {
      return;
    }
    this.reportNestedMismatchContext(sourceType, targetType, expressionForContext);
  }

  private reportNestedMismatchContext(
    sourceType: AnalysisType,
    targetType: AnalysisType,
    expression: Expr
  ): void {
    const snippet = this.expressionSnippet(expression);
    if (!snippet) {
      return;
    }
    this.issues.push({
      message: `Nested type mismatch: expression '${snippet}' is '${typeToString(sourceType)}' but expected '${typeToString(targetType)}'`,
      node: expression
    });
  }

  private expressionSnippet(expression: Expr): string | null {
    if (expression.kind === "Identifier") {
      return null;
    }
    const first = expression.firstToken?.value;
    const last = expression.lastToken?.value;
    if (!first && !last) {
      return expression.kind;
    }
    if (first && last && first !== last) {
      return `${first} ... ${last}`;
    }
    if (first) {
      return first;
    }
    return last ?? expression.kind;
  }

  private resolveTypeAnnotation(
    typeAnnotation: (Node & { kind: "Identifier"; name: string }) | undefined,
    scope: Scope
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }

    return this.resolveTypeName(typeAnnotation, scope);
  }

  private resolveTypeName(
    typeNameIdentifier: Node & { kind: "Identifier"; name: string },
    scope: Scope
  ): AnalysisType {
    return this.resolveTypeNameText(typeNameIdentifier.name, typeNameIdentifier, scope);
  }

  private resolveTypeNameText(typeName: string, node: Node, scope: Scope): AnalysisType {
    const parsed = parseTypeNameShape(typeName);
    let resolvedBase: AnalysisType;

    const resolvedTypeArguments = parsed.typeArguments.map((typeArgument) =>
      this.resolveTypeNameText(typeArgument, node, scope)
    );

    if (TypeChecker.BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as "int" | "number" | "string" | "boolean" | "bigint" | "long"
      );
    } else if (this.isActiveTypeParameter(parsed.baseName)) {
      resolvedBase = namedType(parsed.baseName);
    } else {
      const symbol = this.resolve(parsed.baseName, scope, undefined);
      if (symbol && symbol.kind === "class") {
        resolvedBase = namedType(parsed.baseName, resolvedTypeArguments);
      } else {
        this.issues.push({
          message: `Unknown type '${typeName}'. Expected builtin type (int, number, string, boolean, bigint, long) or declared class/interface/type parameter`,
          node
        });
        return UNKNOWN_TYPE;
      }
    }

    let resolved: AnalysisType = resolvedBase;
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return resolved;
  }

  private withTypeParameters(typeParameters: string[], action: () => void): void {
    if (typeParameters.length <= 0) {
      action();
      return;
    }
    this.activeTypeParameterScopes.push(new Set(typeParameters));
    try {
      action();
    } finally {
      this.activeTypeParameterScopes.pop();
    }
  }

  private isActiveTypeParameter(name: string): boolean {
    for (let i = this.activeTypeParameterScopes.length - 1; i >= 0; i -= 1) {
      const scope = this.activeTypeParameterScopes[i];
      if (scope?.has(name)) {
        return true;
      }
    }
    return false;
  }

  private isLValueExpression(expression: Expr): boolean {
    return expression.kind === "Identifier" || expression.kind === "MemberExpression";
  }

  private validateReadonlyAssignmentTarget(expression: Expr, scope: Scope): void {
    if (expression.kind !== "Identifier") {
      return;
    }

    const identifier = expression as Node & { kind: "Identifier"; name: string };
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
    if (!symbol || symbol.kind !== "variable" || symbol.isReadonly !== true) {
      return;
    }

    this.issues.push({
      message: `Cannot assign to '${identifier.name}' because it is a constant`,
      node: identifier
    });
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

  private updateResolvedSymbolType(
    scope: Scope,
    identifier: Node & { kind: "Identifier"; name: string },
    type: AnalysisType
  ): void {
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
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

  private inferObjectLiteralType(objectLiteral: ObjectLiteral, scope: Scope): AnalysisType {
    if (objectLiteral.properties.length === 0) {
      return objectType();
    }

    const properties: Record<string, AnalysisType> = {};
    for (const property of objectLiteral.properties) {
      properties[property.key.name] = this.visitExpression(property.value, scope);
    }
    return objectTypeWithProperties(properties);
  }

  private elementTypeFromIterable(type: AnalysisType): AnalysisType {
    if (type.kind === "array") {
      return type.elementType;
    }
    if (type.kind === "range") {
      return type.elementType;
    }
    return UNKNOWN_TYPE;
  }

  private propagateIteratorType(
    iterator: ForStatement["iterator"],
    iteratorType: AnalysisType,
    scope: Scope
  ): void {
    if (!iterator || isUnknownType(iteratorType)) {
      return;
    }

    if (iterator.kind === "Identifier") {
      this.updateResolvedSymbolType(
        scope,
        iterator as Node & { kind: "Identifier"; name: string },
        iteratorType
      );
      return;
    }

    if (iterator.kind !== "VarStatement") {
      return;
    }

    const varStatement = iterator as VarStatement;
    if (varStatement.declarations && varStatement.declarations.length > 0) {
      for (const declaration of varStatement.declarations) {
        this.updateSymbolType(scope, declaration.name.name, iteratorType);
      }
      return;
    }

    this.updateSymbolType(scope, varStatement.name.name, iteratorType);
  }

  private collectClassStatements(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "ClassStatement") {
        continue;
      }
      const classStatement = statement as ClassStatement;
      this.classStatementsByName.set(classStatement.name.name, classStatement);
    }
  }

  private collectInterfaceStatements(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "InterfaceStatement") {
        continue;
      }
      const interfaceStatement = statement as InterfaceStatement;
      this.interfaceStatementsByName.set(interfaceStatement.name.name, interfaceStatement);
    }
  }

  private validateKnownMemberAccess(member: MemberExpression, objectType: AnalysisType): void {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const knownMembers = this.membersForType(objectType);
    if (!knownMembers) {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    if (knownMembers.has(propertyName)) {
      return;
    }

    const displayType = objectType.kind === "named" ? objectType.name : typeToString(objectType);
    this.issues.push({
      message: `Property '${propertyName}' does not exist on type '${displayType}'`,
      node: member.property
    });
  }

  private resolveKnownMemberType(member: MemberExpression, objectType: AnalysisType): AnalysisType | null {
    if (member.computed || member.property.kind !== "Identifier") {
      return null;
    }

    const memberName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    if (objectType.kind === "object") {
      return objectType.properties[memberName] ?? null;
    }
    if (objectType.kind !== "named") {
      return null;
    }

    const classMembers = this.resolveNamedTypeMembers(objectType);
    if (!classMembers) {
      return null;
    }
    return classMembers.get(memberName) ?? null;
  }

  private resolveComputedMemberType(objectType: AnalysisType, propertyType: AnalysisType): AnalysisType {
    if (objectType.kind === "array" && this.isIntType(propertyType)) {
      return objectType.elementType;
    }
    if (objectType.kind === "range" && this.isIntType(propertyType)) {
      return objectType.elementType;
    }
    return UNKNOWN_TYPE;
  }

  private membersForType(type: AnalysisType): Map<string, AnalysisType> | null {
    if (type.kind === "object") {
      return new Map(Object.entries(type.properties));
    }
    if (type.kind === "named") {
      return this.resolveNamedTypeMembers(type);
    }
    return null;
  }

  private resolveNamedTypeMembers(type: AnalysisType & { kind: "named" }): Map<string, AnalysisType> | null {
    const cacheKey = typeToString(type);
    if (this.namedTypeMembersCache.has(cacheKey)) {
      return this.namedTypeMembersCache.get(cacheKey) ?? null;
    }

    const resolved = this.resolveNamedTypeMembersInternal(type, new Set<string>());
    this.namedTypeMembersCache.set(cacheKey, resolved);
    return resolved;
  }

  private resolveNamedTypeMembersInternal(
    type: AnalysisType & { kind: "named" },
    visited: Set<string>
  ): Map<string, AnalysisType> | null {
    const visitKey = typeToString(type);
    if (visited.has(visitKey)) {
      return null;
    }
    visited.add(visitKey);

    const classStatement = this.classStatementsByName.get(type.name);
    if (classStatement) {
      const substitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], type);
      const members = new Map<string, AnalysisType>();
      for (const parameter of classStatement.primaryConstructorParameters ?? []) {
        const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
        members.set(parameter.name.name, this.substituteTypeParameters(parameterType, substitutions));
      }

      for (const classMember of classStatement.members) {
        if (classMember.kind === "ClassFieldMember") {
          const fieldType = this.typeFromAnnotationLoose(classMember.typeAnnotation) ?? UNKNOWN_TYPE;
          members.set(
            classMember.name.name,
            this.substituteTypeParameters(fieldType, substitutions)
          );
          continue;
        }

        const returnType = this.typeFromAnnotationLoose(classMember.returnType) ?? UNKNOWN_TYPE;
        members.set(
          classMember.name.name,
          this.substituteTypeParameters(functionType(
            classMember.parameters.map((parameter) => ({
              name: parameter.name.name,
              type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
              optional: parameter.optional === true || parameter.defaultValue !== undefined
            })),
            returnType
          ), substitutions)
        );
      }

      if (classStatement.extendsType) {
        const resolvedExtendsType = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(classStatement.extendsType.name),
          substitutions
        );
        if (resolvedExtendsType.kind === "named") {
          const inheritedMembers = this.resolveNamedTypeMembersInternal(resolvedExtendsType, visited);
          if (inheritedMembers) {
            for (const [memberName, memberType] of inheritedMembers.entries()) {
              if (!members.has(memberName)) {
                members.set(memberName, memberType);
              }
            }
          }
        }
      }

      for (const implementedType of classStatement.implementsTypes ?? []) {
        const resolvedImplementedType = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(implementedType.name),
          substitutions
        );
        if (resolvedImplementedType.kind !== "named") {
          continue;
        }
        const implementedMembers = this.resolveNamedTypeMembersInternal(resolvedImplementedType, visited);
        if (!implementedMembers) {
          continue;
        }
        for (const [memberName, memberType] of implementedMembers.entries()) {
          if (!members.has(memberName)) {
            members.set(memberName, memberType);
          }
        }
      }

      return members;
    }

    const members = new Map<string, AnalysisType>();
    const interfaceStatement = this.interfaceStatementsByName.get(type.name);
    if (!interfaceStatement) {
      return null;
    }
    const substitutions = this.typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], type);
    for (const interfaceMember of interfaceStatement.members) {
      if (interfaceMember.kind === "InterfacePropertyMember") {
        const memberType = this.typeFromAnnotationLoose(interfaceMember.typeAnnotation) ?? UNKNOWN_TYPE;
        members.set(
          interfaceMember.name.name,
          this.substituteTypeParameters(memberType, substitutions)
        );
        continue;
      }

      const returnType = this.typeFromAnnotationLoose(interfaceMember.returnType) ?? UNKNOWN_TYPE;
      members.set(
        interfaceMember.name.name,
        this.substituteTypeParameters(functionType(
          interfaceMember.parameters.map((parameter) => ({
            name: parameter.name.name,
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined
          })),
          returnType
        ), substitutions)
      );
    }

    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      const resolvedParentType = this.substituteTypeParameters(
        this.typeFromTypeNameLoose(parentType.name),
        substitutions
      );
      if (resolvedParentType.kind !== "named") {
        continue;
      }
      const parentMembers = this.resolveNamedTypeMembersInternal(resolvedParentType, visited);
      if (!parentMembers) {
        continue;
      }
      for (const [memberName, memberType] of parentMembers.entries()) {
        if (!members.has(memberName)) {
          members.set(memberName, memberType);
        }
      }
    }

    return members;
  }

  private typeFromAnnotationLoose(
    typeAnnotation: (Node & { kind: "Identifier"; name: string }) | undefined
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    const parsed = parseTypeNameShape(typeAnnotation.name);
    let resolvedBase: AnalysisType;
    if (TypeChecker.BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as "int" | "number" | "string" | "boolean" | "bigint" | "long"
      );
    } else {
      resolvedBase = namedType(
        parsed.baseName,
        parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
      );
    }

    let resolved: AnalysisType = resolvedBase;
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return resolved;
  }

  private typeFromTypeNameLoose(typeName: string): AnalysisType {
    const parsed = parseTypeNameShape(typeName);
    if (TypeChecker.BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      return builtinType(
        parsed.baseName as "int" | "number" | "string" | "boolean" | "bigint" | "long"
      );
    }
    return namedType(
      parsed.baseName,
      parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
    );
  }

  private typeParameterSubstitutions(
    typeParameters: Array<{ name: { name: string } }>,
    type: AnalysisType & { kind: "named" }
  ): Map<string, AnalysisType> {
    const substitutions = new Map<string, AnalysisType>();
    const typeArguments = type.typeArguments ?? [];
    for (let i = 0; i < typeParameters.length; i += 1) {
      const parameterName = typeParameters[i]?.name.name;
      if (!parameterName) {
        continue;
      }
      substitutions.set(parameterName, typeArguments[i] ?? namedType(parameterName));
    }
    return substitutions;
  }

  private substituteTypeParameters(
    sourceType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    if (sourceType.kind === "named") {
      if (!sourceType.typeArguments || sourceType.typeArguments.length === 0) {
        return substitutions.get(sourceType.name) ?? sourceType;
      }
      return namedType(
        sourceType.name,
        sourceType.typeArguments.map((typeArgument) =>
          this.substituteTypeParameters(typeArgument, substitutions)
        )
      );
    }

    if (sourceType.kind === "array") {
      return arrayType(this.substituteTypeParameters(sourceType.elementType, substitutions));
    }

    if (sourceType.kind === "range") {
      return rangeType(this.substituteTypeParameters(sourceType.elementType, substitutions));
    }

    if (sourceType.kind === "object") {
      const substitutedProperties: Record<string, AnalysisType> = {};
      for (const [propertyName, propertyType] of Object.entries(sourceType.properties)) {
        substitutedProperties[propertyName] = this.substituteTypeParameters(propertyType, substitutions);
      }
      return objectTypeWithProperties(substitutedProperties);
    }

    if (sourceType.kind === "function") {
      return functionType(
        sourceType.parameters.map((parameter) => ({
          name: parameter.name,
          type: this.substituteTypeParameters(parameter.type, substitutions),
          ...(parameter.optional !== undefined ? { optional: parameter.optional } : {})
        })),
        this.substituteTypeParameters(sourceType.returnType, substitutions)
      );
    }

    return sourceType;
  }
}
