import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectCodeActions } from "./codeActionsAggregate";
import { collectDiagnosticsFromSession } from "./diagnostics";
import type { Range } from "vscode-languageserver/node.js";

const URI = "file:///demo.vx";

function pointRange(line: number, character: number): Range {
  return {
    start: { line, character },
    end: { line, character }
  };
}

function positionAt(text: string, offset: number) {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: Math.min(offset, text.length) - lineStart };
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
    expect(titles).toContain("Replace 'let' with 'var'");
    expect(titles).toContain("Replace 'let' with 'val'");
  });

  it("offers class-member keyword quick fixes for the preferred member style", async () => {
    const source = "class Demo {\n  save(): void {\n  }\n}\n";
    const session = createAnalysisSession(source);
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(1, 3),
      diagnostics: [],
      sourceRoots: []
    });
    const titles = actions.map((action) => action.title);

    expect(titles).toContain("Add 'fun' keyword");
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

  it("offers a quick fix to remove an unused import", async () => {
    const source = dedent`
      import { readFile, utimes } from "fs/promises"
      await readFile("demo.txt")
      `;
    const session = createAnalysisSession(source);
    const diagnostics = collectDiagnosticsFromSession(session, source, (offset) => positionAt(source, offset));
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(0, 21),
      diagnostics,
      sourceRoots: []
    });

    expect(actions.map((action) => action.title)).toContain("Remove unused import 'utimes'");
  });

  it("offers the assign-to-variable quick fix for bare expression statements", async () => {
    const source = dedent`
      join("hello", "world")
      `;
    const session = createAnalysisSession(source);
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(0, 4),
      diagnostics: [],
      sourceRoots: []
    });

    const action = actions.find((candidate) => candidate.title === "Assign to variable");
    expect(action).toBeTruthy();
    expect(action?.edit?.changes?.[URI]?.[0]?.newText).toBe('val variable = join("hello", "world")');
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
