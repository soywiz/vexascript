import type {
  Expr,
  ForStatement,
  Program,
  Statement,
  UpdateExpression,
  VarStatement
} from "compiler/ast/ast";

function cloneExpression<T extends Expr>(expression: T): T {
  return expression;
}

function cloneVarStatement(statement: VarStatement): VarStatement {
  return {
    ...statement,
    ...(statement.declarations
      ? {
          declarations: statement.declarations.map((declaration) => ({ ...declaration }))
        }
      : {})
  };
}

function lowerForStatement(statement: ForStatement): ForStatement {
  if (!(statement.iterationKind && statement.iterator && statement.iterable)) {
    return {
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
    };
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

      return {
        kind: "ForStatement",
        initializer: loweredInitializer,
        condition: loweredCondition,
        update: loweredUpdate as unknown as Expr,
        body: lowerStatement(statement.body)
      };
    }
  }

  return {
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
  };
}

function lowerStatement(statement: Statement): Statement {
  switch (statement.kind) {
    case "ForStatement":
      return lowerForStatement(statement as ForStatement);
    case "BlockStatement":
      return {
        ...(statement as any),
        body: (statement as any).body.map((child: Statement) => lowerStatement(child))
      } as Statement;
    case "FunctionStatement":
      return {
        ...(statement as any),
        body: {
          ...(statement as any).body,
          body: (statement as any).body.body.map((child: Statement) => lowerStatement(child))
        }
      } as Statement;
    case "ClassStatement":
      return {
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
      } as Statement;
    case "IfStatement":
      return {
        ...(statement as any),
        thenBranch: lowerStatement((statement as any).thenBranch),
        ...((statement as any).elseBranch
          ? {
              elseBranch: lowerStatement((statement as any).elseBranch)
            }
          : {})
      } as Statement;
    case "WhileStatement":
    case "DoWhileStatement":
      return {
        ...(statement as any),
        body: lowerStatement((statement as any).body)
      } as Statement;
    case "SwitchStatement":
      return {
        ...(statement as any),
        cases: (statement as any).cases.map((switchCase: any) => ({
          ...switchCase,
          consequent: switchCase.consequent.map((child: Statement) => lowerStatement(child))
        }))
      } as Statement;
    case "TryStatement":
      return {
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
      } as Statement;
    case "VarStatement":
      return cloneVarStatement(statement as VarStatement) as unknown as Statement;
    default:
      return { ...(statement as any) } as Statement;
  }
}

export function lowerProgram(program: Program): Program {
  return {
    ...program,
    body: program.body.map((statement) => lowerStatement(statement))
  };
}
