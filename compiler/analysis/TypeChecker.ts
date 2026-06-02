import type {
  ArrowFunctionExpression,
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
  FunctionExpression,
  TypeParameter,
  FunctionStatement,
  InterfaceStatement,
  IfStatement,
  Identifier,
  IntLiteral,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  ObjectProperty,
  ObjectSpreadProperty,
  StringLiteral,
  SpreadExpression,
  BooleanLiteral,
  FloatLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TypeAliasStatement,
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
  type BuiltinTypeName,
  UNKNOWN_TYPE,
  arrayType,
  builtinType,
  functionType,
  intersectionType,
  isSameType,
  isUnknownType,
  literalType,
  namedType,
  objectType,
  objectTypeWithProperties,
  rangeType,
  tupleType,
  typeToString,
  unionType
} from "./types";
import { parseTypeNameShape, splitTopLevelTypeText, stripEnclosingTypeParens } from "./typeNames";
import { ANALYSIS_ISSUE_CODES } from "./issueCodes";

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
    "long",
    "void",
    "null",
    "undefined",
    "any",
    "unknown",
    "never",
    "object",
    "symbol"
  ]);
  private readonly classStatementsByName: Map<string, ClassStatement> = new Map();
  private readonly interfaceStatementsByName: Map<string, InterfaceStatement> = new Map();
  private readonly typeAliasStatementsByName: Map<string, TypeAliasStatement> = new Map();
  private readonly activeTypeParameterScopes: Array<Set<string>> = [];
  private readonly namedTypeMembersCache: Map<string, Map<string, AnalysisType> | null> = new Map();
  private readonly activeTypeAliasNames: Set<string> = new Set();

  constructor(
    private readonly program: Program,
    private readonly bound: BoundAnalysis
  ) {
    this.collectClassStatements(program);
    this.collectInterfaceStatements(program);
    this.collectTypeAliasStatements(program);
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
      case "TypeAliasStatement":
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
          ? this.visitExpression(declaration.initializer, scope, explicitType)
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
      ? this.visitExpression(statement.initializer, scope, explicitType)
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
    const typeParameterNames = statement.typeParameters?.map((parameter) => parameter.name.name) ?? [];
    this.withTypeParameters(typeParameterNames, () => {
      const returnType = this.resolveTypeAnnotation(statement.returnType, scope) ?? UNKNOWN_TYPE;
      const fnType = this.buildFunctionType(statement.parameters, returnType, scope, statement.typeParameters ?? []);
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
    });
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
        if (method.abstract === true && statement.abstract !== true && statement.declared !== true) {
          this.issues.push({
            message: `Abstract member '${method.name.name}' can only appear within an abstract class`,
            node: method.name
          });
        }
        if (method.missingBody === true && statement.declared !== true && method.abstract !== true) {
          this.issues.push({
            message: `Class method '${method.name.name}' must have a body`,
            node: method.name
          });
        }
        const methodTypeParameterNames = method.typeParameters?.map((parameter) => parameter.name.name) ?? [];
        this.withTypeParameters(methodTypeParameterNames, () => {
          const methodType = this.buildFunctionType(
            method.parameters,
            this.resolveTypeAnnotation(method.returnType, classScope) ?? builtinType("void"),
            classScope,
            method.typeParameters ?? []
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
        });
      }

      this.validateOverrideMembers(statement);
      this.validateImplementedInterfaces(statement);
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

  private visitExpression(expression: Expr, scope: Scope, expectedType?: AnalysisType): AnalysisType {
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
        const rightType = this.visitExpression(assignment.right, scope, leftType);
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
        const consequentType = this.visitExpression(conditional.consequent, scope, expectedType);
        const alternateType = this.visitExpression(conditional.alternate, scope, expectedType);
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
          result = this.resolveOptionalAccessType(this.resolveComputedMemberType(objectType, propertyType), member.optional === true);
          break;
        }
        this.validateKnownMemberAccess(member, objectType, scope);
        result = this.resolveOptionalAccessType(this.resolveKnownMemberType(member, objectType) ?? UNKNOWN_TYPE, member.optional === true);
        break;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const calleeType = this.visitExpression(call.callee, scope);
        const argumentTypes: AnalysisType[] = [];
        for (const argument of call.arguments) {
          argumentTypes.push(this.visitExpression(argument, scope));
        }
        const callableType = this.callableTypeFrom(calleeType);
        if (callableType) {
          const explicitTypeArguments = (call.typeArguments ?? []).map((typeArgument) =>
            this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
          );
          const firstPassCalleeType = this.instantiateFunctionType(
            callableType,
            explicitTypeArguments,
            argumentTypes,
            expectedType
          );
          const contextualArgumentTypes = this.applyCallArgumentContext(
            call,
            scope,
            firstPassCalleeType,
            argumentTypes
          );
          const instantiatedCalleeType = contextualArgumentTypes === argumentTypes
            ? firstPassCalleeType
            : this.instantiateFunctionType(callableType, explicitTypeArguments, contextualArgumentTypes, expectedType);
          this.validateFunctionTypeArgumentConstraints(callableType, instantiatedCalleeType, call);
          this.validateCallArguments(call, instantiatedCalleeType, contextualArgumentTypes);
          result = this.resolveOptionalAccessType(
            instantiatedCalleeType.returnType,
            call.optional === true || this.hasNullishUnionMember(calleeType)
          );
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
            this.validateNamedTypeArgumentConstraints(
              calleeType.name,
              explicitTypeArguments,
              newExpression.callee,
              scope
            );
            result = namedType(calleeType.name, explicitTypeArguments);
            break;
          }
          result = calleeType;
          break;
        }

        if (newExpression.callee.kind === "Identifier") {
          const calleeIdentifier = newExpression.callee as Node & { kind: "Identifier"; name: string };
          this.validateNamedTypeArgumentConstraints(
            calleeIdentifier.name,
            explicitTypeArguments,
            calleeIdentifier,
            scope
          );
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
      case "SpreadExpression": {
        const spread = expression as SpreadExpression;
        result = this.visitExpression(spread.argument, scope);
        break;
      }
      case "UpdateExpression":
        this.validateReadonlyAssignmentTarget((expression as UpdateExpression).argument, scope);
        this.visitExpression((expression as UpdateExpression).argument, scope);
        result = builtinType("int");
        break;
      case "ArrayLiteral":
        result = this.inferArrayLiteralType(expression as ArrayLiteral, scope, expectedType);
        break;
      case "ObjectLiteral":
        result = this.inferObjectLiteralType(expression as ObjectLiteral, scope, expectedType);
        break;
      case "ArrowFunctionExpression": {
        const arrow = expression as ArrowFunctionExpression;
        const expectedFunctionType = expectedType?.kind === "function" ? expectedType : undefined;
        const arrowScope = this.createFunctionLikeExpressionScope(scope, arrow, arrow.parameters, expectedFunctionType);
        let returnType: AnalysisType;
        if (arrow.body.kind === "BlockStatement") {
          for (const bodyStatement of (arrow.body as BlockStatement).body) {
            this.visitStatement(bodyStatement, arrowScope, { loopDepth: 0, switchDepth: 0 });
          }
          returnType = builtinType("void");
        } else {
          returnType = this.visitExpression(arrow.body as Expr, arrowScope, expectedFunctionType?.returnType);
        }
        result = this.buildFunctionType(arrow.parameters, returnType, arrowScope);
        break;
      }
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        const expectedFunctionType = expectedType?.kind === "function" ? expectedType : undefined;
        const functionScope = this.createFunctionLikeExpressionScope(scope, fn, fn.parameters, expectedFunctionType);
        for (const bodyStatement of fn.body.body) {
          this.visitStatement(bodyStatement, functionScope, { loopDepth: 0, switchDepth: 0 });
        }
        const returnType = this.resolveTypeAnnotation(fn.returnType, functionScope) ?? expectedFunctionType?.returnType ?? builtinType("void");
        result = this.buildFunctionType(fn.parameters, returnType, functionScope);
        break;
      }
      case "Identifier":
        result = this.resolveIdentifierType(expression as Node & { kind: "Identifier"; name: string }, scope);
        break;
      case "IntLiteral":
        result = this.contextualLiteralType(
          literalType("number", (expression as IntLiteral).value),
          expectedType
        ) ?? builtinType("int");
        break;
      case "FloatLiteral":
        result = this.contextualLiteralType(
          literalType("number", (expression as FloatLiteral).value),
          expectedType
        ) ?? builtinType("number");
        break;
      case "BigIntLiteral":
        result = builtinType("bigint");
        break;
      case "LongLiteral":
        result = builtinType("long");
        break;
      case "StringLiteral":
        result = this.contextualLiteralType(
          literalType("string", (expression as StringLiteral).value),
          expectedType
        ) ?? builtinType("string");
        break;
      case "BooleanLiteral":
        result = this.contextualLiteralType(
          literalType("boolean", (expression as BooleanLiteral).value),
          expectedType
        ) ?? builtinType("boolean");
        break;
      case "NullLiteral":
        result = builtinType("null");
        break;
      case "UndefinedLiteral":
        result = builtinType("undefined");
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
      (this.isStringLikeType(leftType) || this.isStringLikeType(rightType))
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

    if (targetType.kind === "union") {
      return targetType.types.some((member) => this.isTypeAssignable(sourceType, member));
    }

    if (sourceType.kind === "union") {
      return sourceType.types.every((member) => this.isTypeAssignable(member, targetType));
    }

    if (targetType.kind === "intersection") {
      return targetType.types.every((member) => this.isTypeAssignable(sourceType, member));
    }

    if (sourceType.kind === "intersection") {
      return sourceType.types.some((member) => this.isTypeAssignable(member, targetType));
    }

    if (sourceType.kind === "literal") {
      if (targetType.kind === "builtin" && targetType.name === sourceType.base) {
        return true;
      }
      if (
        targetType.kind === "builtin" &&
        targetType.name === "int" &&
        sourceType.base === "number" &&
        Number.isInteger(sourceType.value)
      ) {
        return true;
      }
    }

    if (sourceType.kind === "tuple" && targetType.kind === "array") {
      return sourceType.elements.every((element) => this.isTypeAssignable(element, targetType.elementType));
    }

    if (sourceType.kind === "tuple" && targetType.kind === "tuple") {
      if (sourceType.elements.length !== targetType.elements.length) {
        return false;
      }
      return sourceType.elements.every((element, index) =>
        this.isTypeAssignable(element, targetType.elements[index]!)
      );
    }

    if (targetType.kind === "builtin" && targetType.name === "any") {
      return true;
    }

    if (sourceType.kind === "builtin" && sourceType.name === "any") {
      return true;
    }

    if (sourceType.kind === "builtin" && sourceType.name === "never") {
      return true;
    }

    if (targetType.kind === "builtin" && targetType.name === "unknown") {
      return true;
    }

    if (
      targetType.kind === "builtin" &&
      targetType.name === "object" &&
      (
        sourceType.kind === "object" ||
        sourceType.kind === "named" ||
        sourceType.kind === "array" ||
        sourceType.kind === "function"
      )
    ) {
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

    if (sourceType.kind === "named" && targetType.kind === "named") {
      return this.isNamedTypeStructurallyAssignable(sourceType, targetType);
    }

    if (this.isIntType(sourceType) && this.isNumberType(targetType)) {
      return true;
    }

    if (this.isLongType(sourceType) && this.isBigIntType(targetType)) {
      return true;
    }

    return false;
  }

  private isNamedTypeStructurallyAssignable(
    sourceType: AnalysisType & { kind: "named" },
    targetType: AnalysisType & { kind: "named" }
  ): boolean {
    const targetMembers = this.resolveNamedTypeMembers(targetType);
    if (!targetMembers) {
      return false;
    }
    const sourceMembers = this.resolveNamedTypeMembers(sourceType);
    if (!sourceMembers) {
      return false;
    }
    for (const [propertyName, targetPropertyType] of targetMembers.entries()) {
      const sourcePropertyType = sourceMembers.get(propertyName);
      if (!sourcePropertyType) {
        return false;
      }
      if (!this.isTypeAssignable(sourcePropertyType, targetPropertyType)) {
        return false;
      }
    }
    return true;
  }

  private buildFunctionType(
    parameters: FunctionParameter[],
    returnType: AnalysisType,
    scope: Scope,
    typeParameters: TypeParameter[] = []
  ): AnalysisType {
    return functionType(
      parameters.map((parameter) => ({
        name: parameter.name.name,
        type: parameter.typeAnnotation
          ? this.resolveTypeAnnotation(parameter.typeAnnotation, scope) ?? UNKNOWN_TYPE
          : scope.symbols.get(parameter.name.name)?.type ?? UNKNOWN_TYPE,
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })),
      returnType,
      typeParameters.map((parameter) => parameter.name.name),
      this.typeParameterConstraintMap(typeParameters, scope)
    );
  }

  private typeParameterConstraintMap(
    typeParameters: TypeParameter[],
    scope: Scope
  ): Record<string, AnalysisType> | undefined {
    const constraints: Record<string, AnalysisType> = {};
    for (const typeParameter of typeParameters) {
      if (!typeParameter.constraint) {
        continue;
      }
      constraints[typeParameter.name.name] = this.resolveTypeAnnotation(typeParameter.constraint, scope) ?? UNKNOWN_TYPE;
    }
    return Object.keys(constraints).length > 0 ? constraints : undefined;
  }

  private applyCallArgumentContext(
    call: CallExpression,
    scope: Scope,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): AnalysisType[] {
    let contextualArgumentTypes: AnalysisType[] | undefined;

    for (let index = 0; index < call.arguments.length && index < calleeType.parameters.length; index += 1) {
      const argument = call.arguments[index]!;
      const expectedParameterType = calleeType.parameters[index]?.type;
      const contextualExpectedType = expectedParameterType
        ? this.contextualTypeForExpressionArgument(argument, expectedParameterType)
        : null;
      if (!contextualExpectedType) {
        continue;
      }

      const contextualArgumentType = this.visitExpression(argument, scope, contextualExpectedType);
      if (!contextualArgumentTypes) {
        contextualArgumentTypes = [...argumentTypes];
      }
      contextualArgumentTypes[index] = contextualArgumentType;
    }

    return contextualArgumentTypes ?? argumentTypes;
  }

  private isFunctionLikeExpression(expression: Expr): boolean {
    return expression.kind === "ArrowFunctionExpression" || expression.kind === "FunctionExpression";
  }

  private contextualTypeForExpressionArgument(
    argument: Expr,
    expectedType: AnalysisType
  ): AnalysisType | null {
    if (this.isFunctionLikeExpression(argument)) {
      return expectedType.kind === "function" ? expectedType : null;
    }
    if (argument.kind === "ObjectLiteral") {
      return expectedType.kind === "object" || expectedType.kind === "named" ? expectedType : null;
    }
    if (argument.kind === "ArrayLiteral") {
      return expectedType.kind === "array" || expectedType.kind === "range" ? expectedType : null;
    }
    return null;
  }

  private instantiateFunctionType(
    calleeType: AnalysisType & { kind: "function" },
    explicitTypeArguments: AnalysisType[],
    argumentTypes: AnalysisType[],
    expectedReturnType?: AnalysisType
  ): AnalysisType & { kind: "function" } {
    const typeParameters = calleeType.typeParameters ?? [];
    if (typeParameters.length === 0) {
      return calleeType;
    }

    const substitutions = new Map<string, AnalysisType>();
    const explicitlyProvidedTypeParameters = new Set<string>();
    for (let index = 0; index < typeParameters.length; index += 1) {
      const parameterName = typeParameters[index]!;
      const explicitTypeArgument = explicitTypeArguments[index];
      if (!explicitTypeArgument) {
        continue;
      }
      substitutions.set(parameterName, explicitTypeArgument);
      explicitlyProvidedTypeParameters.add(parameterName);
    }

    const typeParameterSet = new Set(typeParameters);
    for (let index = 0; index < calleeType.parameters.length && index < argumentTypes.length; index += 1) {
      this.inferTypeParameterSubstitutions(
        calleeType.parameters[index]!.type,
        argumentTypes[index]!,
        typeParameterSet,
        explicitlyProvidedTypeParameters,
        substitutions
      );
    }

    if (expectedReturnType && !isUnknownType(expectedReturnType)) {
      this.inferTypeParameterSubstitutions(
        calleeType.returnType,
        expectedReturnType,
        typeParameterSet,
        explicitlyProvidedTypeParameters,
        substitutions
      );
    }

    for (const typeParameter of typeParameters) {
      if (!substitutions.has(typeParameter)) {
        substitutions.set(typeParameter, namedType(typeParameter));
      }
    }

    return this.substituteTypeParameters(calleeType, substitutions) as AnalysisType & { kind: "function" };
  }

  private inferTypeParameterSubstitutions(
    parameterType: AnalysisType,
    argumentType: AnalysisType,
    typeParameters: Set<string>,
    explicitlyProvidedTypeParameters: Set<string>,
    substitutions: Map<string, AnalysisType>
  ): void {
    if (isUnknownType(parameterType) || isUnknownType(argumentType)) {
      return;
    }

    if (parameterType.kind === "named" && typeParameters.has(parameterType.name)) {
      if (explicitlyProvidedTypeParameters.has(parameterType.name)) {
        return;
      }
      this.mergeInferredTypeParameterSubstitution(parameterType.name, argumentType, substitutions);
      return;
    }

    if (parameterType.kind === "array" && argumentType.kind === "array") {
      this.inferTypeParameterSubstitutions(
        parameterType.elementType,
        argumentType.elementType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "range" && argumentType.kind === "range") {
      this.inferTypeParameterSubstitutions(
        parameterType.elementType,
        argumentType.elementType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "named" && argumentType.kind === "named") {
      const parameterTypeArguments = parameterType.typeArguments ?? [];
      const argumentTypeArguments = argumentType.typeArguments ?? [];
      if (parameterType.name !== argumentType.name || parameterTypeArguments.length !== argumentTypeArguments.length) {
        return;
      }
      for (let index = 0; index < parameterTypeArguments.length; index += 1) {
        this.inferTypeParameterSubstitutions(
          parameterTypeArguments[index]!,
          argumentTypeArguments[index]!,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "function" && argumentType.kind === "function") {
      for (let index = 0; index < parameterType.parameters.length && index < argumentType.parameters.length; index += 1) {
        this.inferTypeParameterSubstitutions(
          parameterType.parameters[index]!.type,
          argumentType.parameters[index]!.type,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      this.inferTypeParameterSubstitutions(
        parameterType.returnType,
        argumentType.returnType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "object" && argumentType.kind === "object") {
      for (const [propertyName, nestedParameterType] of Object.entries(parameterType.properties)) {
        const nestedArgumentType = argumentType.properties[propertyName];
        if (!nestedArgumentType) {
          continue;
        }
        this.inferTypeParameterSubstitutions(
          nestedParameterType,
          nestedArgumentType,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
    }
  }

  private mergeInferredTypeParameterSubstitution(
    typeParameter: string,
    inferredType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): void {
    const previousType = substitutions.get(typeParameter);
    if (!previousType) {
      substitutions.set(typeParameter, inferredType);
      return;
    }

    if (this.isTypeAssignable(inferredType, previousType)) {
      return;
    }

    if (this.isTypeAssignable(previousType, inferredType)) {
      substitutions.set(typeParameter, inferredType);
    }
  }

  private validateFunctionTypeArgumentConstraints(
    genericType: AnalysisType & { kind: "function" },
    instantiatedType: AnalysisType & { kind: "function" },
    node: Node
  ): void {
    const typeParameters = genericType.typeParameters ?? [];
    const constraints = genericType.typeParameterConstraints;
    if (!constraints || typeParameters.length === 0) {
      return;
    }
    const substitutions = new Map<string, AnalysisType>();
    for (const typeParameter of typeParameters) {
      substitutions.set(typeParameter, namedType(typeParameter));
    }
    this.inferTypeParameterSubstitutions(
      genericType,
      instantiatedType,
      new Set(typeParameters),
      new Set(),
      substitutions
    );
    for (const typeParameter of typeParameters) {
      const constraint = constraints[typeParameter];
      const typeArgument = substitutions.get(typeParameter);
      if (!constraint || !typeArgument) {
        continue;
      }
      this.validateTypeArgumentConstraint(
        typeParameter,
        typeArgument,
        this.substituteTypeParameters(constraint, substitutions),
        node
      );
    }
  }


  private callableTypeFrom(type: AnalysisType): (AnalysisType & { kind: "function" }) | null {
    if (type.kind === "function") {
      return type;
    }
    if (type.kind !== "union") {
      return null;
    }
    const callableMembers = type.types.filter((member): member is AnalysisType & { kind: "function" } => member.kind === "function");
    return callableMembers[0] ?? null;
  }

  private hasNullishUnionMember(type: AnalysisType): boolean {
    return type.kind === "union" && type.types.some((member) => this.isNullishType(member));
  }

  private validateCallArguments(
    call: CallExpression,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): void {
    const lastParameter = calleeType.parameters[calleeType.parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? calleeType.parameters.slice(0, -1) : calleeType.parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    const providedCount = argumentTypes.length;
    const totalCount = fixedParameters.length;

    if (providedCount < requiredCount) {
      this.issues.push({
        message: `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
        node: call
      });
    } else if (!restParameter && providedCount > totalCount) {
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

    const comparableCount = restParameter ? providedCount : Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const argumentExpression = call.arguments[index];
      const parameter = fixedParameters[index] ?? restParameter;
      if (!parameter) {
        continue;
      }
      const argumentType = argumentTypes[index]!;
      const expectedType = restParameter && index >= fixedParameters.length
        ? this.restParameterElementType(restParameter.type)
        : parameter.type;
      const comparableArgumentType = argumentExpression?.kind === "SpreadExpression"
        ? this.spreadArgumentElementType(argumentType)
        : argumentType;
      if (isUnknownType(expectedType) || isUnknownType(comparableArgumentType)) {
        continue;
      }
      if (this.isTypeAssignable(comparableArgumentType, expectedType)) {
        continue;
      }

      this.issues.push({
        message: `Argument ${index + 1} of type '${typeToString(comparableArgumentType)}' is not assignable to parameter '${parameter.name}' of type '${typeToString(expectedType)}'`,
        node: argumentExpression ?? call
      });
      if (argumentExpression) {
        this.reportNestedMismatchContext(comparableArgumentType, expectedType, argumentExpression);
      }
    }
  }

  private restParameterElementType(restParameterType: AnalysisType): AnalysisType {
    if (restParameterType.kind === "array") {
      return restParameterType.elementType;
    }
    if (restParameterType.kind === "named" && restParameterType.name === "Array" && restParameterType.typeArguments?.[0]) {
      return restParameterType.typeArguments[0];
    }
    return restParameterType;
  }

  private spreadArgumentElementType(argumentType: AnalysisType): AnalysisType {
    if (argumentType.kind === "array") {
      return argumentType.elementType;
    }
    if (argumentType.kind === "tuple") {
      return argumentType.elements.length === 1 ? argumentType.elements[0]! : unionType(argumentType.elements);
    }
    if (argumentType.kind === "named" && argumentType.name === "Array" && argumentType.typeArguments?.[0]) {
      return argumentType.typeArguments[0];
    }
    return UNKNOWN_TYPE;
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
    return this.resolveTypeNameText(typeNameIdentifier.name, typeNameIdentifier, scope, true);
  }

  private resolveTypeNameText(
    typeName: string,
    node: Node,
    scope: Scope,
    captureResolution: boolean
  ): AnalysisType {
    const normalizedTypeName = stripEnclosingTypeParens(typeName);
    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) =>
        this.resolveTypeNameText(part, node, scope, false)
      ));
    }

    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) =>
        this.resolveTypeNameText(part, node, scope, false)
      ));
    }

    const tupleTypeMatch = /^\[(.*)\]$/.exec(normalizedTypeName);
    if (tupleTypeMatch) {
      const tupleBody = tupleTypeMatch[1] ?? "";
      const elements = tupleBody.trim().length === 0
        ? []
        : splitTopLevelTypeText(tupleBody, ",").map((part) =>
            this.resolveTypeNameText(part, node, scope, false)
          );
      return tupleType(elements);
    }

    const literal = this.resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }

    const functionAnnotation = this.resolveFunctionTypeAnnotation(normalizedTypeName, node, scope);
    if (functionAnnotation) {
      return functionAnnotation;
    }
    if (this.looksLikeFunctionTypeAnnotation(normalizedTypeName)) {
      return UNKNOWN_TYPE;
    }

    const objectAnnotation = this.resolveObjectTypeAnnotation(normalizedTypeName, node, scope);
    if (objectAnnotation) {
      return objectAnnotation;
    }

    const parsed = parseTypeNameShape(normalizedTypeName);
    let resolvedBase: AnalysisType;

    const resolvedTypeArguments = parsed.typeArguments.map((typeArgument) =>
      this.resolveTypeNameText(typeArgument, node, scope, false)
    );

    if (TypeChecker.BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else if (this.isActiveTypeParameter(parsed.baseName)) {
      resolvedBase = namedType(parsed.baseName);
    } else {
      const symbol = this.resolve(parsed.baseName, scope, undefined);
      const typeAlias = this.typeAliasStatementsByName.get(parsed.baseName);
      if (symbol && (symbol.kind === "class" || symbol.kind === "variable")) {
        if (captureResolution && node.kind === "Identifier") {
          this.identifierResolutions.push({
            identifier: node as Node & { kind: "Identifier"; name: string },
            symbol
          });
        }
        this.validateNamedTypeArgumentConstraints(
          parsed.baseName,
          resolvedTypeArguments,
          node,
          scope
        );
        if (typeAlias) {
          resolvedBase = this.resolveTypeAliasTarget(typeAlias, resolvedTypeArguments, scope);
        } else {
          resolvedBase = namedType(parsed.baseName, resolvedTypeArguments);
        }
      } else {
        this.issues.push({
          message: `Unknown type '${normalizedTypeName}'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter`,
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


  private resolveLiteralTypeName(typeName: string): AnalysisType | null {
    if ((typeName.startsWith("\"") && typeName.endsWith("\"")) || (typeName.startsWith("'") && typeName.endsWith("'"))) {
      return literalType("string", typeName.slice(1, -1));
    }
    if (typeName === "true") {
      return literalType("boolean", true);
    }
    if (typeName === "false") {
      return literalType("boolean", false);
    }
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(typeName)) {
      return literalType("number", Number(typeName));
    }
    return null;
  }


  private validateNamedTypeArgumentConstraints(
    typeName: string,
    typeArguments: AnalysisType[],
    node: Node,
    scope: Scope
  ): void {
    if (typeArguments.length === 0) {
      return;
    }
    const typeParameters = this.typeParametersForNamedType(typeName);
    if (!typeParameters || typeParameters.length === 0) {
      return;
    }
    this.validateTypeParameterConstraints(typeParameters, typeArguments, node, scope);
  }

  private typeParametersForNamedType(typeName: string): TypeParameter[] | null {
    return this.classStatementsByName.get(typeName)?.typeParameters
      ?? this.interfaceStatementsByName.get(typeName)?.typeParameters
      ?? this.typeAliasStatementsByName.get(typeName)?.typeParameters
      ?? null;
  }

  private validateTypeParameterConstraints(
    typeParameters: TypeParameter[],
    typeArguments: AnalysisType[],
    node: Node,
    scope: Scope
  ): void {
    const typeParameterNames = typeParameters.map((typeParameter) => typeParameter.name.name);
    const substitutions = new Map<string, AnalysisType>();
    for (let index = 0; index < typeParameters.length; index += 1) {
      const typeParameterName = typeParameters[index]?.name.name;
      if (!typeParameterName) {
        continue;
      }
      substitutions.set(typeParameterName, typeArguments[index] ?? namedType(typeParameterName));
    }

    this.withTypeParameters(typeParameterNames, () => {
      for (let index = 0; index < typeParameters.length && index < typeArguments.length; index += 1) {
        const typeParameter = typeParameters[index]!;
        if (!typeParameter.constraint) {
          continue;
        }
        const typeArgument = typeArguments[index]!;
        const rawConstraint = this.resolveTypeAnnotation(typeParameter.constraint, scope) ?? UNKNOWN_TYPE;
        const constraint = this.substituteTypeParameters(rawConstraint, substitutions);
        this.validateTypeArgumentConstraint(
          typeParameter.name.name,
          typeArgument,
          constraint,
          node
        );
      }
    });
  }

  private validateTypeArgumentConstraint(
    typeParameterName: string,
    typeArgument: AnalysisType,
    constraint: AnalysisType,
    node: Node
  ): void {
    if (isUnknownType(typeArgument) || isUnknownType(constraint)) {
      return;
    }
    if (this.isTypeAssignable(typeArgument, constraint)) {
      return;
    }
    this.issues.push({
      message: `Type argument '${typeToString(typeArgument)}' does not satisfy constraint '${typeToString(constraint)}' for type parameter '${typeParameterName}'`,
      node
    });
  }

  private resolveTypeAliasTarget(
    typeAlias: TypeAliasStatement,
    typeArguments: AnalysisType[],
    scope: Scope
  ): AnalysisType {
    if (this.activeTypeAliasNames.has(typeAlias.name.name)) {
      return namedType(typeAlias.name.name, typeArguments);
    }

    const substitutions = new Map<string, AnalysisType>();
    const typeParameters = typeAlias.typeParameters ?? [];
    for (let index = 0; index < typeParameters.length; index += 1) {
      const parameterName = typeParameters[index]?.name.name;
      if (!parameterName) {
        continue;
      }
      substitutions.set(parameterName, typeArguments[index] ?? namedType(parameterName));
    }

    this.activeTypeAliasNames.add(typeAlias.name.name);
    let targetType: AnalysisType = UNKNOWN_TYPE;
    this.withTypeParameters(typeParameters.map((parameter) => parameter.name.name), () => {
      targetType = this.resolveTypeNameText(typeAlias.targetType.name, typeAlias.targetType, scope, false);
    });
    this.activeTypeAliasNames.delete(typeAlias.name.name);

    return this.substituteTypeParameters(targetType, substitutions);
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
    if (expression.kind === "Identifier") {
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
      return;
    }

    if (expression.kind !== "MemberExpression") {
      return;
    }

    const member = expression as MemberExpression;
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const objectType = this.inferSimpleObjectType(member.object, scope);
    if (!objectType || objectType.kind !== "named") {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    const classStatement = this.classStatementsByName.get(objectType.name);
    const classField = classStatement?.members.find(
      (candidate): candidate is ClassFieldMember =>
        candidate.kind === "ClassFieldMember" && candidate.name.name === propertyName
    );
    if (!classField || classField.readonly !== true) {
      return;
    }
    if (member.object.kind === "Identifier" && (member.object as Identifier).name === "this" && this.enclosingMethodName(scope) === "constructor") {
      return;
    }

    this.issues.push({
      message: `Cannot assign to readonly member '${propertyName}'`,
      node: member.property
    });
  }

  private inferSimpleObjectType(expression: Expr, scope: Scope): AnalysisType | null {
    if (expression.kind !== "Identifier") {
      return null;
    }

    const identifier = expression as Identifier;
    const symbol = this.resolve(identifier.name, scope, identifier.firstToken?.range.start.offset);
    return symbol?.type ?? null;
  }

  private enclosingMethodName(scope: Scope): string | null {
    let current: Scope | undefined = scope;
    while (current) {
      if (current.node.kind === "ClassMethodMember") {
        return (current.node as ClassMethodMember).name.name;
      }
      current = current.parent;
    }
    return null;
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

  private createFunctionLikeExpressionScope(
    parentScope: Scope,
    node: Node,
    parameters: FunctionParameter[],
    expectedFunctionType?: AnalysisType & { kind: "function" }
  ): Scope {
    const functionScope: Scope = {
      parent: parentScope,
      node,
      symbols: new Map<string, AnalysisSymbol>(),
      children: []
    };
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      const expectedParameterType = expectedFunctionType?.parameters[index]?.type;
      const parameterType =
        this.resolveTypeAnnotation(parameter.typeAnnotation, functionScope) ??
        expectedParameterType ??
        (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, functionScope) : UNKNOWN_TYPE);
      functionScope.symbols.set(parameter.name.name, {
        name: parameter.name.name,
        kind: "parameter",
        node: parameter.name,
        declaredOffset: parameter.name.firstToken?.range.start.offset ?? -1,
        type: parameterType,
        valueType: typeToString(parameterType)
      });
    }
    return functionScope;
  }

  private isIntType(type: AnalysisType): boolean {
    return (type.kind === "builtin" && type.name === "int") ||
      (type.kind === "literal" && type.base === "number" && Number.isInteger(type.value));
  }

  private isStringLikeType(type: AnalysisType): boolean {
    return (type.kind === "builtin" && type.name === "string") ||
      (type.kind === "literal" && type.base === "string");
  }

  private isBigIntType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "bigint";
  }

  private isLongType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "long";
  }

  private isNumberType(type: AnalysisType): boolean {
    return (type.kind === "builtin" && (type.name === "int" || type.name === "number")) ||
      (type.kind === "literal" && type.base === "number");
  }

  private contextualLiteralType(literal: AnalysisType, expectedType?: AnalysisType): AnalysisType | null {
    if (!expectedType || literal.kind !== "literal") {
      return null;
    }
    if (expectedType.kind === "literal" && this.isTypeAssignable(literal, expectedType)) {
      return expectedType;
    }
    if (expectedType.kind === "union") {
      return expectedType.types.find((member) => member.kind === "literal" && this.isTypeAssignable(literal, member)) ?? null;
    }
    return null;
  }


  private inferArrayLiteralType(
    arrayLiteral: ArrayLiteral,
    scope: Scope,
    expectedType?: AnalysisType
  ): AnalysisType {
    if (expectedType?.kind === "tuple") {
      return tupleType(arrayLiteral.elements.map((element, index) =>
        this.visitExpression(element, scope, expectedType.elements[index])
      ));
    }

    let inferredElementType: AnalysisType | undefined;
    const expectedElementType = this.expectedArrayElementType(expectedType);

    for (const element of arrayLiteral.elements) {
      const visitedType = this.visitExpression(element, scope, expectedElementType);
      const currentType = element.kind === "SpreadExpression"
        ? this.spreadArgumentElementType(visitedType)
        : visitedType;
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

  private inferObjectLiteralType(
    objectLiteral: ObjectLiteral,
    scope: Scope,
    expectedType?: AnalysisType
  ): AnalysisType {
    if (objectLiteral.properties.length === 0) {
      return objectType();
    }

    const expectedProperties = this.expectedObjectProperties(expectedType);
    const properties: Record<string, AnalysisType> = {};
    for (const property of objectLiteral.properties) {
      if (property.kind === "ObjectSpreadProperty") {
        const spreadType = this.visitExpression((property as ObjectSpreadProperty).argument, scope);
        if (spreadType.kind === "object") {
          Object.assign(properties, spreadType.properties);
          continue;
        }
        if (spreadType.kind === "named") {
          const namedProperties = this.resolveNamedTypeMembers(spreadType);
          if (namedProperties) {
            for (const [name, type] of namedProperties) {
              properties[name] = type;
            }
          }
          continue;
        }
        if (!isUnknownType(spreadType) && !(spreadType.kind === "builtin" && spreadType.name === "object")) {
          this.issues.push({
            message: `Spread types may only be created from object types; got '${typeToString(spreadType)}'`,
            node: property
          });
        }
        continue;
      }

      const objectProperty = property as ObjectProperty;
      if (objectProperty.computed) {
        this.visitExpression(objectProperty.key, scope);
      }
      const propertyName = this.staticObjectPropertyName(objectProperty);
      const propertyType = this.visitExpression(
        objectProperty.value,
        scope,
        propertyName ? expectedProperties?.get(propertyName) : undefined
      );
      if (propertyName) {
        properties[propertyName] = propertyType;
      }
    }
    return objectTypeWithProperties(properties);
  }

  private staticObjectPropertyName(property: ObjectProperty): string | undefined {
    if (property.computed) {
      return undefined;
    }
    if (property.key.kind === "Identifier") {
      return (property.key as Identifier).name;
    }
    if (property.key.kind === "StringLiteral") {
      return (property.key as StringLiteral).value;
    }
    if (property.key.kind === "IntLiteral") {
      return String((property.key as IntLiteral | FloatLiteral).value);
    }
    if (property.key.kind === "FloatLiteral") {
      return String((property.key as IntLiteral | FloatLiteral).value);
    }
    return undefined;
  }

  private expectedArrayElementType(expectedType: AnalysisType | undefined): AnalysisType | undefined {
    if (!expectedType || isUnknownType(expectedType)) {
      return undefined;
    }
    if (expectedType.kind === "array") {
      return expectedType.elementType;
    }
    if (expectedType.kind === "range") {
      return expectedType.elementType;
    }
    return undefined;
  }

  private expectedObjectProperties(
    expectedType: AnalysisType | undefined
  ): Map<string, AnalysisType> | undefined {
    if (!expectedType || isUnknownType(expectedType)) {
      return undefined;
    }
    if (expectedType.kind === "object") {
      return new Map(Object.entries(expectedType.properties));
    }
    if (expectedType.kind === "named") {
      return this.resolveNamedTypeMembers(expectedType) ?? undefined;
    }
    return undefined;
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

  private collectTypeAliasStatements(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "TypeAliasStatement") {
        continue;
      }
      const typeAliasStatement = statement as TypeAliasStatement;
      this.typeAliasStatementsByName.set(typeAliasStatement.name.name, typeAliasStatement);
    }
  }


  private resolveOptionalAccessType(type: AnalysisType, optional: boolean): AnalysisType {
    if (!optional || isUnknownType(type)) {
      return type;
    }
    if (type.kind === "union" && type.types.some((member) => member.kind === "builtin" && member.name === "undefined")) {
      return type;
    }
    return unionType([type, builtinType("undefined")]);
  }

  private validateKnownMemberAccess(member: MemberExpression, objectType: AnalysisType, scope: Scope): void {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const knownMembers = this.membersForType(objectType);
    if (!knownMembers) {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    if (knownMembers.has(propertyName)) {
      this.validateMemberVisibility(member, objectType, propertyName, scope);
      return;
    }

    const displayType = objectType.kind === "named" ? objectType.name : typeToString(objectType);
    this.issues.push({
      message: `Property '${propertyName}' does not exist on type '${displayType}'`,
      node: member.property
    });
  }

  private validateMemberVisibility(member: MemberExpression, objectType: AnalysisType, propertyName: string, scope: Scope): void {
    if (objectType.kind !== "named") {
      return;
    }

    const classMember = this.findClassMember(objectType.name, propertyName);
    if (!classMember?.member.accessModifier || classMember.member.accessModifier === "public") {
      return;
    }

    const currentClassName = this.enclosingClassName(scope);
    if (classMember.member.accessModifier === "private") {
      if (currentClassName === classMember.declaringClassName) {
        return;
      }
      this.issues.push({
        message: `Member '${propertyName}' is private and can only be accessed within class '${classMember.declaringClassName}'`,
        node: member.property
      });
      return;
    }

    if (
      currentClassName === classMember.declaringClassName ||
      (currentClassName !== null && this.isClassDerivedFrom(currentClassName, classMember.declaringClassName))
    ) {
      return;
    }

    this.issues.push({
      message: `Member '${propertyName}' is protected and can only be accessed within class '${classMember.declaringClassName}' or its subclasses`,
      node: member.property
    });
  }

  private findClassMember(className: string, memberName: string): { member: ClassFieldMember | ClassMethodMember; declaringClassName: string } | null {
    const classStatement = this.classStatementsByName.get(className);
    if (!classStatement) {
      return null;
    }
    for (const member of classStatement.members) {
      if (member.name.name === memberName) {
        return { member, declaringClassName: className };
      }
    }
    if (!classStatement.extendsType) {
      return null;
    }
    const extendsType = this.typeFromTypeNameLoose(classStatement.extendsType.name);
    if (extendsType.kind !== "named") {
      return null;
    }
    return this.findClassMember(extendsType.name, memberName);
  }

  private enclosingClassName(scope: Scope): string | null {
    let current: Scope | undefined = scope;
    while (current) {
      if (current.node.kind === "ClassStatement") {
        return (current.node as ClassStatement).name.name;
      }
      current = current.parent;
    }
    return null;
  }

  private isClassDerivedFrom(className: string, baseClassName: string): boolean {
    let current = this.classStatementsByName.get(className);
    const visited = new Set<string>();
    while (current?.extendsType) {
      const extendsType = this.typeFromTypeNameLoose(current.extendsType.name);
      if (extendsType.kind !== "named" || visited.has(extendsType.name)) {
        return false;
      }
      if (extendsType.name === baseClassName) {
        return true;
      }
      visited.add(extendsType.name);
      current = this.classStatementsByName.get(extendsType.name);
    }
    return false;
  }

  private resolveKnownMemberType(member: MemberExpression, objectType: AnalysisType): AnalysisType | null {
    if (member.computed || member.property.kind !== "Identifier") {
      return null;
    }

    const memberName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    if (objectType.kind === "union") {
      const memberTypes = objectType.types
        .filter((type) => !this.isNullishType(type))
        .map((type) => this.resolveKnownMemberType(member, type))
        .filter((type): type is AnalysisType => type !== null);
      if (memberTypes.length === 0) {
        return null;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (objectType.kind === "object") {
      return objectType.properties[memberName] ?? null;
    }
    if (objectType.kind === "array") {
      const arrayMembers = this.membersForArrayAlias(objectType);
      if (!arrayMembers) {
        return null;
      }
      return arrayMembers.get(memberName) ?? null;
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
    if (objectType.kind === "union") {
      const memberTypes = objectType.types
        .filter((type) => !this.isNullishType(type))
        .map((type) => this.resolveComputedMemberType(type, propertyType))
        .filter((type) => !isUnknownType(type));
      if (memberTypes.length === 0) {
        return UNKNOWN_TYPE;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (objectType.kind === "array" && this.isIntType(propertyType)) {
      return objectType.elementType;
    }
    if (objectType.kind === "range" && this.isIntType(propertyType)) {
      return objectType.elementType;
    }
    return UNKNOWN_TYPE;
  }

  private isNullishType(type: AnalysisType): boolean {
    return type.kind === "builtin" && (type.name === "null" || type.name === "undefined");
  }

  private membersForType(type: AnalysisType): Map<string, AnalysisType> | null {
    if (type.kind === "union") {
      const merged = new Map<string, AnalysisType>();
      for (const memberType of type.types.filter((member) => !this.isNullishType(member))) {
        const members = this.membersForType(memberType);
        if (!members) {
          return null;
        }
        for (const [memberName, memberValueType] of members.entries()) {
          merged.set(memberName, memberValueType);
        }
      }
      return merged.size > 0 ? merged : null;
    }
    if (type.kind === "object") {
      return new Map(Object.entries(type.properties));
    }
    if (type.kind === "array") {
      return this.membersForArrayAlias(type);
    }
    if (type.kind === "named") {
      return this.resolveNamedTypeMembers(type);
    }
    return null;
  }

  private membersForArrayAlias(type: AnalysisType & { kind: "array" }): Map<string, AnalysisType> | null {
    if (!this.classStatementsByName.has("Array") && !this.interfaceStatementsByName.has("Array")) {
      return null;
    }
    return this.resolveNamedTypeMembers(namedType("Array", [type.elementType]));
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

        const returnType = this.typeFromAnnotationLoose(classMember.returnType) ?? builtinType("void");
        members.set(
          classMember.name.name,
          this.substituteTypeParameters(functionType(
            classMember.parameters.map((parameter) => ({
              name: parameter.name.name,
              type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
              optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
              rest: parameter.rest === true
            })),
            returnType,
            classMember.typeParameters?.map((parameter) => parameter.name.name)
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

      const returnType = this.typeFromAnnotationLoose(interfaceMember.returnType) ?? builtinType("void");
      members.set(
        interfaceMember.name.name,
        this.substituteTypeParameters(functionType(
          interfaceMember.parameters.map((parameter) => ({
            name: parameter.name.name,
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
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

  private validateImplementedInterfaces(classStatement: ClassStatement): void {
    const classTypeArguments = (classStatement.typeParameters ?? []).map((typeParameter) =>
      namedType(typeParameter.name.name)
    );
    const classType = namedType(classStatement.name.name, classTypeArguments);
    const classMembers = this.resolveNamedTypeMembers(classType);
    if (!classMembers) {
      return;
    }

    for (const implementedType of classStatement.implementsTypes ?? []) {
      const resolvedImplementedType = this.typeFromTypeNameLoose(implementedType.name);
      if (resolvedImplementedType.kind !== "named") {
        continue;
      }

      const interfaceStatement = this.interfaceStatementsByName.get(resolvedImplementedType.name);
      if (!interfaceStatement) {
        continue;
      }

      const interfaceMembers = this.resolveNamedTypeMembers(resolvedImplementedType);
      if (!interfaceMembers) {
        continue;
      }

      for (const [memberName, expectedType] of interfaceMembers.entries()) {
        const classMemberType = classMembers.get(memberName);
        if (!classMemberType) {
          this.issues.push({
            message: `Class '${classStatement.name.name}' incorrectly implements interface '${resolvedImplementedType.name}'. Property '${memberName}' is missing`,
            node: classStatement.name,
            code: ANALYSIS_ISSUE_CODES.IMPLEMENTS_MISSING_MEMBER,
            data: {
              className: classStatement.name.name,
              interfaceName: resolvedImplementedType.name,
              memberName
            }
          });
          continue;
        }

        if (this.isTypeAssignable(classMemberType, expectedType)) {
          continue;
        }

        const memberNode = this.findOwnClassMemberNameNode(classStatement, memberName);
        const actualType = this.typeToDiagnosticLabel(classMemberType);
        const expected = this.typeToDiagnosticLabel(expectedType);
        this.issues.push({
          message: `Class '${classStatement.name.name}' incorrectly implements interface '${resolvedImplementedType.name}'. Property '${memberName}' is of type '${actualType}' but expected '${expected}'`,
          node: memberNode ?? classStatement.name,
          code: ANALYSIS_ISSUE_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER,
          data: {
            className: classStatement.name.name,
            interfaceName: resolvedImplementedType.name,
            memberName,
            actualType,
            expectedType: expected
          }
        });
      }
    }
  }

  private findOwnClassMemberNameNode(
    classStatement: ClassStatement,
    memberName: string
  ): Identifier | null {
    for (const parameter of classStatement.primaryConstructorParameters ?? []) {
      if (parameter.name.name === memberName) {
        return parameter.name;
      }
    }
    for (const member of classStatement.members) {
      if (member.name.name === memberName) {
        return member.name;
      }
    }
    return null;
  }

  private declaredClassMemberType(
    classStatement: ClassStatement,
    memberName: string,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType | null {
    for (const classMember of classStatement.members) {
      if (classMember.name.name !== memberName) {
        continue;
      }

      if (classMember.kind === "ClassFieldMember") {
        const fieldType = this.typeFromAnnotationLoose(classMember.typeAnnotation) ?? UNKNOWN_TYPE;
        return this.substituteTypeParameters(fieldType, substitutions);
      }

      const returnType = this.typeFromAnnotationLoose(classMember.returnType) ?? builtinType("void");
      return this.substituteTypeParameters(functionType(
        classMember.parameters.map((parameter) => ({
          name: parameter.name.name,
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        returnType,
        classMember.typeParameters?.map((parameter) => parameter.name.name)
      ), substitutions);
    }

    return null;
  }

  private validateOverrideMembers(classStatement: ClassStatement): void {
    const overrideMembers = classStatement.members.filter((member) => member.override === true);
    if (overrideMembers.length === 0) {
      return;
    }

    if (!classStatement.extendsType) {
      for (const member of overrideMembers) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot use 'override' because class '${classStatement.name.name}' does not extend another class`,
          node: member.name
        });
      }
      return;
    }

    const classTypeArguments = (classStatement.typeParameters ?? []).map((typeParameter) =>
      namedType(typeParameter.name.name)
    );
    const classType = namedType(classStatement.name.name, classTypeArguments);
    const classSubstitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], classType);
    const extendsType = this.substituteTypeParameters(
      this.typeFromTypeNameLoose(classStatement.extendsType.name),
      classSubstitutions
    );
    if (extendsType.kind !== "named") {
      return;
    }

    const baseMembers = this.resolveNamedTypeMembers(extendsType);
    if (!baseMembers) {
      return;
    }

    for (const member of overrideMembers) {
      const ownType = this.declaredClassMemberType(classStatement, member.name.name, classSubstitutions);
      if (!ownType) {
        continue;
      }
      const baseType = baseMembers.get(member.name.name);
      if (!baseType) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot override because no member with that name exists in base type '${typeToString(extendsType)}'`,
          node: member.name
        });
        continue;
      }
      if (isSameType(ownType, baseType)) {
        continue;
      }
      this.issues.push({
        message: `Member '${member.name.name}' override type '${this.typeToDiagnosticLabel(ownType)}' does not match base type '${this.typeToDiagnosticLabel(baseType)}'`,
        node: member.name
      });
    }
  }

  private typeToDiagnosticLabel(type: AnalysisType): string {
    if (type.kind !== "function") {
      return typeToString(type);
    }

    const parameters = type.parameters
      .map((parameter) =>
        `${parameter.name}${parameter.optional === true ? "?" : ""}: ${this.typeToDiagnosticLabel(parameter.type)}`
      )
      .join(", ");
    return `(${parameters}) => ${this.typeToDiagnosticLabel(type.returnType)}`;
  }

  private typeFromAnnotationLoose(
    typeAnnotation: (Node & { kind: "Identifier"; name: string }) | undefined
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    const functionType = this.functionTypeFromAnnotationText(typeAnnotation.name);
    if (functionType) {
      return functionType;
    }
    if (this.looksLikeFunctionTypeAnnotation(typeAnnotation.name)) {
      return UNKNOWN_TYPE;
    }
    const objectType = this.objectTypeFromAnnotationText(typeAnnotation.name);
    if (objectType) {
      return objectType;
    }
    const parsed = parseTypeNameShape(typeAnnotation.name);
    let resolvedBase: AnalysisType;
    if (TypeChecker.BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as BuiltinTypeName
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
    return this.expandTypeAliases(resolved);
  }

  private typeFromTypeNameLoose(typeName: string): AnalysisType {
    const functionType = this.functionTypeFromAnnotationText(typeName);
    if (functionType) {
      return functionType;
    }
    if (this.looksLikeFunctionTypeAnnotation(typeName)) {
      return UNKNOWN_TYPE;
    }
    const objectType = this.objectTypeFromAnnotationText(typeName);
    if (objectType) {
      return objectType;
    }
    const parsed = parseTypeNameShape(typeName);
    let resolved: AnalysisType;
    if (TypeChecker.BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolved = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else {
      resolved = namedType(
        parsed.baseName,
        parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
      );
    }
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return this.expandTypeAliases(resolved);
  }

  private expandTypeAliases(type: AnalysisType): AnalysisType {
    if (type.kind === "named") {
      const typeAlias = this.typeAliasStatementsByName.get(type.name);
      if (!typeAlias || this.activeTypeAliasNames.has(type.name)) {
        if (!type.typeArguments || type.typeArguments.length === 0) {
          return type;
        }
        return namedType(
          type.name,
          type.typeArguments.map((typeArgument) => this.expandTypeAliases(typeArgument))
        );
      }
      const substitutions = this.typeParameterSubstitutions(typeAlias.typeParameters ?? [], type);
      this.activeTypeAliasNames.add(type.name);
      const targetType = this.typeFromTypeNameLoose(typeAlias.targetType.name);
      this.activeTypeAliasNames.delete(type.name);
      return this.expandTypeAliases(this.substituteTypeParameters(targetType, substitutions));
    }

    if (type.kind === "array") {
      return arrayType(this.expandTypeAliases(type.elementType));
    }

    if (type.kind === "range") {
      return rangeType(this.expandTypeAliases(type.elementType));
    }

    if (type.kind === "function") {
      return functionType(
        type.parameters.map((parameter) => ({
          name: parameter.name,
          type: this.expandTypeAliases(parameter.type),
          ...(parameter.optional !== undefined ? { optional: parameter.optional } : {})
        })),
        this.expandTypeAliases(type.returnType),
        type.typeParameters,
        type.typeParameterConstraints
      );
    }

    if (type.kind === "object") {
      const properties: Record<string, AnalysisType> = {};
      for (const [name, propertyType] of Object.entries(type.properties)) {
        properties[name] = this.expandTypeAliases(propertyType);
      }
      return objectTypeWithProperties(properties);
    }

    return type;
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
        this.substituteTypeParameters(sourceType.returnType, substitutions),
        sourceType.typeParameters,
        sourceType.typeParameterConstraints
      );
    }

    return sourceType;
  }

  private resolveFunctionTypeAnnotation(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const parsed = this.parseFunctionTypeAnnotation(typeName);
    if (!parsed) {
      return null;
    }
    return functionType(
      parsed.parameters.map((parameter) => ({
        name: parameter.name,
        type: this.resolveTypeNameText(parameter.typeName, node, scope, false),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      this.resolveTypeNameText(parsed.returnTypeName, node, scope, false)
    );
  }

  private resolveObjectTypeAnnotation(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const members = this.parseObjectTypeAnnotation(typeName);
    if (!members) {
      return null;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const member of members) {
      const propertyType = this.resolveTypeNameText(member.typeName, node, scope, false);
      properties[member.name] = member.optional
        ? unionType([propertyType, builtinType("undefined")])
        : propertyType;
    }
    return objectTypeWithProperties(properties);
  }

  private functionTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const parsed = this.parseFunctionTypeAnnotation(typeName);
    if (!parsed) {
      return null;
    }
    return functionType(
      parsed.parameters.map((parameter) => ({
        name: parameter.name,
        type: this.typeFromTypeNameLoose(parameter.typeName),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      this.typeFromTypeNameLoose(parsed.returnTypeName)
    );
  }

  private objectTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const members = this.parseObjectTypeAnnotation(typeName);
    if (!members) {
      return null;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const member of members) {
      const propertyType = this.typeFromTypeNameLoose(member.typeName);
      properties[member.name] = member.optional
        ? unionType([propertyType, builtinType("undefined")])
        : propertyType;
    }
    return objectTypeWithProperties(properties);
  }

  private parseFunctionTypeAnnotation(typeName: string): {
    parameters: Array<{ name: string; typeName: string; optional?: boolean; rest?: boolean }>;
    returnTypeName: string;
  } | null {
    const trimmed = typeName.trim();
    if (!trimmed.startsWith("(")) {
      return null;
    }

    const closeParenIndex = this.findMatchingDelimiter(trimmed, 0, "(", ")");
    if (closeParenIndex < 0) {
      return null;
    }
    const afterParameters = trimmed.slice(closeParenIndex + 1).trimStart();
    if (!afterParameters.startsWith("=>")) {
      return null;
    }

    const parameterBody = trimmed.slice(1, closeParenIndex).trim();
    const parameters = parameterBody.length === 0
      ? []
      : this.splitTopLevelDelimitedText(parameterBody).map((part, index) => {
          let text = part.trim();
          let rest = false;
          if (text.startsWith("...")) {
            rest = true;
            text = text.slice(3).trim();
          }

          const colonIndex = this.findTopLevelCharacter(text, ":");
          if (colonIndex < 0) {
            return {
              name: `arg${index + 1}`,
              typeName: text.length > 0 ? text : "unknown",
              ...(rest ? { rest: true } : {})
            };
          }

          let name = text.slice(0, colonIndex).trim();
          const typeName = text.slice(colonIndex + 1).trim();
          let optional = false;
          if (name.endsWith("?")) {
            optional = true;
            name = name.slice(0, -1).trim();
          }
          return {
            name: name.length > 0 ? name : `arg${index + 1}`,
            typeName: typeName.length > 0 ? typeName : "unknown",
            ...(optional ? { optional: true } : {}),
            ...(rest ? { rest: true } : {})
          };
        });

    return {
      parameters,
      returnTypeName: afterParameters.slice(2).trim()
    };
  }

  private parseObjectTypeAnnotation(typeName: string): Array<{ name: string; typeName: string; optional?: boolean }> | null {
    const trimmed = typeName.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }

    const body = trimmed.slice(1, -1).trim();
    if (body.length === 0) {
      return [];
    }

    return this.splitTopLevelDelimitedText(body, new Set([",", ";"])).map((part) => {
      const colonIndex = this.findTopLevelCharacter(part, ":");
      if (colonIndex < 0) {
        return { name: part.trim(), typeName: "unknown" };
      }
      let name = part.slice(0, colonIndex).trim();
      const typeName = part.slice(colonIndex + 1).trim();
      let optional = false;
      if (name.endsWith("?")) {
        optional = true;
        name = name.slice(0, -1).trim();
      }
      if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
        name = name.slice(1, -1);
      }
      return {
        name,
        typeName: typeName.length > 0 ? typeName : "unknown",
        ...(optional ? { optional: true } : {})
      };
    });
  }

  private splitTopLevelDelimitedText(text: string, delimiters: Set<string> = new Set([","])): string[] {
    const parts: string[] = [];
    let current = "";
    let angleDepth = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let quote: string | null = null;

    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index]!;
      const previous = index > 0 ? text[index - 1] : "";
      if (quote) {
        current += ch;
        if (ch === quote && previous !== "\\") {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "<") angleDepth += 1;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);

      if (
        delimiters.has(ch) &&
        angleDepth === 0 &&
        parenDepth === 0 &&
        braceDepth === 0 &&
        bracketDepth === 0
      ) {
        if (current.trim().length > 0) {
          parts.push(current.trim());
        }
        current = "";
        continue;
      }
      current += ch;
    }

    if (current.trim().length > 0) {
      parts.push(current.trim());
    }
    return parts;
  }

  private findTopLevelCharacter(text: string, target: string): number {
    let angleDepth = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let quote: string | null = null;
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index]!;
      const previous = index > 0 ? text[index - 1] : "";
      if (quote) {
        if (ch === quote && previous !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "<") angleDepth += 1;
      else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      if (ch === target && angleDepth === 0 && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
        return index;
      }
    }
    return -1;
  }

  private findMatchingDelimiter(text: string, openIndex: number, open: string, close: string): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = openIndex; index < text.length; index += 1) {
      const ch = text[index]!;
      const previous = index > 0 ? text[index - 1] : "";
      if (quote) {
        if (ch === quote && previous !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === open) depth += 1;
      if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }
    return -1;
  }

  private looksLikeFunctionTypeAnnotation(typeName: string): boolean {
    return typeName.includes("=>");
  }
}
