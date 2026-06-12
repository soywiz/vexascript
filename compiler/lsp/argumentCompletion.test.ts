import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import type { Identifier } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import { findArgumentCompletionContext } from "./argumentCompletion";

describe("argument completion context", () => {
  it("finds the argument position of a direct call", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun add(a: int, b: int): int { return a + b }
      fun demo(): int {
        return add(1, 2^^^)
      }
      `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();

    const context = findArgumentCompletionContext(session.ast!, line, character);
    expect(context).toBeTruthy();
    expect(context!.kind).toBe("call");
    expect((context!.callee as Identifier).name).toBe("add");
    expect(context!.argumentIndex).toBe(1);
  });

  it("finds the innermost call inside a lambda passed as an argument", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun apply(callback: () => int): int { return callback() }
      fun add(a: int, b: int): int { return a + b }
      fun demo(): int {
        return apply(() => add(1, 2^^^))
      }
      `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();

    const context = findArgumentCompletionContext(session.ast!, line, character);
    expect(context).toBeTruthy();
    expect(context!.kind).toBe("call");
    expect((context!.callee as Identifier).name).toBe("add");
    expect(context!.argumentIndex).toBe(1);
  });

  it("returns null when the cursor is outside every argument list", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun add(a: int, b: int): int { return a + b }
      fun demo(): int {
        ^^^return add(1, 2)
      }
      `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();

    expect(findArgumentCompletionContext(session.ast!, line, character)).toBeNull();
  });
});
