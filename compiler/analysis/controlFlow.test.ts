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

function stmt(kind: string, extra?: object): Statement {
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
    assert.equal(statementAllowsLabeledContinue(stmt("WhileStatement")), true);
  });

  it("returns true for DoWhileStatement", () => {
    assert.equal(statementAllowsLabeledContinue(stmt("DoWhileStatement")), true);
  });

  it("returns true for ForStatement", () => {
    assert.equal(statementAllowsLabeledContinue(stmt("ForStatement")), true);
  });

  it("returns false for non-loop statements", () => {
    assert.equal(statementAllowsLabeledContinue(stmt("IfStatement")), false);
    assert.equal(statementAllowsLabeledContinue(stmt("ReturnStatement")), false);
    assert.equal(statementAllowsLabeledContinue(stmt("BlockStatement", { body: [] })), false);
  });

  it("returns true for LabeledStatement wrapping a loop", () => {
    const labeled = stmt("LabeledStatement", { body: stmt("WhileStatement") });
    assert.equal(statementAllowsLabeledContinue(labeled), true);
  });

  it("returns false for LabeledStatement wrapping a non-loop", () => {
    const labeled = stmt("LabeledStatement", { body: stmt("IfStatement") });
    assert.equal(statementAllowsLabeledContinue(labeled), false);
  });
});

describe("statementPreventsSwitchFallthrough", () => {
  it("returns true for BreakStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt("BreakStatement")), true);
  });

  it("returns true for ContinueStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt("ContinueStatement")), true);
  });

  it("returns true for ReturnStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt("ReturnStatement")), true);
  });

  it("returns true for ThrowStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt("ThrowStatement")), true);
  });

  it("returns false for ExpressionStatement", () => {
    assert.equal(statementPreventsSwitchFallthrough(stmt("ExpressionStatement")), false);
  });

  it("returns true for BlockStatement containing a break", () => {
    const block = stmt("BlockStatement", { body: [stmt("BreakStatement")] });
    assert.equal(statementPreventsSwitchFallthrough(block), true);
  });

  it("returns false for empty BlockStatement", () => {
    const block = stmt("BlockStatement", { body: [] });
    assert.equal(statementPreventsSwitchFallthrough(block), false);
  });

  it("returns true for IfStatement with both branches that prevent fallthrough", () => {
    const ifStmt = stmt("IfStatement", {
      thenBranch: stmt("ReturnStatement"),
      elseBranch: stmt("BreakStatement"),
    });
    assert.equal(statementPreventsSwitchFallthrough(ifStmt), true);
  });

  it("returns false for IfStatement without else branch", () => {
    const ifStmt = stmt("IfStatement", {
      thenBranch: stmt("ReturnStatement"),
      elseBranch: undefined,
    });
    assert.equal(statementPreventsSwitchFallthrough(ifStmt), false);
  });

  it("returns false for IfStatement where only one branch prevents fallthrough", () => {
    const ifStmt = stmt("IfStatement", {
      thenBranch: stmt("ReturnStatement"),
      elseBranch: stmt("ExpressionStatement"),
    });
    assert.equal(statementPreventsSwitchFallthrough(ifStmt), false);
  });

  it("returns true for TryStatement where finally prevents fallthrough", () => {
    const tryStmt = stmt("TryStatement", {
      tryBlock: stmt("ExpressionStatement"),
      catchClause: undefined,
      finallyBlock: stmt("ReturnStatement"),
    });
    assert.equal(statementPreventsSwitchFallthrough(tryStmt), true);
  });

  it("returns true for TryStatement where try and catch both prevent fallthrough", () => {
    const tryStmt = stmt("TryStatement", {
      tryBlock: stmt("ReturnStatement"),
      catchClause: { body: stmt("ThrowStatement") },
      finallyBlock: undefined,
    });
    assert.equal(statementPreventsSwitchFallthrough(tryStmt), true);
  });

  it("returns false for TryStatement where catch does not prevent fallthrough", () => {
    const tryStmt = stmt("TryStatement", {
      tryBlock: stmt("ReturnStatement"),
      catchClause: { body: stmt("ExpressionStatement") },
      finallyBlock: undefined,
    });
    assert.equal(statementPreventsSwitchFallthrough(tryStmt), false);
  });

  it("delegates through WithStatement", () => {
    const withStmt = stmt("WithStatement", { body: stmt("ReturnStatement") });
    assert.equal(statementPreventsSwitchFallthrough(withStmt), true);
  });

  it("delegates through LabeledStatement", () => {
    const labeled = stmt("LabeledStatement", { body: stmt("BreakStatement") });
    assert.equal(statementPreventsSwitchFallthrough(labeled), true);
  });
});

describe("statementAlwaysExits", () => {
  it("returns true for ReturnStatement", () => {
    assert.equal(statementAlwaysExits(stmt("ReturnStatement")), true);
  });

  it("returns true for ThrowStatement", () => {
    assert.equal(statementAlwaysExits(stmt("ThrowStatement")), true);
  });

  it("returns false for ExpressionStatement", () => {
    assert.equal(statementAlwaysExits(stmt("ExpressionStatement")), false);
  });

  it("returns false for DeferStatement", () => {
    assert.equal(statementAlwaysExits(stmt("DeferStatement")), false);
  });

  it("returns true for BlockStatement containing a return", () => {
    const block = stmt("BlockStatement", { body: [stmt("ReturnStatement")] });
    assert.equal(statementAlwaysExits(block), true);
  });

  it("returns false for empty BlockStatement", () => {
    const block = stmt("BlockStatement", { body: [] });
    assert.equal(statementAlwaysExits(block), false);
  });

  it("returns true for IfStatement where both branches always exit", () => {
    const ifStmt = stmt("IfStatement", {
      thenBranch: stmt("ReturnStatement"),
      elseBranch: stmt("ThrowStatement"),
    });
    assert.equal(statementAlwaysExits(ifStmt), true);
  });

  it("returns false for IfStatement without else branch", () => {
    const ifStmt = stmt("IfStatement", {
      thenBranch: stmt("ReturnStatement"),
      elseBranch: undefined,
    });
    assert.equal(statementAlwaysExits(ifStmt), false);
  });

  it("returns false for IfStatement where only then branch exits", () => {
    const ifStmt = stmt("IfStatement", {
      thenBranch: stmt("ReturnStatement"),
      elseBranch: stmt("ExpressionStatement"),
    });
    assert.equal(statementAlwaysExits(ifStmt), false);
  });

  it("returns true for DoWhileStatement whose body always exits", () => {
    const doWhile = stmt("DoWhileStatement", { body: stmt("ReturnStatement") });
    assert.equal(statementAlwaysExits(doWhile), true);
  });

  it("returns false for DoWhileStatement whose body does not exit", () => {
    const doWhile = stmt("DoWhileStatement", { body: stmt("ExpressionStatement") });
    assert.equal(statementAlwaysExits(doWhile), false);
  });

  it("returns false for SwitchStatement with no default case", () => {
    const switchStmt = stmt("SwitchStatement", {
      cases: [{ test: stmt("ExpressionStatement"), consequent: [stmt("ReturnStatement")] }],
    });
    assert.equal(statementAlwaysExits(switchStmt), false);
  });

  it("returns true for SwitchStatement with default case where all paths exit", () => {
    const switchStmt = stmt("SwitchStatement", {
      cases: [
        { test: stmt("ExpressionStatement"), consequent: [stmt("ReturnStatement")] },
        { test: undefined, consequent: [stmt("ThrowStatement")] },
      ],
    });
    assert.equal(statementAlwaysExits(switchStmt), true);
  });

  it("returns true for TryStatement where finally always exits", () => {
    const tryStmt = stmt("TryStatement", {
      tryBlock: stmt("ExpressionStatement"),
      catchClause: undefined,
      finallyBlock: stmt("ReturnStatement"),
    });
    assert.equal(statementAlwaysExits(tryStmt), true);
  });

  it("returns true for TryStatement where try and catch both exit", () => {
    const tryStmt = stmt("TryStatement", {
      tryBlock: stmt("ReturnStatement"),
      catchClause: { body: stmt("ThrowStatement") },
      finallyBlock: undefined,
    });
    assert.equal(statementAlwaysExits(tryStmt), true);
  });

  it("returns false for TryStatement where catch does not exit", () => {
    const tryStmt = stmt("TryStatement", {
      tryBlock: stmt("ReturnStatement"),
      catchClause: { body: stmt("ExpressionStatement") },
      finallyBlock: undefined,
    });
    assert.equal(statementAlwaysExits(tryStmt), false);
  });

  it("delegates through WithStatement", () => {
    const withStmt = stmt("WithStatement", { body: stmt("ReturnStatement") });
    assert.equal(statementAlwaysExits(withStmt), true);
  });

  it("delegates through LabeledStatement", () => {
    const labeled = stmt("LabeledStatement", { body: stmt("ReturnStatement") });
    assert.equal(statementAlwaysExits(labeled), true);
  });
});

describe("statementListAlwaysExits", () => {
  it("returns false for an empty list", () => {
    assert.equal(statementListAlwaysExits([]), false);
  });

  it("returns true when an earlier statement always exits", () => {
    assert.equal(
      statementListAlwaysExits([stmt("ReturnStatement"), stmt("ExpressionStatement")]),
      true
    );
  });

  it("returns false when no statement exits", () => {
    assert.equal(
      statementListAlwaysExits([stmt("ExpressionStatement"), stmt("ExpressionStatement")]),
      false
    );
  });

  it("stops scanning after BreakStatement", () => {
    assert.equal(
      statementListAlwaysExits([stmt("BreakStatement"), stmt("ReturnStatement")]),
      false
    );
  });

  it("stops scanning after ContinueStatement", () => {
    assert.equal(
      statementListAlwaysExits([stmt("ContinueStatement"), stmt("ReturnStatement")]),
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
      statementListPreventsSwitchFallthrough([stmt("ExpressionStatement"), stmt("ReturnStatement")]),
      true
    );
  });

  it("returns false when no statement prevents fallthrough", () => {
    assert.equal(
      statementListPreventsSwitchFallthrough([stmt("ExpressionStatement"), stmt("ExpressionStatement")]),
      false
    );
  });
});
