import { NodeKind } from "compiler/ast/ast";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Statement } from "compiler/ast/ast";
import {
  isAsyncLike,
  statementAllowsLabeledContinue,
  statementAlwaysExits,
  statementListAlwaysExits,
  statementListPreventsSwitchFallthrough,
  statementPreventsSwitchFallthrough,
} from "./controlFlow";

function stmt(kind: NodeKind, extra?: object): Statement {
  return { kind, ...extra } as unknown as Statement;
}

describe("isAsyncLike", () => {
  it("returns true when async is set", () => {
    assert.equal(isAsyncLike(true), true);
  });

  it("returns true when sync is set", () => {
    assert.equal(isAsyncLike(undefined, true), true);
  });

  it("returns false when neither flag is set", () => {
    assert.equal(isAsyncLike(), false);
  });

  it("returns false when both flags are false", () => {
    assert.equal(isAsyncLike(false, false), false);
  });
});

describe("statementAllowsLabeledContinue", () => {
  it("returns true for WhileStatement", () => {
    assert.equal(statementAllowsLabeledContinue(stmt(NodeKind.WhileStatement)), true);
  });

  it("returns true for DoWhileStatement", () => {
    assert.equal(statementAllowsLabeledContinue(stmt(NodeKind.DoWhileStatement)), true);
  });

  it("returns true for ForStatement", () => {
    assert.equal(statementAllowsLabeledContinue(stmt(NodeKind.ForStatement)), true);
  });

  it("returns false for non-loop statements", () => {
    assert.equal(statementAllowsLabeledContinue(stmt(NodeKind.IfStatement)), false);
    assert.equal(statementAllowsLabeledContinue(stmt(NodeKind.ReturnStatement)), false);
    assert.equal(statementAllowsLabeledContinue(stmt(NodeKind.BlockStatement, { body: [] })), false);
  });

  it("returns true for LabeledStatement wrapping a loop", () => {
    const labeled = stmt(NodeKind.LabeledStatement, { body: stmt(NodeKind.WhileStatement) });
    assert.equal(statementAllowsLabeledContinue(labeled), true);
  });

  it("returns false for LabeledStatement wrapping a non-loop", () => {
    const labeled = stmt(NodeKind.LabeledStatement, { body: stmt(NodeKind.IfStatement) });
    assert.equal(statementAllowsLabeledContinue(labeled), false);
  });
});

describe("statementPreventsSwitchFallthrough", () => {
  it("returns true for BreakStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt(NodeKind.BreakStatement)), true);
  });

  it("returns true for ContinueStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt(NodeKind.ContinueStatement)), true);
  });

  it("returns true for ReturnStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt(NodeKind.ReturnStatement)), true);
  });

  it("returns true for ThrowStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt(NodeKind.ThrowStatement)), true);
  });

  it("returns false for ExpressionStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt(NodeKind.ExprStatement)), false);
  });

  it("returns true for BlockStatement containing a break", () => {
    const block = stmt(NodeKind.BlockStatement, { body: [stmt(NodeKind.BreakStatement)] });
    assert.equal(statementPreventsSwitchFallthrough(block), true);
  });

  it("returns false for empty BlockStatement", () => {
    const block = stmt(NodeKind.BlockStatement, { body: [] });
    assert.equal(statementPreventsSwitchFallthrough(block), false);
  });

  it("returns true for IfStatement with both branches that prevent fallthrough", () => {
    const ifStmt = stmt(NodeKind.IfStatement, {
      thenBranch: stmt(NodeKind.ReturnStatement),
      elseBranch: stmt(NodeKind.BreakStatement),
    });
    assert.equal(statementPreventsSwitchFallthrough(ifStmt), true);
  });

  it("returns false for IfStatement without else branch", () => {
    const ifStmt = stmt(NodeKind.IfStatement, {
      thenBranch: stmt(NodeKind.ReturnStatement),
      elseBranch: undefined,
    });
    assert.equal(statementPreventsSwitchFallthrough(ifStmt), false);
  });

  it("returns false for IfStatement where only one branch prevents fallthrough", () => {
    const ifStmt = stmt(NodeKind.IfStatement, {
      thenBranch: stmt(NodeKind.ReturnStatement),
      elseBranch: stmt(NodeKind.ExprStatement),
    });
    assert.equal(statementPreventsSwitchFallthrough(ifStmt), false);
  });

  it("returns true for TryStatement where finally prevents fallthrough", () => {
    const tryStmt = stmt(NodeKind.TryStatement, {
      tryBlock: stmt(NodeKind.ExprStatement),
      catchClause: undefined,
      finallyBlock: stmt(NodeKind.ReturnStatement),
    });
    assert.equal(statementPreventsSwitchFallthrough(tryStmt), true);
  });

  it("returns true for TryStatement where try and catch both prevent fallthrough", () => {
    const tryStmt = stmt(NodeKind.TryStatement, {
      tryBlock: stmt(NodeKind.ReturnStatement),
      catchClause: { body: stmt(NodeKind.ThrowStatement) },
      finallyBlock: undefined,
    });
    assert.equal(statementPreventsSwitchFallthrough(tryStmt), true);
  });

  it("returns false for TryStatement where catch does not prevent fallthrough", () => {
    const tryStmt = stmt(NodeKind.TryStatement, {
      tryBlock: stmt(NodeKind.ReturnStatement),
      catchClause: { body: stmt(NodeKind.ExprStatement) },
      finallyBlock: undefined,
    });
    assert.equal(statementPreventsSwitchFallthrough(tryStmt), false);
  });

  it("delegates through WithStatement", () => {
    const withStmt = stmt(NodeKind.WithStatement, { body: stmt(NodeKind.ReturnStatement) });
    assert.equal(statementPreventsSwitchFallthrough(withStmt), true);
  });

  it("delegates through LabeledStatement", () => {
    const labeled = stmt(NodeKind.LabeledStatement, { body: stmt(NodeKind.BreakStatement) });
    assert.equal(statementPreventsSwitchFallthrough(labeled), true);
  });
});

describe("statementAlwaysExits", () => {
  it("returns true for ReturnStatement", () => {
    assert.equal(statementAlwaysExits(stmt(NodeKind.ReturnStatement)), true);
  });

  it("returns true for ThrowStatement", () => {
    assert.equal(statementAlwaysExits(stmt(NodeKind.ThrowStatement)), true);
  });

  it("returns false for ExpressionStatement", () => {
    assert.equal(statementAlwaysExits(stmt(NodeKind.ExprStatement)), false);
  });

  it("returns false for DeferStatement", () => {
    assert.equal(statementAlwaysExits(stmt(NodeKind.DeferStatement)), false);
  });

  it("returns true for BlockStatement containing a return", () => {
    const block = stmt(NodeKind.BlockStatement, { body: [stmt(NodeKind.ReturnStatement)] });
    assert.equal(statementAlwaysExits(block), true);
  });

  it("returns false for empty BlockStatement", () => {
    const block = stmt(NodeKind.BlockStatement, { body: [] });
    assert.equal(statementAlwaysExits(block), false);
  });

  it("returns true for IfStatement where both branches always exit", () => {
    const ifStmt = stmt(NodeKind.IfStatement, {
      thenBranch: stmt(NodeKind.ReturnStatement),
      elseBranch: stmt(NodeKind.ThrowStatement),
    });
    assert.equal(statementAlwaysExits(ifStmt), true);
  });

  it("returns false for IfStatement without else branch", () => {
    const ifStmt = stmt(NodeKind.IfStatement, {
      thenBranch: stmt(NodeKind.ReturnStatement),
      elseBranch: undefined,
    });
    assert.equal(statementAlwaysExits(ifStmt), false);
  });

  it("returns false for IfStatement where only then branch exits", () => {
    const ifStmt = stmt(NodeKind.IfStatement, {
      thenBranch: stmt(NodeKind.ReturnStatement),
      elseBranch: stmt(NodeKind.ExprStatement),
    });
    assert.equal(statementAlwaysExits(ifStmt), false);
  });

  it("returns true for DoWhileStatement whose body always exits", () => {
    const doWhile = stmt(NodeKind.DoWhileStatement, { body: stmt(NodeKind.ReturnStatement) });
    assert.equal(statementAlwaysExits(doWhile), true);
  });

  it("returns false for DoWhileStatement whose body does not exit", () => {
    const doWhile = stmt(NodeKind.DoWhileStatement, { body: stmt(NodeKind.ExprStatement) });
    assert.equal(statementAlwaysExits(doWhile), false);
  });

  it("returns false for SwitchStatement with no default case", () => {
    const switchStmt = stmt(NodeKind.SwitchStatement, {
      cases: [{ test: stmt(NodeKind.ExprStatement), consequent: [stmt(NodeKind.ReturnStatement)] }],
    });
    assert.equal(statementAlwaysExits(switchStmt), false);
  });

  it("returns true for SwitchStatement with default case where all paths exit", () => {
    const switchStmt = stmt(NodeKind.SwitchStatement, {
      cases: [
        { test: stmt(NodeKind.ExprStatement), consequent: [stmt(NodeKind.ReturnStatement)] },
        { test: undefined, consequent: [stmt(NodeKind.ThrowStatement)] },
      ],
    });
    assert.equal(statementAlwaysExits(switchStmt), true);
  });

  it("returns true for TryStatement where finally always exits", () => {
    const tryStmt = stmt(NodeKind.TryStatement, {
      tryBlock: stmt(NodeKind.ExprStatement),
      catchClause: undefined,
      finallyBlock: stmt(NodeKind.ReturnStatement),
    });
    assert.equal(statementAlwaysExits(tryStmt), true);
  });

  it("returns true for TryStatement where try and catch both exit", () => {
    const tryStmt = stmt(NodeKind.TryStatement, {
      tryBlock: stmt(NodeKind.ReturnStatement),
      catchClause: { body: stmt(NodeKind.ThrowStatement) },
      finallyBlock: undefined,
    });
    assert.equal(statementAlwaysExits(tryStmt), true);
  });

  it("returns false for TryStatement where catch does not exit", () => {
    const tryStmt = stmt(NodeKind.TryStatement, {
      tryBlock: stmt(NodeKind.ReturnStatement),
      catchClause: { body: stmt(NodeKind.ExprStatement) },
      finallyBlock: undefined,
    });
    assert.equal(statementAlwaysExits(tryStmt), false);
  });

  it("delegates through WithStatement", () => {
    const withStmt = stmt(NodeKind.WithStatement, { body: stmt(NodeKind.ReturnStatement) });
    assert.equal(statementAlwaysExits(withStmt), true);
  });

  it("delegates through LabeledStatement", () => {
    const labeled = stmt(NodeKind.LabeledStatement, { body: stmt(NodeKind.ReturnStatement) });
    assert.equal(statementAlwaysExits(labeled), true);
  });
});

describe("statementListAlwaysExits", () => {
  it("returns false for an empty list", () => {
    assert.equal(statementListAlwaysExits([]), false);
  });

  it("returns true when an earlier statement always exits", () => {
    assert.equal(
      statementListAlwaysExits([stmt(NodeKind.ReturnStatement), stmt(NodeKind.ExprStatement)]),
      true
    );
  });

  it("returns false when no statement exits", () => {
    assert.equal(
      statementListAlwaysExits([stmt(NodeKind.ExprStatement), stmt(NodeKind.ExprStatement)]),
      false
    );
  });

  it("stops scanning after BreakStatement", () => {
    assert.equal(
      statementListAlwaysExits([stmt(NodeKind.BreakStatement), stmt(NodeKind.ReturnStatement)]),
      false
    );
  });

  it("stops scanning after ContinueStatement", () => {
    assert.equal(
      statementListAlwaysExits([stmt(NodeKind.ContinueStatement), stmt(NodeKind.ReturnStatement)]),
      false
    );
  });
});

describe("statementListPreventsSwitchFallthrough", () => {
  it("returns false for an empty list", () => {
    assert.equal(statementListPreventsSwitchFallthrough([]), false);
  });

  it("returns true when any statement in the list prevents fallthrough", () => {
    assert.equal(
      statementListPreventsSwitchFallthrough([stmt(NodeKind.ExprStatement), stmt(NodeKind.ReturnStatement)]),
      true
    );
  });

  it("returns false when no statement prevents fallthrough", () => {
    assert.equal(
      statementListPreventsSwitchFallthrough([stmt(NodeKind.ExprStatement), stmt(NodeKind.ExprStatement)]),
      false
    );
  });
});
