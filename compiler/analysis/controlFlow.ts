/**
 * Pure control-flow predicates over AST statement nodes. These helpers have
 * no dependency on checker state and can be used by any analysis pass.
 */
import type {
  BlockStatement,
  IfStatement,
  LabeledStatement,
  Statement,
  TryStatement,
  WithStatement,
} from "compiler/ast/ast";

export function isAsyncLike(node: { async?: boolean; sync?: boolean }): boolean {
  return node.async === true || node.sync === true;
}

export function statementAllowsLabeledContinue(statement: Statement): boolean {
  if (
    statement.kind === "WhileStatement" ||
    statement.kind === "DoWhileStatement" ||
    statement.kind === "ForStatement"
  ) {
    return true;
  }
  if (statement.kind === "LabeledStatement") {
    return statementAllowsLabeledContinue((statement as LabeledStatement).body);
  }
  return false;
}

export function statementListPreventsSwitchFallthrough(statements: Statement[]): boolean {
  for (const statement of statements) {
    if (statementPreventsSwitchFallthrough(statement)) {
      return true;
    }
  }
  return false;
}

export function statementPreventsSwitchFallthrough(statement: Statement): boolean {
  switch (statement.kind) {
    case "BreakStatement":
    case "ContinueStatement":
    case "ReturnStatement":
    case "ThrowStatement":
      return true;
    case "BlockStatement":
      return statementListPreventsSwitchFallthrough((statement as BlockStatement).body);
    case "IfStatement": {
      const conditional = statement as IfStatement;
      return (
        conditional.elseBranch !== undefined &&
        statementPreventsSwitchFallthrough(conditional.thenBranch) &&
        statementPreventsSwitchFallthrough(conditional.elseBranch)
      );
    }
    case "TryStatement": {
      const tryStatement = statement as TryStatement;
      if (tryStatement.finallyBlock && statementPreventsSwitchFallthrough(tryStatement.finallyBlock)) {
        return true;
      }
      return (
        statementPreventsSwitchFallthrough(tryStatement.tryBlock) &&
        (tryStatement.catchClause === undefined ||
          statementPreventsSwitchFallthrough(tryStatement.catchClause.body))
      );
    }
    case "WithStatement":
      return statementPreventsSwitchFallthrough((statement as WithStatement).body);
    case "LabeledStatement":
      return statementPreventsSwitchFallthrough((statement as LabeledStatement).body);
    default:
      return false;
  }
}
