import type {
  Expr,
  ExportStatement,
  ForStatement,
  Node,
  Program,
  Statement,
  UpdateExpression,
  VarStatement
} from "compiler/ast/ast";

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
        ? (statement.iterator as any).name
        : statement.iterator.kind === "VarStatement"
          ? ((statement.iterator as VarStatement).declarations?.[0]?.name.name ??
            (statement.iterator as VarStatement).name.name)
          : null;

    if (iteratorName) {
      const range = statement.iterable as any;
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

function lowerStatement(statement: Statement): Statement {
  switch (statement.kind) {
    case "ExportStatement": {
      const exportStatement = statement as ExportStatement;
      return copyNodeBounds({
        ...exportStatement,
        ...(exportStatement.declaration ? { declaration: lowerStatement(exportStatement.declaration) } : {})
      }, statement);
    }
    case "ForStatement":
      return lowerForStatement(statement as ForStatement);
    case "BlockStatement":
      return copyNodeBounds({
        ...(statement as any),
        body: (statement as any).body.map((child: Statement) => lowerStatement(child))
      } as Statement, statement);
    case "FunctionStatement":
      return copyNodeBounds({
        ...(statement as any),
        body: {
          ...(statement as any).body,
          body: (statement as any).body.body.map((child: Statement) => lowerStatement(child))
        }
      } as Statement, statement);
    case "ClassStatement":
      return copyNodeBounds({
        ...(statement as any),
        members: (statement as any).members.map((member: any) => {
          if (member.kind !== "ClassMethodMember") {
            return { ...member };
          }
          return {
            ...member,
            body: {
              ...member.body,
              body: member.body.body.map((child: Statement) => lowerStatement(child))
            }
          };
        })
      } as Statement, statement);
    case "IfStatement":
      return copyNodeBounds({
        ...(statement as any),
        thenBranch: lowerStatement((statement as any).thenBranch),
        ...((statement as any).elseBranch
          ? {
              elseBranch: lowerStatement((statement as any).elseBranch)
            }
          : {})
      } as Statement, statement);
    case "WhileStatement":
    case "DoWhileStatement":
      return copyNodeBounds({
        ...(statement as any),
        body: lowerStatement((statement as any).body)
      } as Statement, statement);
    case "SwitchStatement":
      return copyNodeBounds({
        ...(statement as any),
        cases: (statement as any).cases.map((switchCase: any) => ({
          ...switchCase,
          consequent: switchCase.consequent.map((child: Statement) => lowerStatement(child))
        }))
      } as Statement, statement);
    case "TryStatement":
      return copyNodeBounds({
        ...(statement as any),
        tryBlock: {
          ...(statement as any).tryBlock,
          body: (statement as any).tryBlock.body.map((child: Statement) => lowerStatement(child))
        },
        ...((statement as any).catchClause
          ? {
              catchClause: {
                ...(statement as any).catchClause,
                body: {
                  ...(statement as any).catchClause.body,
                  body: (statement as any).catchClause.body.body.map((child: Statement) =>
                    lowerStatement(child)
                  )
                }
              }
            }
          : {}),
        ...((statement as any).finallyBlock
          ? {
              finallyBlock: {
                ...(statement as any).finallyBlock,
                body: (statement as any).finallyBlock.body.map((child: Statement) =>
                  lowerStatement(child)
                )
              }
            }
          : {})
      } as Statement, statement);
    case "VarStatement":
      return cloneVarStatement(statement as VarStatement) as unknown as Statement;
    default:
      return copyNodeBounds({ ...(statement as any) } as Statement, statement);
  }
}

export function lowerProgram(program: Program): Program {
  return {
    ...program,
    body: program.body.map((statement) => lowerStatement(statement))
  };
}
