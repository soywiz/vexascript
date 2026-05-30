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
    this.visitProgram(program, this.rootScope);
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

  private visitProgram(program: Program, scope: Scope): void {
    for (const statement of program.body) {
      this.visitStatement(statement, scope);
    }
  }

  private visitStatement(statement: Statement, scope: Scope): void {
    switch (statement.kind) {
      case "VarStatement":
        this.visitVarStatement(statement as VarStatement, scope);
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
        this.visitBlockStatement(statement as BlockStatement, scope);
        return;
      case "WhileStatement": {
        const whileStatement = statement as WhileStatement;
        this.visitExpression(whileStatement.condition, scope);
        this.visitStatement(whileStatement.body, this.createScope(scope, whileStatement));
        return;
      }
      case "DoWhileStatement": {
        const doWhileStatement = statement as DoWhileStatement;
        this.visitStatement(doWhileStatement.body, this.createScope(scope, doWhileStatement));
        this.visitExpression(doWhileStatement.condition, scope);
        return;
      }
      case "ForStatement":
        this.visitForStatement(statement as ForStatement, scope);
        return;
      case "IfStatement":
        this.visitIfStatement(statement as IfStatement, scope);
        return;
      case "SwitchStatement":
        this.visitSwitchStatement(statement as SwitchStatement, scope);
        return;
      case "ReturnStatement": {
        const returnStatement = statement as ReturnStatement;
        if (returnStatement.expression) {
          this.visitExpression(returnStatement.expression, scope);
        }
        return;
      }
      case "ContinueStatement":
      case "BreakStatement":
        return;
      default:
        return;
    }
  }

  private visitVarStatement(statement: VarStatement, scope: Scope): void {
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
      this.visitStatement(bodyStatement, functionScope);
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

  private visitBlockStatement(statement: BlockStatement, scope: Scope): void {
    const blockScope = this.createScope(scope, statement);
    for (const child of statement.body) {
      this.visitStatement(child, blockScope);
    }
  }

  private visitForStatement(statement: ForStatement, scope: Scope): void {
    const loopScope = this.createScope(scope, statement);

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
    this.visitStatement(statement.body, loopScope);
  }

  private visitIfStatement(statement: IfStatement, scope: Scope): void {
    this.visitExpression(statement.condition, scope);
    this.visitStatement(statement.thenBranch, this.createScope(scope, statement.thenBranch));
    if (statement.elseBranch) {
      this.visitStatement(statement.elseBranch, this.createScope(scope, statement.elseBranch));
    }
  }

  private visitSwitchStatement(statement: SwitchStatement, scope: Scope): void {
    this.visitExpression(statement.discriminant, scope);
    const switchScope = this.createScope(scope, statement);

    for (const switchCase of statement.cases) {
      const caseScope = this.createScope(switchScope, switchCase);
      if (switchCase.test) {
        this.visitExpression(switchCase.test, caseScope);
      }
      for (const consequent of switchCase.consequent) {
        this.visitStatement(consequent, caseScope);
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
}
