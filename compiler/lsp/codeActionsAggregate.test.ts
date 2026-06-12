import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectCodeActions } from "./codeActionsAggregate";
import type { Range } from "vscode-languageserver/node.js";

const URI = "file:///demo.vx";

function pointRange(line: number, character: number): Range {
  return {
    start: { line, character },
    end: { line, character }
  };
}

describe("collectCodeActions aggregator", () => {
  it("returns no actions when there is no AST", async () => {
    expect(
      await collectCodeActions({
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

  it("offers a declaration-keyword replacement quick fix", async () => {
    const source = "let value = 1\n";
    const session = createAnalysisSession(source);
    const actions = await collectCodeActions({
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

  it("offers an explicit return type quick fix", async () => {
    const source = "function add(a: number, b: number) {\n  return a + b\n}\n";
    const session = createAnalysisSession(source);
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(0, 34),
      diagnostics: [],
      sourceRoots: []
    });
    const titles = actions.map((action) => action.title);
    expect(titles).toContain("Add explicit return type ': number'");
  });

  it("offers a string-concatenation to template-literal quick fix", async () => {
    const source = dedent`
      class Rectangle {
        describe() {
          return "Rectangle(" + this.width + "x" + this.height + ")"
        }
      }
      `;
    const session = createAnalysisSession(source);
    const actions = await collectCodeActions({
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

  it("offers nullable member-access quick fixes", async () => {
    const source = dedent`
      interface ElementLike {
        querySelector(value: string): ElementLike | null
      }
      let root: ElementLike
      root.querySelector(".demo").querySelector("test")
      `;
    const session = createAnalysisSession(source);
    const diagnostics = session.semanticIssues.map((issue) => {
      const range = issue.range;
      if (!range) {
        throw new Error("Expected nullable diagnostic range");
      }
      return {
        message: issue.message,
        range,
        source: "vexa-sema"
      };
    });
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(4, 31),
      diagnostics,
      sourceRoots: []
    });
    const titles = actions.map((action) => action.title);

    expect(titles).toContain("Use optional access '?.'");
    expect(titles).toContain("Use non-null assertion '!.'");
  });

  it("keeps both LSP transports on the shared code-action aggregator", async () => {
    const serverCore = await readFile("compiler/lsp/serverCore.ts", "utf8");
    const browserServer = await readFile("compiler/lsp/server-browser.ts", "utf8");
    const nodeServer = await readFile("compiler/lsp/server.ts", "utf8");

    expect(serverCore).toContain('import { collectCodeActions } from "./codeActionsAggregate";');
    for (const transport of [browserServer, nodeServer]) {
      expect(transport).toContain('import { startLspServer } from "./serverCore";');
      expect(transport).not.toContain("collectCodeActions");
      expect(transport).not.toContain("createStringTemplateCodeActions");
      expect(transport).not.toContain("createTypeFixCodeActions");
      expect(transport).not.toContain("findDeclarationKeywordReplacementAtPosition");
    }
  });
});
