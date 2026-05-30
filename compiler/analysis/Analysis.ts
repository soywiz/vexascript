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

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  node: Node;
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
  private static readonly BUILTIN_IDENTIFIERS = new Set(["true", "false", "null", "undefined"]);

  constructor(private readonly program: Program) {
    this.rootScope = this.createScope(undefined, program);
    for (const name of Analysis.BUILTIN_IDENTIFIERS) {
      this.declare(this.rootScope, {
        name,
        kind: "variable",
        node: program
      });
    }
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
    this.predeclareScopeStatements(program.body, scope);
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
    this.declare(scope, {
      name: statement.name.name,
      kind: "variable",
      node: statement
    });
    if (statement.initializer) {
      this.visitExpression(statement.initializer, scope);
    }
  }

  private visitFunctionStatement(statement: FunctionStatement, scope: Scope, declareInParent: boolean): void {
    if (declareInParent) {
      this.declare(scope, {
        name: statement.name.name,
        kind: "function",
        node: statement
      });
    }

    const functionScope = this.createScope(scope, statement);
    this.predeclareScopeStatements(statement.body.body, functionScope);
    for (const parameter of statement.parameters) {
      this.declare(functionScope, {
        name: parameter.name.name,
        kind: "parameter",
        node: parameter
      });
      if (parameter.defaultValue) {
        this.visitExpression(parameter.defaultValue, functionScope);
      }
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
      node: statement
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
        node: method
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
    this.predeclareScopeStatements(statement.body, blockScope);
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
      this.predeclareScopeStatements(switchCase.consequent, caseScope);
      if (switchCase.test) {
        this.visitExpression(switchCase.test, caseScope);
      }
      for (const consequent of switchCase.consequent) {
        this.visitStatement(consequent, caseScope, switchFlow);
      }
    }
  }

  private visitExpression(expression: Expr, scope: Scope): void {
    switch (expression.kind) {
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        this.visitExpression(binary.left, scope);
        this.visitExpression(binary.right, scope);
        return;
      }
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        this.visitExpression(assignment.left, scope);
        this.visitExpression(assignment.right, scope);
        return;
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        this.visitExpression(member.object, scope);
        if (member.computed) {
          this.visitExpression(member.property, scope);
        }
        return;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        this.visitExpression(call.callee, scope);
        for (const argument of call.arguments) {
          this.visitExpression(argument, scope);
        }
        return;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        this.visitExpression(newExpression.callee, scope);
        if (newExpression.arguments) {
          for (const argument of newExpression.arguments) {
            this.visitExpression(argument, scope);
          }
        }
        return;
      }
      case "UnaryExpression":
        this.visitExpression((expression as UnaryExpression).argument, scope);
        return;
      case "UpdateExpression":
        this.visitExpression((expression as UpdateExpression).argument, scope);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          this.visitExpression(element, scope);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          this.visitExpression(property.value, scope);
        }
        return;
      case "Identifier":
        this.reportIfUnresolvedIdentifier(expression as Node & { kind: "Identifier"; name: string }, scope);
        return;
      case "IntLiteral":
      case "StringLiteral":
        return;
      default:
        return;
    }
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

  private predeclareScopeStatements(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind === "FunctionStatement") {
        const functionStatement = statement as FunctionStatement;
        this.declare(scope, {
          name: functionStatement.name.name,
          kind: "function",
          node: functionStatement
        });
        continue;
      }

      if (statement.kind === "ClassStatement") {
        const classStatement = statement as ClassStatement;
        this.declare(scope, {
          name: classStatement.name.name,
          kind: "class",
          node: classStatement
        });
      }
    }
  }
}
