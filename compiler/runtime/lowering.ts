import type {
  BlockStatement,
  CatchClause,
  ClassMethodMember,
  ClassStatement,
  DoWhileStatement,
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
    ...(statement.declarations
      ? {
          declarations: statement.declarations.map((declaration) => ({ ...declaration }))
        }
      : {})
  }, statement);
}

function lowerForStatement(statement: ForStatement): ForStatement {
  if (!(statement.iterationKind && statement.iterator && statement.iterable)) {
    return copyNodeBounds({
      ...statement,
      ...(statement.initializer
        ? {
            initializer:
              statement.initializer.kind === "VarStatement"
                ? cloneVarStatement(statement.initializer as VarStatement)
                : cloneExpression(statement.initializer as Expr)
          }
        : {}),
      ...(statement.condition ? { condition: cloneExpression(statement.condition) } : {}),
      ...(statement.update ? { update: cloneExpression(statement.update) } : {}),
      body: lowerStatement(statement.body)
    }, statement);
  }

  if (statement.iterationKind === "of" && statement.iterable.kind === "RangeExpression") {
    const iteratorName =
      statement.iterator.kind === "Identifier"
        ? (statement.iterator as Identifier).name
        : statement.iterator.kind === "VarStatement"
          ? (bindingIdentifiers((statement.iterator as VarStatement).declarations?.[0]?.name ?? (statement.iterator as VarStatement).name)[0]?.name)
          : null;

    if (iteratorName) {
      const range = statement.iterable as RangeExpression;
      const loweredInitializer: VarStatement = {
        kind: "VarStatement",
        declarationKind: "let",
        name: { kind: "Identifier", name: iteratorName },
        initializer: cloneExpression(range.start)
      };
      const loweredCondition: Expr = {
        kind: "BinaryExpression",
        operator: "<",
        left: { kind: "Identifier", name: iteratorName },
        right: cloneExpression(range.end)
      } as Expr;
      const loweredUpdate: UpdateExpression = {
        kind: "UpdateExpression",
        operator: "++",
        argument: { kind: "Identifier", name: iteratorName } as Expr,
        prefix: false
      };

      return copyNodeBounds({
        kind: "ForStatement",
        initializer: loweredInitializer,
        condition: loweredCondition,
        update: loweredUpdate as unknown as Expr,
        body: lowerStatement(statement.body)
      }, statement);
    }
  }

  return copyNodeBounds({
    ...statement,
    ...(statement.iterator
      ? {
          iterator:
            statement.iterator.kind === "VarStatement"
              ? cloneVarStatement(statement.iterator as VarStatement)
              : statement.iterator.kind === "Identifier"
                ? { ...statement.iterator }
                : cloneExpression(statement.iterator as Expr)
        }
      : {}),
    ...(statement.iterable ? { iterable: cloneExpression(statement.iterable) } : {}),
    body: lowerStatement(statement.body)
  }, statement);
}

function lowerBlockStatement(statement: BlockStatement): BlockStatement {
  return copyNodeBounds({
    ...statement,
    body: statement.body.map((child) => lowerStatement(child))
  }, statement);
}

function lowerStatement(statement: Statement): Statement {
  switch (statement.kind) {
    case "ExportStatement": {
      const s = statement as ExportStatement;
      return copyNodeBounds({
        ...s,
        ...(s.declaration ? { declaration: lowerStatement(s.declaration) } : {})
      }, statement);
    }
    case "ForStatement":
      return lowerForStatement(statement as ForStatement);
    case "BlockStatement":
      return lowerBlockStatement(statement as BlockStatement);
    case "FunctionStatement": {
      const s = statement as FunctionStatement;
      return copyNodeBounds({
        ...s,
        body: lowerBlockStatement(s.body)
      }, statement);
    }
    case "ClassStatement": {
      const s = statement as ClassStatement;
      return copyNodeBounds({
        ...s,
        members: s.members.map((member) => {
          if (member.kind !== "ClassMethodMember") {
            return { ...member };
          }
          const method = member as ClassMethodMember;
          return {
            ...method,
            body: lowerBlockStatement(method.body)
          };
        })
      }, statement);
    }
    case "IfStatement": {
      const s = statement as IfStatement;
      return copyNodeBounds({
        ...s,
        thenBranch: lowerStatement(s.thenBranch),
        ...(s.elseBranch ? { elseBranch: lowerStatement(s.elseBranch) } : {})
      }, statement);
    }
    case "WhileStatement": {
      const s = statement as WhileStatement;
      return copyNodeBounds({ ...s, body: lowerStatement(s.body) }, statement);
    }
    case "DoWhileStatement": {
      const s = statement as DoWhileStatement;
      return copyNodeBounds({ ...s, body: lowerStatement(s.body) }, statement);
    }
    case "SwitchStatement": {
      const s = statement as SwitchStatement;
      return copyNodeBounds({
        ...s,
        cases: s.cases.map((switchCase) => ({
          ...switchCase,
          consequent: switchCase.consequent.map((child) => lowerStatement(child))
        }))
      }, statement);
    }
    case "TryStatement": {
      const s = statement as TryStatement;
      return copyNodeBounds({
        ...s,
        tryBlock: lowerBlockStatement(s.tryBlock),
        ...(s.catchClause
          ? {
              catchClause: {
                ...(s.catchClause as CatchClause),
                body: lowerBlockStatement((s.catchClause as CatchClause).body)
              }
            }
          : {}),
        ...(s.finallyBlock ? { finallyBlock: lowerBlockStatement(s.finallyBlock) } : {})
      }, statement);
    }
    case "VarStatement":
      return cloneVarStatement(statement as VarStatement) as unknown as Statement;
    default:
      return copyNodeBounds({ ...statement }, statement);
  }
}

export function lowerProgram(program: Program): Program {
  return {
    ...program,
    body: program.body.map((statement) => lowerStatement(statement))
  };
}
