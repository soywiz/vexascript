import { NodeKind } from "compiler/ast/ast";
import {
  BlockStatement,
  BinaryExpression,
  CatchClause,
  ClassMethodMember,
  ClassStatement,
  DeferStatement,
  DoWhileStatement,
  ExprStatement,
  Expr,
  ExportStatement,
  ForStatement,
  FunctionStatement,
  Identifier,
  IfStatement,
  Node,
  Program,
  RangeExpression,
  Statement,
  SwitchStatement,
  TryStatement,
  UpdateExpression,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";

export interface LoweringOptions {
  lowerRangeForLoops?: boolean;
}

function cloneExpression<T extends Expr>(expression: T): T {
  return expression;
}

function copyNodeBounds<T extends object>(target: T, source: Node): T {
  if (source.firstToken) {
    Object.defineProperty(target, "firstToken", {
      value: source.firstToken,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (source.lastToken) {
    Object.defineProperty(target, "lastToken", {
      value: source.lastToken,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return target;
}

function cloneVarStatement(statement: VarStatement): VarStatement {
  return copyNodeBounds({
    ...statement,
    ...(statement.accessors
      ? {
          accessors: statement.accessors.map((accessor) => ({
            ...accessor,
            parameters: accessor.parameters.map((parameter) => ({ ...parameter })),
            body: accessor.body
          }))
        }
      : {}),
    ...(statement.declarations
      ? {
          declarations: statement.declarations.map((declaration) => ({ ...declaration }))
        }
      : {})
  }, statement);
}

function lowerForStatement(statement: ForStatement, options: LoweringOptions): ForStatement {
  if (!(statement.iterationKind && statement.iterator && statement.iterable)) {
    return copyNodeBounds({
      ...statement,
      ...(statement.initializer
        ? {
            initializer:
              statement.initializer.kind === NodeKind.VarStatement
                ? cloneVarStatement(statement.initializer as VarStatement)
                : cloneExpression(statement.initializer as Expr)
          }
        : {}),
      ...(statement.condition ? { condition: cloneExpression(statement.condition) } : {}),
      ...(statement.update ? { update: cloneExpression(statement.update) } : {}),
      body: lowerStatement(statement.body, options)
    }, statement);
  }

  if (options.lowerRangeForLoops !== false && statement.iterationKind === "of" && statement.iterable.kind === NodeKind.RangeExpression) {
    const iteratorName =
      statement.iterator.kind === NodeKind.Identifier
        ? (statement.iterator as Identifier).name
        : statement.iterator.kind === NodeKind.VarStatement
          ? (bindingIdentifiers((statement.iterator as VarStatement).declarations?.[0]?.name ?? (statement.iterator as VarStatement).name)[0]?.name)
          : null;

    if (iteratorName) {
      const range = statement.iterable as RangeExpression;
      const loweredInitializer: VarStatement = new VarStatement("let", new Identifier(iteratorName), undefined, undefined, undefined, undefined, undefined, undefined, cloneExpression(range.start));
      const loweredCondition: Expr = new BinaryExpression(range.exclusive ? "<" : "<=", new Identifier(iteratorName), cloneExpression(range.end));
      const loweredUpdate: UpdateExpression = new UpdateExpression("++", new Identifier(iteratorName), false);

      return copyNodeBounds(new ForStatement(lowerStatement(statement.body, options), undefined, undefined, undefined, undefined, loweredInitializer, loweredCondition, loweredUpdate as unknown as Expr), statement);
    }
  }

  return copyNodeBounds({
    ...statement,
    ...(statement.iterator
      ? {
          iterator:
            statement.iterator.kind === NodeKind.VarStatement
              ? cloneVarStatement(statement.iterator as VarStatement)
              : statement.iterator.kind === NodeKind.Identifier
                ? { ...statement.iterator }
                : cloneExpression(statement.iterator as Expr)
        }
      : {}),
    ...(statement.iterable ? { iterable: cloneExpression(statement.iterable) } : {}),
    body: lowerStatement(statement.body, options)
  }, statement);
}

function lowerBlockStatement(statement: BlockStatement, options: LoweringOptions): BlockStatement {
  const loweredBody: Statement[] = [];
  for (let index = statement.body.length - 1; index >= 0; index -= 1) {
    const child = statement.body[index]!;
    if (child.kind === NodeKind.DeferStatement) {
      const deferred = child as DeferStatement;
      const tryBlock = copyNodeBounds(new BlockStatement([...loweredBody]), statement);
      const finallyStatement = copyNodeBounds(new ExprStatement(cloneExpression(deferred.expression)), deferred);
      const finallyBlock = copyNodeBounds(new BlockStatement([finallyStatement]), deferred);
      const wrapped = copyNodeBounds(new TryStatement(tryBlock, undefined, finallyBlock), deferred);
      loweredBody.splice(0, loweredBody.length, wrapped);
      continue;
    }
    loweredBody.unshift(lowerStatement(child, options));
  }
  return copyNodeBounds({
    ...statement,
    body: loweredBody
  }, statement);
}

function lowerStatement(statement: Statement, options: LoweringOptions): Statement {
  switch (statement.kind) {
    case NodeKind.ExportStatement: {
      const s = statement as ExportStatement;
      return copyNodeBounds({
        ...s,
        ...(s.declaration ? { declaration: lowerStatement(s.declaration, options) } : {})
      }, statement);
    }
    case NodeKind.ForStatement:
      return lowerForStatement(statement as ForStatement, options);
    case NodeKind.BlockStatement:
      return lowerBlockStatement(statement as BlockStatement, options);
    case NodeKind.FunctionStatement: {
      const s = statement as FunctionStatement;
      return copyNodeBounds({
        ...s,
        body: lowerBlockStatement(s.body, options)
      }, statement);
    }
    case NodeKind.ClassStatement: {
      const s = statement as ClassStatement;
      return copyNodeBounds({
        ...s,
        members: s.members.map((member) => {
          if (member.kind !== NodeKind.ClassMethodMember) {
            return { ...member };
          }
          const method = member as ClassMethodMember;
          return {
            ...method,
            body: lowerBlockStatement(method.body, options)
          };
        })
      }, statement);
    }
    case NodeKind.IfStatement: {
      const s = statement as IfStatement;
      return copyNodeBounds({
        ...s,
        thenBranch: lowerStatement(s.thenBranch, options),
        ...(s.elseBranch ? { elseBranch: lowerStatement(s.elseBranch, options) } : {})
      }, statement);
    }
    case NodeKind.WhileStatement: {
      const s = statement as WhileStatement;
      return copyNodeBounds({ ...s, body: lowerStatement(s.body, options) }, statement);
    }
    case NodeKind.DoWhileStatement: {
      const s = statement as DoWhileStatement;
      return copyNodeBounds({ ...s, body: lowerStatement(s.body, options) }, statement);
    }
    case NodeKind.SwitchStatement: {
      const s = statement as SwitchStatement;
      return copyNodeBounds({
        ...s,
        cases: s.cases.map((switchCase) => ({
          ...switchCase,
          consequent: switchCase.consequent.map((child) => lowerStatement(child, options))
        }))
      }, statement);
    }
    case NodeKind.TryStatement: {
      const s = statement as TryStatement;
      return copyNodeBounds({
        ...s,
        tryBlock: lowerBlockStatement(s.tryBlock, options),
        ...(s.catchClause
          ? {
              catchClause: {
                ...(s.catchClause as CatchClause),
                body: lowerBlockStatement((s.catchClause as CatchClause).body, options)
              }
            }
          : {}),
        ...(s.finallyBlock ? { finallyBlock: lowerBlockStatement(s.finallyBlock, options) } : {})
      }, statement);
    }
    case NodeKind.VarStatement:
      return cloneVarStatement(statement as VarStatement) as unknown as Statement;
    default:
      return copyNodeBounds({ ...statement }, statement);
  }
}

export function lowerProgram(program: Program, options: LoweringOptions = {}): Program {
  return {
    ...program,
    body: program.body.map((statement) => lowerStatement(statement, options))
  };
}
