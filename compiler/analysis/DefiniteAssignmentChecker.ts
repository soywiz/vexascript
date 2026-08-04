import {
  ArrowFunctionExpression,
  AssignmentExpression,
  BlockStatement,
  ClassExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  DoWhileStatement,
  ExportStatement,
  ExprStatement,
  ForStatement,
  FunctionExpression,
  FunctionStatement,
  Identifier,
  IfStatement,
  LabeledStatement,
  MemberExpression,
  NamespaceStatement,
  Node,
  Program,
  Statement,
  SwitchStatement,
  TryStatement,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement,
  WithStatement,
  nodeStartOffset,
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { childNodes } from "compiler/ast/traversal";
import type { AnalysisIssue, AnalysisSymbol, BoundAnalysis, Scope } from "./model";
import { resolveScopeSymbol } from "./model";
import { ANALYSIS_ISSUE_CODES } from "./issueCodes";

interface AssignmentState {
  assigned: Set<AnalysisSymbol>;
}

interface CheckedDeclaration {
  keywordOffset: number;
  nameOffset: number;
}

function cloneState(state: AssignmentState): AssignmentState {
  return { assigned: new Set(state.assigned) };
}

function intersectStates(states: readonly AssignmentState[]): AssignmentState {
  const first = states[0];
  if (!first) return { assigned: new Set() };
  const assigned = new Set(first.assigned);
  for (const symbol of assigned) {
    if (states.some((state) => !state.assigned.has(symbol))) assigned.delete(symbol);
  }
  return { assigned };
}

/** VexaScript's flow-sensitive initialization check for ordinary and class vars. */
export class DefiniteAssignmentChecker {
  private readonly issues: AnalysisIssue[] = [];
  private readonly declarations = new Map<AnalysisSymbol, CheckedDeclaration>();
  private readonly reportedReads = new WeakSet<Node>();

  constructor(private readonly program: Program, private readonly bound: BoundAnalysis) {}

  check(): AnalysisIssue[] {
    const state: AssignmentState = { assigned: new Set() };
    this.visitStatements(this.program.body, this.bound.rootScope, state);
    return this.issues;
  }

  private scopeFor(node: Node, fallback: Scope): Scope {
    return this.bound.scopeByNode.get(node) ?? fallback;
  }

  private visitStatements(statements: readonly Statement[], scope: Scope, state: AssignmentState): void {
    for (const statement of statements) this.visitStatement(statement, scope, state);
  }

  private visitStatement(statement: Statement, scope: Scope, state: AssignmentState): void {
    if (statement instanceof ExportStatement) {
      if (statement.declaration) this.visitStatement(statement.declaration, scope, state);
      return;
    }
    if (statement instanceof VarStatement) {
      this.visitVarStatement(statement, scope, state);
      return;
    }
    if (statement instanceof ExprStatement) {
      this.visitExpression(statement.expression, scope, state);
      return;
    }
    if (statement instanceof BlockStatement) {
      this.visitStatements(statement.body, this.scopeFor(statement, scope), state);
      return;
    }
    if (statement instanceof IfStatement) {
      this.visitExpression(statement.condition, scope, state);
      const thenState = cloneState(state);
      this.visitStatement(statement.thenBranch, this.scopeFor(statement.thenBranch, scope), thenState);
      const elseState = cloneState(state);
      if (statement.elseBranch) {
        this.visitStatement(statement.elseBranch, this.scopeFor(statement.elseBranch, scope), elseState);
      }
      state.assigned = intersectStates([thenState, elseState]).assigned;
      return;
    }
    if (statement instanceof WhileStatement) {
      this.visitExpression(statement.condition, scope, state);
      this.visitStatement(statement.body, this.scopeFor(statement, scope), cloneState(state));
      return;
    }
    if (statement instanceof DoWhileStatement) {
      this.visitStatement(statement.body, this.scopeFor(statement, scope), state);
      this.visitExpression(statement.condition, scope, state);
      return;
    }
    if (statement instanceof ForStatement) {
      const loopScope = this.scopeFor(statement, scope);
      if (statement.initializer instanceof VarStatement) this.visitVarStatement(statement.initializer, loopScope, state);
      else if (statement.initializer) this.visitExpression(statement.initializer, loopScope, state);
      if (statement.iterator instanceof VarStatement) this.visitVarStatement(statement.iterator, loopScope, state);
      else if (statement.iterator) this.visitExpression(statement.iterator, loopScope, state);
      if (statement.iterable) this.visitExpression(statement.iterable, loopScope, state);
      if (statement.condition) this.visitExpression(statement.condition, loopScope, state);
      const bodyState = cloneState(state);
      this.visitStatement(statement.body, loopScope, bodyState);
      if (statement.update) this.visitExpression(statement.update, loopScope, bodyState);
      return;
    }
    if (statement instanceof SwitchStatement) {
      this.visitExpression(statement.discriminant, scope, state);
      const branches: AssignmentState[] = [];
      let hasDefault = false;
      for (const switchCase of statement.cases) {
        const branch = cloneState(state);
        if (switchCase.test) this.visitExpression(switchCase.test, scope, branch);
        else hasDefault = true;
        this.visitStatements(switchCase.consequent, scope, branch);
        branches.push(branch);
      }
      if (!hasDefault) branches.push(cloneState(state));
      state.assigned = intersectStates(branches).assigned;
      return;
    }
    if (statement instanceof TryStatement) {
      const before = cloneState(state);
      const tryState = cloneState(state);
      this.visitStatement(statement.tryBlock, this.scopeFor(statement.tryBlock, scope), tryState);
      const branches = [tryState];
      if (statement.catchClause) {
        const catchState = cloneState(before);
        this.visitStatement(statement.catchClause.body, this.scopeFor(statement.catchClause, scope), catchState);
        branches.push(catchState);
      }
      state.assigned = intersectStates(branches).assigned;
      if (statement.finallyBlock) {
        this.visitStatement(statement.finallyBlock, this.scopeFor(statement.finallyBlock, scope), state);
      }
      return;
    }
    if (statement instanceof FunctionStatement) {
      this.visitFunctionBody(statement.body, this.scopeFor(statement, scope), cloneState(state));
      return;
    }
    if (statement instanceof ClassStatement) {
      this.visitClass(statement, scope, state);
      return;
    }
    if (statement instanceof NamespaceStatement) {
      this.visitStatements(statement.body.body, this.scopeFor(statement, scope), cloneState(state));
      return;
    }
    if (statement instanceof WithStatement) {
      this.visitExpression(statement.object, scope, state);
      this.visitStatement(statement.body, this.scopeFor(statement, scope), state);
      return;
    }
    if (statement instanceof LabeledStatement) {
      this.visitStatement(statement.body, this.scopeFor(statement, scope), state);
      return;
    }

    for (const child of childNodes(statement)) this.visitExpression(child, this.scopeFor(child, scope), state);
  }

  private visitVarStatement(statement: VarStatement, scope: Scope, state: AssignmentState): void {
    if (statement.declarations?.length) {
      for (const declaration of statement.declarations) {
        this.visitVarDeclaration(statement, declaration, scope, state);
      }
      return;
    }
    this.visitVarDeclaration(statement, statement, scope, state);
  }

  private visitVarDeclaration(
    statement: VarStatement,
    declaration: VarStatement | VarDeclarator,
    scope: Scope,
    state: AssignmentState
  ): void {
    const identifiers = bindingIdentifiers(declaration.name);
    if (statement.declarationKind === "var" && statement.declared !== true && statement.uncheckedInitialization !== true) {
      for (const identifier of identifiers) this.register(identifier, statement, scope, state);
    }
    if (declaration.delegate) this.visitExpression(declaration.delegate, scope, state);
    if (declaration.initializer) this.visitExpression(declaration.initializer, scope, state);
    if (declaration.initializer || declaration.delegate) {
      for (const identifier of identifiers) this.markIdentifierAssigned(identifier, scope, state);
    }
  }

  private register(identifier: Identifier, declaration: Node, scope: Scope, state: AssignmentState): void {
    const symbol = resolveScopeSymbol(identifier.name, scope, nodeStartOffset(identifier));
    if (!symbol) return;
    this.declarations.set(symbol, {
      keywordOffset: declaration.firstToken?.range.start.offset ?? nodeStartOffset(identifier) ?? 0,
      nameOffset: nodeStartOffset(identifier) ?? declaration.lastToken?.range.end.offset ?? 0,
    });
    state.assigned.delete(symbol);
  }

  private visitClass(statement: ClassStatement | ClassExpression, outerScope: Scope, outerState: AssignmentState): void {
    const classScope = this.scopeFor(statement, outerScope);
    const initializationState = cloneState(outerState);
    for (const member of statement.members) {
      if (!(member instanceof ClassFieldMember) || member.declarationKind !== "var" || member.declared === true || member.uncheckedInitialization === true) continue;
      this.register(member.name, member, classScope, initializationState);
    }
    for (const member of statement.members) {
      if (!(member instanceof ClassFieldMember)) continue;
      if (member.computedKey) this.visitExpression(member.computedKey, classScope, initializationState);
      if (member.initializer) {
        this.visitExpression(member.initializer, classScope, initializationState);
        this.markIdentifierAssigned(member.name, classScope, initializationState);
      }
    }
    for (const initBlock of statement.initBlocks ?? []) {
      this.visitStatements(initBlock.body.body, this.scopeFor(initBlock, classScope), initializationState);
    }

    const constructor = statement.members.find((member): member is ClassMethodMember =>
      member instanceof ClassMethodMember && member.name.name === "constructor"
    );
    if (constructor) {
      this.visitFunctionBody(constructor.body, this.scopeFor(constructor, classScope), initializationState);
    }
    for (const member of statement.members) {
      if (!(member instanceof ClassMethodMember) || member === constructor) continue;
      this.visitFunctionBody(member.body, this.scopeFor(member, classScope), cloneState(initializationState));
    }
  }

  private visitFunctionBody(body: BlockStatement, scope: Scope, state: AssignmentState): void {
    this.visitStatements(body.body, scope, state);
  }

  private visitExpression(node: Node, scope: Scope, state: AssignmentState): void {
    if (node instanceof Identifier) {
      this.visitIdentifierRead(node, scope, state);
      return;
    }
    if (node instanceof AssignmentExpression) {
      if (node.operator === "=") {
        this.visitAssignmentTarget(node.left, scope, state, false);
        this.visitExpression(node.right, scope, state);
      } else {
        this.visitAssignmentTarget(node.left, scope, state, true);
        this.visitExpression(node.right, scope, state);
      }
      this.markTargetAssigned(node.left, scope, state);
      return;
    }
    if (node instanceof UpdateExpression) {
      this.visitExpression(node.argument, scope, state);
      this.markTargetAssigned(node.argument, scope, state);
      return;
    }
    if (node instanceof MemberExpression) {
      this.visitExpression(node.object, scope, state);
      if (node.computed) this.visitExpression(node.property, scope, state);
      if (!node.computed && node.object instanceof Identifier && node.object.name === "this" && node.property instanceof Identifier) {
        this.visitIdentifierRead(node.property, scope, state);
      }
      return;
    }
    if (node instanceof ArrowFunctionExpression) {
      const expressionScope = this.scopeFor(node, scope);
      if (node.body instanceof BlockStatement) this.visitStatements(node.body.body, expressionScope, cloneState(state));
      else this.visitExpression(node.body, expressionScope, cloneState(state));
      return;
    }
    if (node instanceof FunctionExpression) {
      this.visitStatements(node.body.body, this.scopeFor(node, scope), cloneState(state));
      return;
    }
    if (node instanceof ClassExpression) {
      this.visitClass(node, scope, state);
      return;
    }
    if (node instanceof IfStatement) {
      this.visitStatement(node, scope, state);
      return;
    }
    for (const child of childNodes(node)) this.visitExpression(child, this.scopeFor(child, scope), state);
  }

  private visitAssignmentTarget(target: Node, scope: Scope, state: AssignmentState, readsValue: boolean): void {
    if (target instanceof Identifier) {
      if (readsValue) this.visitIdentifierRead(target, scope, state);
      return;
    }
    if (target instanceof MemberExpression) {
      this.visitExpression(target.object, scope, state);
      if (target.computed) this.visitExpression(target.property, scope, state);
      if (readsValue && !target.computed && target.object instanceof Identifier && target.object.name === "this" && target.property instanceof Identifier) {
        this.visitIdentifierRead(target.property, scope, state);
      }
      return;
    }
    this.visitExpression(target, scope, state);
  }

  private markTargetAssigned(target: Node, scope: Scope, state: AssignmentState): void {
    if (target instanceof Identifier) {
      this.markIdentifierAssigned(target, scope, state);
      return;
    }
    if (target instanceof MemberExpression && !target.computed && target.object instanceof Identifier && target.object.name === "this" && target.property instanceof Identifier) {
      this.markIdentifierAssigned(target.property, scope, state);
    }
  }

  private markIdentifierAssigned(identifier: Identifier, scope: Scope, state: AssignmentState): void {
    const symbol = resolveScopeSymbol(identifier.name, scope, nodeStartOffset(identifier));
    if (symbol && this.declarations.has(symbol)) state.assigned.add(symbol);
  }

  private visitIdentifierRead(identifier: Identifier, scope: Scope, state: AssignmentState): void {
    const symbol = resolveScopeSymbol(identifier.name, scope, nodeStartOffset(identifier));
    const declaration = symbol ? this.declarations.get(symbol) : undefined;
    if (!symbol || !declaration || state.assigned.has(symbol) || this.reportedReads.has(identifier)) return;
    this.reportedReads.add(identifier);
    this.issues.push({
      message: `Variable '${identifier.name}' is used before being initialized`,
      node: identifier,
      code: ANALYSIS_ISSUE_CODES.VARIABLE_USED_BEFORE_INITIALIZATION,
      data: {
        variableName: identifier.name,
        declarationKeywordOffset: declaration.keywordOffset,
        declarationNameOffset: declaration.nameOffset,
      },
    });
  }
}
