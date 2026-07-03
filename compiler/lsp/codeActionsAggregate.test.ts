import { describe, expect, it, readFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectCodeActions } from "./codeActionsAggregate";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
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

function positionToOffset(text: string, position: { line: number; character: number }): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line && lineStart <= text.length) {
    const nextBreak = text.indexOf("\n", lineStart);
    if (nextBreak < 0) {
      return text.length;
    }
    line += 1;
    lineStart = nextBreak + 1;
  }
  return Math.min(text.length, lineStart + position.character);
}

function applyFirstEdit(text: string, action: NonNullable<Awaited<ReturnType<typeof collectCodeActions>>[number]>) {
  const edit = action.edit?.changes?.[URI]?.[0];
  if (!edit) {
    throw new Error("Expected edit");
  }
  const start = positionToOffset(text, edit.range.start);
  const end = positionToOffset(text, edit.range.end);
  return text.slice(0, start) + edit.newText + text.slice(end);
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

  it("offers an 'Add override' quick fix for a member missing the modifier", async () => {
    const source = dedent`
      interface Sample {
        fun lol2()
      }
      class Demo implements Sample {
        fun lol2(): void {
        }
      }
      `;
    const session = createAnalysisSession(source);
    const diagnostics = collectDiagnosticsFromSession(session, source, (offset) => positionAt(source, offset));
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(4, 6),
      diagnostics,
      sourceRoots: []
    });

    expect(actions.map((action) => action.title)).toContain("Add 'override' to 'lol2'");
  });

  it("offers an 'Add override' quick fix for project ambient base members", async () => {
    const source = dedent`
      class Demo extends Component {
        fun onCollider(other: ViewNode) {
        }
      }
      `;
    const ambientDeclarations = parseFile(tokenizeReader(dedent`
      class ViewNode {}
      class Component {
        fun onCollider(other: ViewNode) {}
      }
      `)).body;
    const session = createAnalysisSession(source, { ambientDeclarations });
    const diagnostics = collectDiagnosticsFromSession(session, source, (offset) => positionAt(source, offset));
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(1, 6),
      diagnostics,
      sourceRoots: []
    });

    expect(actions.map((action) => action.title)).toContain("Add 'override' to 'onCollider'");
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

  it("offers a quick fix to remove a duplicate class variable", async () => {
    const source = dedent`
      class Demo {
        var title: string
        var title: string
        var count: int
      }
      `;
    const session = createAnalysisSession(source);
    const diagnostics = collectDiagnosticsFromSession(session, source, (offset) => positionAt(source, offset));
    const actions = await collectCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: pointRange(2, 7),
      diagnostics,
      sourceRoots: []
    });
    const action = actions.find((candidate) => candidate.title === "Remove duplicate class variable 'title'");

    expect(action).toBeTruthy();
    expect(applyFirstEdit(source, action!)).toBe(dedent`
      class Demo {
        var title: string
        var count: int
      }
      `);
  });

  it("does not expose the assign-to-variable quick fix from the shared aggregator", async () => {
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
    expect(action).toBeUndefined();
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
