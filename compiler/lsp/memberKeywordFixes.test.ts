import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createMemberKeywordCodeActions } from "./memberKeywordFixes";

const URI = "file:///demo.vx";

describe("member keyword quick fixes", () => {
  it("offers 'fun' for legacy class methods", () => {
    const source = dedent`
      class Demo {
        save(): void {
        }
      }
      `;
    const session = createAnalysisSession(source);
    const actions = createMemberKeywordCodeActions({
      uri: URI,
      ast: session.ast,
      position: { line: 1, character: 4 }
    });

    expect(actions.map((action) => action.title)).toEqual(["Add 'fun' keyword"]);
    expect(actions[0]?.edit?.changes?.[URI]?.[0]).toEqual({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 6 }
      },
      newText: "fun save"
    });
  });

  it("offers 'var' for legacy mutable class fields", () => {
    const source = dedent`
      class Demo {
        count: int
      }
      `;
    const session = createAnalysisSession(source);
    const actions = createMemberKeywordCodeActions({
      uri: URI,
      ast: session.ast,
      position: { line: 1, character: 3 }
    });

    expect(actions.map((action) => action.title)).toEqual(["Add 'var' keyword"]);
    expect(actions[0]?.edit?.changes?.[URI]?.[0]).toEqual({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 7 }
      },
      newText: "var count"
    });
  });

  it("offers 'var' for getter shorthand members written without an explicit keyword", () => {
    const source = dedent`
      class Demo {
        value => checksum
      }
      `;
    const session = createAnalysisSession(source);
    const actions = createMemberKeywordCodeActions({
      uri: URI,
      ast: session.ast,
      position: { line: 1, character: 3 }
    });

    expect(actions.map((action) => action.title)).toEqual(["Add 'var' keyword"]);
    expect(actions[0]?.edit?.changes?.[URI]?.[0]).toEqual({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 7 }
      },
      newText: "var value"
    });
  });

  it("does not offer 'var' when a getter shorthand already starts with a property keyword", () => {
    const source = dedent`
      class Demo {
        var value => checksum
      }
      `;
    const session = createAnalysisSession(source);
    const actions = createMemberKeywordCodeActions({
      uri: URI,
      ast: session.ast,
      position: { line: 1, character: 6 }
    });

    expect(actions).toEqual([]);
  });

  it("offers 'val' by replacing readonly on legacy readonly class fields", () => {
    const source = dedent`
      class Demo {
        readonly id: string
      }
      `;
    const session = createAnalysisSession(source);
    const actions = createMemberKeywordCodeActions({
      uri: URI,
      ast: session.ast,
      position: { line: 1, character: 5 }
    });

    expect(actions.map((action) => action.title)).toEqual(["Replace 'readonly' with 'val'"]);
    expect(actions[0]?.edit?.changes?.[URI]?.[0]).toEqual({
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 10 }
      },
      newText: "val"
    });
  });
});
