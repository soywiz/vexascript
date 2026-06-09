import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
import {
  AnalysisSessionCache,
  buildAnalysisForSource,
  createAnalysisSession
} from "./analysisSession";

describe("lsp analysis session", () => {
  it("builds analysis even when parser recovered from syntax errors", () => {
    const source = dedent`
      let = 1
      let ok = 1
      fun demo() {
        return ok
      }
      `;

    const analysis = buildAnalysisForSource(source);
    expect(analysis).not.toBeNull();
    expect(analysis?.getDefinitionAt(3, 9)?.symbol.name).toBe("ok");
  });

  it("returns null when source cannot be tokenized", () => {
    const analysis = buildAnalysisForSource("\"unterminated");
    expect(analysis).toBeNull();
  });

  it("captures parser errors while still exposing ast and semantic analysis", () => {
    const source = "let = 1\nlet ok = missing\n";
    const session = createAnalysisSession(source);

    expect(session.ast).not.toBeNull();
    expect(session.parserErrors.length).toBeGreaterThan(0);
    expect(session.analysis).not.toBeNull();
    expect(session.semanticIssues.some((issue) => issue.message.includes("'missing'"))).toBe(true);
    expect(session.analysis?.getIssues()).toEqual(session.semanticIssues);
    expect(session.tokenizeError).toBeNull();
  });

  it("reuses cached session for same uri+version and rebuilds on version change", () => {
    const cache = new AnalysisSessionCache();
    const uri = "file:///demo.my";
    const docV1 = TextDocument.create(uri, "mylang", 1, "let a = 1\n");
    const docV2 = TextDocument.create(uri, "mylang", 2, "let a = 2\n");

    const sessionV1First = cache.getForDocument(docV1);
    const sessionV1Second = cache.getForDocument(docV1);
    const sessionV2 = cache.getForDocument(docV2);

    expect(sessionV1First).toBe(sessionV1Second);
    expect(sessionV2).not.toBe(sessionV1First);
  });

  it("keeps shorthand class methods with explicit return types compatible with implemented interfaces", () => {
    const source = dedent`
      interface Shape {
        describe(): string
      }

      class Rectangle implements Shape {
        width: number
        height: number
        describe(): string => \`Rectangle(\${this.width}x\${this.height})\`
      }
    `;

    const session = createAnalysisSession(source);
    const messages = session.semanticIssues.map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("incorrectly implements interface"))
    ).toBe(false);
  });

  it("keeps shorthand class methods with inferred return types compatible with implemented interfaces", () => {
    const source = dedent`
      interface Shape {
        describe(): string
      }

      class Rectangle implements Shape {
        width: number
        height: number
        describe() => \`Rectangle(\${this.width}x\${this.height})\`
      }
    `;

    const session = createAnalysisSession(source);
    const messages = session.semanticIssues.map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("includes DOM ambient declarations from tsconfig lib entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mylang-lsp-dom-"));
    const filePath = join(dir, "main.my");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const source = 'const root: HTMLElement = document.createElement("main")\n';
    await writeFile(filePath, source, "utf8");

    const cache = new AnalysisSessionCache(async () => ({
      externalDeclarations: [],
      importedSymbolTypes: new Map(),
      ambientDeclarations: (await ensureDomProgram()).body
    }));
    const session = await cache.getForDocumentAsync(TextDocument.create(`file://${filePath}`, "mylang", 1, source));

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });
});
