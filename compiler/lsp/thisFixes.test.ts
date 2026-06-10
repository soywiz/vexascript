import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { sourceWithCursor } from "../test/sourceWithCursor";
import { createAnalysisSession } from "./analysisSession";
import { createThisCodeActions } from "./thisFixes";

describe("this quick fixes", () => {
  it("adds this. to an implicit instance member reference", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Counter {
        value: int

        read(): int {
          return va^^^lue
        }
      }
    `);

    const session = createAnalysisSession(source);
    const actions = createThisCodeActions({
      uri: "file:///demo.vx",
      ast: session.ast,
      analysis: session.analysis,
      position: { line, character }
    });

    expect(actions.map((action) => action.title)).toContain("Add 'this.' to 'value'");
    const edit = actions.find((action) => action.title === "Add 'this.' to 'value'")?.edit?.changes?.["file:///demo.vx"]?.[0];
    expect(edit?.newText).toBe("this.");
  });

  it("removes this. when unqualified lookup still resolves to the same member", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Counter {
        value: int

        read(): int {
          return this.va^^^lue
        }
      }
    `);

    const session = createAnalysisSession(source);
    const actions = createThisCodeActions({
      uri: "file:///demo.vx",
      ast: session.ast,
      analysis: session.analysis,
      position: { line, character }
    });

    expect(actions.map((action) => action.title)).toContain("Remove 'this.' from 'value'");
    const edit = actions.find((action) => action.title === "Remove 'this.' from 'value'")?.edit?.changes?.["file:///demo.vx"]?.[0];
    expect(edit?.newText).toBe("");
  });

  it("does not remove this. when a local binding would shadow the member", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Counter {
        value: int

        read(): int {
          const value = 1
          return this.va^^^lue
        }
      }
    `);

    const session = createAnalysisSession(source);
    const actions = createThisCodeActions({
      uri: "file:///demo.vx",
      ast: session.ast,
      analysis: session.analysis,
      position: { line, character }
    });

    expect(actions.map((action) => action.title)).not.toContain("Remove 'this.' from 'value'");
  });
});
