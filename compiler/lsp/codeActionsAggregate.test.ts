import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { collectCodeActions } from "./codeActionsAggregate";
import type { Range } from "vscode-languageserver/node.js";

const URI = "file:///demo.my";

function pointRange(line: number, character: number): Range {
  return {
    start: { line, character },
    end: { line, character }
  };
}

describe("collectCodeActions aggregator", () => {
  it("returns no actions when there is no AST", () => {
    expect(
      collectCodeActions({
        uri: URI,
        text: "",
        ast: null,
        analysis: null,
        range: pointRange(0, 0),
        diagnostics: [],
        sourceRoots: []
      })
    ).toHaveLength(0);
  });

  it("offers a declaration-keyword replacement quick fix", () => {
    const source = "let value = 1\n";
    const session = createAnalysisSession(source);
    const actions = collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(0, 1),
      diagnostics: [],
      sourceRoots: []
    });
    const titles = actions.map((action) => action.title);
    expect(titles).toContain("Replace 'let' with 'const'");
  });

  it("offers a string-concatenation to template-literal quick fix", () => {
    const source =
      "class Rectangle {\n" +
      "  describe() {\n" +
      "    return \"Rectangle(\" + this.width + \"x\" + this.height + \")\"\n" +
      "  }\n" +
      "}\n";
    const session = createAnalysisSession(source);
    const actions = collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(2, 33),
      diagnostics: [],
      sourceRoots: []
    });
    const templateAction = actions.find(
      (action) => action.title === "Convert string concatenation to template literal"
    );
    expect(templateAction).toBeTruthy();
    expect(templateAction?.edit?.changes?.[URI]?.[0]?.newText).toBe(
      "`Rectangle(${this.width}x${this.height})`"
    );
  });
});
