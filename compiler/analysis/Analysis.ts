import {
  ArrayLiteral,
  AssignmentExpression,
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
  ReturnStatement,
  Statement,
  SwitchStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";

export type AnalysisSymbolKind = "variable" | "parameter" | "function" | "class" | "method";
export type AnalysisValueType = "int" | "string" | "boolean" | "unknown" | string;
const UNKNOWN_TYPE: AnalysisValueType = "unknown";

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  node: Node;
  valueType?: AnalysisValueType;
}

export interface AnalysisIssue {
  message: string;
  node: Node;
}

interface Scope {
  parent?: Scope;
  node: Node;
  symbols: Map<string, AnalysisSymbol>;
  children: Scope[];
}

interface FlowContext {
  loopDepth: number;
  switchDepth: number;
}

export class Analysis {
  private readonly rootScope: Scope;
  private readonly issues: AnalysisIssue[] = [];
  private static readonly BUILTIN_TYPE_NAMES = new Set(["int", "number", "string", "boolean"]);
  private static readonly BUILTIN_IDENTIFIERS = new Map<string, AnalysisValueType>([
    ["true", "boolean"],
    ["false", "boolean"],
    ["null", "null"],
    ["undefined", "undefined"],
    ["console", "unknown"]
  ]);

  constructor(private readonly program: Program) {
    this.rootScope = this.createScope(undefined, program);
    for (const [name, valueType] of Analysis.BUILTIN_IDENTIFIERS) {
      this.declare(this.rootScope, {
        name,
        kind: "variable",
        node: program,
        valueType
      });
    }
    this.predeclareGlobalDeclarations(program.body, this.rootScope);
    this.visitProgram(program, this.rootScope, { loopDepth: 0, switchDepth: 0 });
  }

  getVisibleSymbolsAt(line: number, character: number): AnalysisSymbol[] {
    const scope = this.findInnermostScope(this.rootScope, line, character);
    if (!scope) {
      return [];
    }

    const visible = new Map<string, AnalysisSymbol>();
    let current: Scope | undefined = scope;
    while (current) {
      for (const [name, symbol] of current.symbols) {
        if (!visible.has(name)) {
          visible.set(name, symbol);
        }
      }
      current = current.parent;
    }
    return Array.from(visible.values());
  }

  getIssues(): AnalysisIssue[] {
    return [...this.issues];
  }

  private createScope(parent: Scope | undefined, node: Node): Scope {
    const scope: Scope = {
      parent,
      node,
      symbols: new Map<string, AnalysisSymbol>(),
      children: []
    };
    if (parent) {
      parent.children.push(scope);
    }
    return scope;
  }

  private declare(scope: Scope, symbol: AnalysisSymbol): void {
    scope.symbols.set(symbol.name, symbol);
  }

  private visitProgram(program: Program, scope: Scope, flow: FlowContext): void {
    for (const statement of program.body) {
      this.visitStatement(statement, scope, flow);
    }
  }

  private visitStatement(statement: Statement, scope: Scope, flow: FlowContext): void {
    switch (statement.kind) {
      case "VarStatement":
        this.visitVarStatement(statement as VarStatement, scope, flow);
        return;
      case "FunctionStatement":
        this.visitFunctionStatement(statement as FunctionStatement, scope, true);
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
        this.visitStatement(whileStatement.body, this.createScope(scope, whileStatement), loopFlow);
        return;
      }
      case "DoWhileStatement": {
        const doWhileStatement = statement as DoWhileStatement;
        const loopFlow: FlowContext = {
          loopDepth: flow.loopDepth + 1,
          switchDepth: flow.switchDepth
        };
        this.visitStatement(doWhileStatement.body, this.createScope(scope, doWhileStatement), loopFlow);
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

  private visitVarStatement(statement: VarStatement, scope: Scope, flow: FlowContext): void {
    if (statement.declarations && statement.declarations.length > 0) {
      for (const declaration of statement.declarations) {
        const explicitType = this.resolveTypeAnnotation(declaration.typeAnnotation, scope);
        const initializerType = declaration.initializer
          ? this.visitExpression(declaration.initializer, scope)
          : undefined;
        if (
          explicitType &&
          initializerType &&
          explicitType !== UNKNOWN_TYPE &&
          initializerType !== UNKNOWN_TYPE &&
          !this.isTypeAssignable(initializerType, explicitType)
        ) {
          this.issues.push({
            message: `Type '${initializerType}' is not assignable to type '${explicitType}'`,
            node: declaration.name
          });
        }
        const inferredType = explicitType ?? initializerType ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: declaration.name.name,
          kind: "variable",
          node: declaration,
          valueType: inferredType
        });
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
      explicitType !== UNKNOWN_TYPE &&
      initializerType !== UNKNOWN_TYPE &&
      !this.isTypeAssignable(initializerType, explicitType)
    ) {
      this.issues.push({
        message: `Type '${initializerType}' is not assignable to type '${explicitType}'`,
        node: statement.name
      });
    }
    const inferredType = explicitType ?? initializerType ?? UNKNOWN_TYPE;
    this.declare(scope, {
      name: statement.name.name,
      kind: "variable",
      node: statement,
      valueType: inferredType
    });
  }

  private visitFunctionStatement(statement: FunctionStatement, scope: Scope, declareInParent: boolean): void {
    if (declareInParent) {
      this.declare(scope, {
        name: statement.name.name,
        kind: "function",
        node: statement,
        valueType: this.buildFunctionType(
          statement.parameters,
          this.resolveTypeAnnotation(statement.returnType, scope) ?? UNKNOWN_TYPE
        )
      });
    }

    const functionScope = this.createScope(scope, statement);
    for (const parameter of statement.parameters) {
      const parameterType =
        this.resolveTypeAnnotation(parameter.typeAnnotation, functionScope) ??
        (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, functionScope) : UNKNOWN_TYPE);
      this.declare(functionScope, {
        name: parameter.name.name,
        kind: "parameter",
        node: parameter,
        valueType: parameterType
      });
    }

    // Function body runs within function scope.
    for (const bodyStatement of statement.body.body) {
      this.visitStatement(bodyStatement, functionScope, { loopDepth: 0, switchDepth: 0 });
    }
  }

  private visitClassStatement(statement: ClassStatement, scope: Scope): void {
    this.declare(scope, {
      name: statement.name.name,
      kind: "class",
      node: statement,
      valueType: statement.name.name
    });

    const classScope = this.createScope(scope, statement);
    for (const member of statement.members) {
      if (member.kind === "ClassFieldMember") {
        const field = member as ClassFieldMember;
        if (field.initializer) {
          this.visitExpression(field.initializer, classScope);
        }
        continue;
      }

      const method = member as ClassMethodMember;
      this.declare(classScope, {
        name: method.name.name,
        kind: "method",
        node: method,
        valueType: this.buildFunctionType(
          method.parameters,
          this.resolveTypeAnnotation(method.returnType, classScope) ?? UNKNOWN_TYPE
        )
      });
      const syntheticFunction = {
        kind: "FunctionStatement",
        declarationKind: "function",
        name: method.name,
        parameters: method.parameters,
        body: method.body
      } as FunctionStatement;
      this.visitFunctionStatement(syntheticFunction, classScope, false);
    }
  }

  private visitBlockStatement(statement: BlockStatement, scope: Scope, flow: FlowContext): void {
    const blockScope = this.createScope(scope, statement);
    for (const child of statement.body) {
      this.visitStatement(child, blockScope, flow);
    }
  }

  private visitForStatement(statement: ForStatement, scope: Scope, flow: FlowContext): void {
    const loopScope = this.createScope(scope, statement);
    const loopFlow: FlowContext = {
      loopDepth: flow.loopDepth + 1,
      switchDepth: flow.switchDepth
    };

    if (statement.iterationKind && statement.iterator && statement.iterable) {
      if (statement.iterator.kind === "VarStatement") {
        this.visitVarStatement(statement.iterator as VarStatement, loopScope, loopFlow);
      } else if (statement.iterator.kind === "Identifier") {
        const iteratorIdentifier = statement.iterator as Node & { kind: "Identifier"; name: string };
        this.declare(loopScope, {
          name: iteratorIdentifier.name,
          kind: "variable",
          node: iteratorIdentifier,
          valueType: UNKNOWN_TYPE
        });
      } else {
        this.visitExpression(statement.iterator as Expr, loopScope);
      }

      this.visitExpression(statement.iterable, loopScope);
      this.visitStatement(statement.body, loopScope, loopFlow);
      return;
    }

    if (statement.initializer) {
      if (statement.initializer.kind === "VarStatement") {
        this.visitVarStatement(statement.initializer as VarStatement, loopScope, loopFlow);
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
    this.visitStatement(statement.thenBranch, this.createScope(scope, statement.thenBranch), flow);
    if (statement.elseBranch) {
      this.visitStatement(statement.elseBranch, this.createScope(scope, statement.elseBranch), flow);
    }
  }

  private visitSwitchStatement(statement: SwitchStatement, scope: Scope, flow: FlowContext): void {
    this.visitExpression(statement.discriminant, scope);
    const switchScope = this.createScope(scope, statement);
    const switchFlow: FlowContext = {
      loopDepth: flow.loopDepth,
      switchDepth: flow.switchDepth + 1
    };

    for (const switchCase of statement.cases) {
      const caseScope = this.createScope(switchScope, switchCase);
      if (switchCase.test) {
        this.visitExpression(switchCase.test, caseScope);
      }
      for (const consequent of switchCase.consequent) {
        this.visitStatement(consequent, caseScope, switchFlow);
      }
    }
  }

  private visitExpression(expression: Expr, scope: Scope): AnalysisValueType {
    switch (expression.kind) {
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        const leftType = this.visitExpression(binary.left, scope);
        const rightType = this.visitExpression(binary.right, scope);
        return this.inferBinaryType(binary.operator, leftType, rightType);
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
        return this.visitExpression(assignment.right, scope);
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        this.visitExpression(member.object, scope);
        if (member.computed) {
          this.visitExpression(member.property, scope);
        }
        return UNKNOWN_TYPE;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        this.visitExpression(call.callee, scope);
        for (const argument of call.arguments) {
          this.visitExpression(argument, scope);
        }
        return UNKNOWN_TYPE;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        this.visitExpression(newExpression.callee, scope);
        if (newExpression.arguments) {
          for (const argument of newExpression.arguments) {
            this.visitExpression(argument, scope);
          }
        }
        return UNKNOWN_TYPE;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        const argumentType = this.visitExpression(unary.argument, scope);
        if ((unary.operator === "+" || unary.operator === "-") && argumentType === "int") {
          return "int";
        }
        return UNKNOWN_TYPE;
      }
      case "UpdateExpression":
        this.visitExpression((expression as UpdateExpression).argument, scope);
        return "int";
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          this.visitExpression(element, scope);
        }
        return "array";
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          this.visitExpression(property.value, scope);
        }
        return "object";
      case "Identifier":
        return this.resolveIdentifierType(expression as Node & { kind: "Identifier"; name: string }, scope);
      case "IntLiteral":
        return "int";
      case "StringLiteral":
        return "string";
      default:
        return UNKNOWN_TYPE;
    }
  }

  private inferBinaryType(
    operator: BinaryExpression["operator"],
    leftType: AnalysisValueType,
    rightType: AnalysisValueType
  ): AnalysisValueType {
    if (operator === "+" && (leftType === "string" || rightType === "string")) {
      return "string";
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
      return leftType === "int" && rightType === "int" ? "int" : UNKNOWN_TYPE;
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
      return "boolean";
    }

    return UNKNOWN_TYPE;
  }

  private isTypeAssignable(sourceType: AnalysisValueType, targetType: AnalysisValueType): boolean {
    if (sourceType === targetType) {
      return true;
    }

    if (sourceType === "int" && targetType === "number") {
      return true;
    }

    return false;
  }

  private buildFunctionType(parameters: FunctionParameter[], returnType: string | undefined): AnalysisValueType {
    const parameterTypeList = parameters
      .map((parameter) => `${parameter.name.name}: ${parameter.typeAnnotation?.name ?? UNKNOWN_TYPE}`)
      .join(", ");
    return `(${parameterTypeList}) => ${returnType ?? UNKNOWN_TYPE}`;
  }

  private resolveTypeAnnotation(
    typeAnnotation: Node & { kind: "Identifier"; name: string } | undefined,
    scope: Scope
  ): AnalysisValueType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }

    if (Analysis.BUILTIN_TYPE_NAMES.has(typeAnnotation.name)) {
      return typeAnnotation.name;
    }

    const symbol = this.resolve(typeAnnotation.name, scope);
    if (symbol && symbol.kind === "class") {
      return typeAnnotation.name;
    }

    this.issues.push({
      message: `Unknown type '${typeAnnotation.name}'. Expected builtin type (int, number, string, boolean) or declared class/interface`,
      node: typeAnnotation
    });
    return UNKNOWN_TYPE;
  }

  private isLValueExpression(expression: Expr): boolean {
    return expression.kind === "Identifier" || expression.kind === "MemberExpression";
  }

  private findInnermostScope(scope: Scope, line: number, character: number): Scope | null {
    if (!this.nodeContainsPosition(scope.node, line, character)) {
      return null;
    }

    for (const child of scope.children) {
      const nested = this.findInnermostScope(child, line, character);
      if (nested) {
        return nested;
      }
    }
    return scope;
  }

  private nodeContainsPosition(node: Node, line: number, character: number): boolean {
    if (!node.firstToken || !node.lastToken) {
      return true;
    }

    const start = node.firstToken.range.start;
    const end = node.lastToken.range.end;

    if (line < start.line || line > end.line) {
      return false;
    }
    if (line === start.line && character < start.column) {
      return false;
    }
    if (line === end.line && character > end.column) {
      return false;
    }
    return true;
  }

  private resolve(name: string, scope: Scope): AnalysisSymbol | null {
    let current: Scope | undefined = scope;
    while (current) {
      const symbol = current.symbols.get(name);
      if (symbol) {
        return symbol;
      }
      current = current.parent;
    }
    return null;
  }

  private resolveIdentifierType(
    identifier: Node & { kind: "Identifier"; name: string },
    scope: Scope
  ): AnalysisValueType {
    const symbol = this.resolve(identifier.name, scope);
    if (symbol) {
      return symbol.valueType ?? UNKNOWN_TYPE;
    }
    this.issues.push({
      message: `Undefined variable '${identifier.name}'`,
      node: identifier
    });
    return UNKNOWN_TYPE;
  }

  private reportIfUnresolvedIdentifier(
    identifier: Node & { kind: "Identifier"; name: string },
    scope: Scope
  ): void {
    if (this.resolve(identifier.name, scope)) {
      return;
    }
    this.issues.push({
      message: `Undefined variable '${identifier.name}'`,
      node: identifier
    });
  }

  private predeclareGlobalDeclarations(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind === "VarStatement") {
        const variableStatement = statement as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            this.declare(scope, {
              name: declaration.name.name,
              kind: "variable",
              node: declaration,
              valueType: declaration.typeAnnotation?.name ?? UNKNOWN_TYPE
            });
          }
        } else {
          this.declare(scope, {
            name: variableStatement.name.name,
            kind: "variable",
            node: variableStatement,
            valueType: variableStatement.typeAnnotation?.name ?? UNKNOWN_TYPE
          });
        }
        continue;
      }

      if (statement.kind === "FunctionStatement") {
        const functionStatement = statement as FunctionStatement;
        this.declare(scope, {
          name: functionStatement.name.name,
          kind: "function",
          node: functionStatement,
          valueType: this.buildFunctionType(functionStatement.parameters, functionStatement.returnType?.name ?? UNKNOWN_TYPE)
        });
        continue;
      }

      if (statement.kind === "ClassStatement") {
        const classStatement = statement as ClassStatement;
        this.declare(scope, {
          name: classStatement.name.name,
          kind: "class",
          node: classStatement,
          valueType: classStatement.name.name
        });
      }
    }
  }
}
