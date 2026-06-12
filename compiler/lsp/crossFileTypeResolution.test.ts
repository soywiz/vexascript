import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import type { Identifier } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import { collectMemberExpressions, findMemberExpressionAtPosition } from "./crossFileTypeResolution";

describe("cross-file type resolution member lookups", () => {
  it("finds the member expression whose property contains the cursor", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: int, val y: int)
      fun demo(point: Point): int {
        return point.^^^x
      }
      `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();

    const member = findMemberExpressionAtPosition(session.ast!, line, character);
    expect(member).toBeTruthy();
    expect((member!.property as Identifier).name).toBe("x");
  });

  it("finds member expressions inside lambda bodies passed as arguments", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: int, val y: int)
      fun apply(callback: () => int): int { return callback() }
      fun demo(point: Point): int {
        return apply(() => point.^^^y)
      }
      `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();

    const member = findMemberExpressionAtPosition(session.ast!, line, character);
    expect(member).toBeTruthy();
    expect((member!.property as Identifier).name).toBe("y");
  });

  it("collects member expressions from every structural position", () => {
    const source = dedent`
      class Point(val x: int, val y: int)
      fun demo(point: Point): int {
        val horizontal = point.x
        return [point.y].length
      }
      `;
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();

    const names = collectMemberExpressions(session.ast!)
      .filter((member) => member.property.kind === "Identifier")
      .map((member) => (member.property as Identifier).name)
      .sort();
    expect(names).toEqual(["length", "x", "y"]);
  });
});
