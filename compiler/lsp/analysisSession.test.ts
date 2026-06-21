import { describe, expect, it, join, mkdtemp, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
import {
  AnalysisSessionCache,
  buildAnalysisForSource,
  createAnalysisSession
} from "./analysisSession";
import { collectAllImportedDeclarations, type ImportedSymbolResolution } from "./importedDeclarations";

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

  it("derives legacy imported-symbol views from the shared importedSymbols map", () => {
    const importedSymbols = new Map<string, ImportedSymbolResolution>([
      ["readFile", { type: { kind: "named", name: "ReadFileFn" }, displayType: 'typeof import("node:fs").readFile' }],
      ["missing", { invalid: true }]
    ]);

    const session = createAnalysisSession(
      'import { readFile, missing } from "node:fs"\n',
      [],
      new Map(),
      [],
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      importedSymbols
    );

    expect(session.importedSymbols.get("readFile")?.displayType).toBe('typeof import("node:fs").readFile');
    expect(session.importedSymbolTypes.get("readFile")).toEqual({ kind: "named", name: "ReadFileFn" });
    expect(session.importedSymbolDisplayTypes.get("readFile")).toBe('typeof import("node:fs").readFile');
    expect(session.invalidImportedBindings.has("missing")).toBe(true);
  });

  it("reuses cached session for same uri+version and rebuilds on version change", () => {
    const cache = new AnalysisSessionCache();
    const uri = "file:///demo.vx";
    const docV1 = TextDocument.create(uri, "vexa", 1, "let a = 1\n");
    const docV2 = TextDocument.create(uri, "vexa", 2, "let a = 2\n");

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

  it("contextually types object literal arguments against unioned object overload branches", () => {
    const source = dedent`
      interface Abortable {
        signal?: string
      }

      fun readFile(options: ({ encoding: "utf-8" | "utf8" } & Abortable) | "utf-8" | "utf8") {}

      readFile({ encoding: "utf-8" })
    `;

    const session = createAnalysisSession(source);

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("keeps imported overload helpers available when imported function signatures reference local types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-imported-overloads-"));
    const libPath = join(root, "lib.vx");
    const mainPath = join(root, "main.vx");

    await writeFile(
      libPath,
      dedent`
        interface Abortable {
          signal?: string
        }

        export fun readFile(
          path: string,
          options: ({ encoding?: null | undefined, flag?: number | string | undefined } & Abortable) | null
        ): string {
          return ""
        }

        export fun readFile(
          path: string,
          options: ({ encoding: "utf8" | "utf-8", flag?: number | string | undefined } & Abortable) | "utf8" | "utf-8"
        ): string {
          return ""
        }
      `,
      "utf8"
    );

    const source = dedent`
      import { readFile } from "./lib"

      await readFile("hello", { encoding: "utf-8" })
    `;
    const baseSession = createAnalysisSession(source);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: `file://${mainPath}`,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes
    );

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("reports unknown contextual object literal properties against interface-shaped parameters", async () => {
    const source = dedent`
      interface InspectOptions {
        showHidden?: boolean
        depth?: number
      }

      fun formatWithOptions(inspectOptions: InspectOptions, format?: any, ...param: any[]): string => ""

      formatWithOptions({ a: 10 }, "%s", "test")
    `;
    const session = createAnalysisSession(source);
    const messages = session.semanticIssues.map((issue) => issue.message);

    expect(messages.some((message) =>
      message.includes("Object literal property 'a' does not exist in type 'InspectOptions'")
    )).toBe(true);
  });

  it("resolves extracted renderer option aliases from ambient system lists", () => {
    const ambientSource = dedent`
      declare interface System {
        extension: { name: string }
        defaultOptions?: any
      }

      declare interface ViewSystemOptions {
        width?: number
        height?: number
        antialias?: boolean
        resolution?: number
      }

      declare class ViewSystem {
        static extension: { name: "view" }
        static defaultOptions: ViewSystemOptions
      }

      declare interface TickerOptions {
        autoStart?: boolean
      }

      declare class TickerSystem {
        static extension: { name: "ticker" }
        static defaultOptions: TickerOptions
      }

      declare const SharedSystems: (typeof ViewSystem | typeof TickerSystem)[]

      type ExtractRendererOptions<T extends System[]> = UnionToIntersection<OptionsUnion<T>>

      declare interface SharedRendererOptions extends ExtractRendererOptions<typeof SharedSystems> {}
      declare function init(options?: Partial<SharedRendererOptions>): void
    `;
    const source = "init({ width: 480, height: 320, antialias: true, autoStart: true })\n";
    const ambientDeclarations = parseFile(tokenizeReader(ambientSource), { language: "typescript" }).body;
    const session = createAnalysisSession(source, [], new Map(), ambientDeclarations);

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("includes DOM ambient declarations from tsconfig lib entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-lsp-dom-"));
    const filePath = join(dir, "main.vx");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const source = 'const root: HTMLElement = document.createElement("main")\n';
    await writeFile(filePath, source, "utf8");

    const cache = new AnalysisSessionCache(async () => ({
      externalDeclarations: [],
      importedSymbolTypes: new Map(),
      ambientDeclarations: (await ensureDomProgram()).body
    }));
    const session = await cache.getForDocumentAsync(TextDocument.create(`file://${filePath}`, "vexa", 1, source));

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("getForDocumentAsync reuses its own in-flight resolution instead of duplicating work", async () => {
    const source = "let a = 1\n";
    const doc = TextDocument.create("file:///test.vx", "vexa", 1, source);
    let resolveCount = 0;

    const cache = new AnalysisSessionCache(async () => {
      resolveCount++;
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { externalDeclarations: [], importedSymbolTypes: new Map() };
    });

    const [s1, s2] = await Promise.all([
      cache.getForDocumentAsync(doc),
      cache.getForDocumentAsync(doc)
    ]);

    expect(s1).toBe(s2);
    expect(resolveCount).toBe(1);
  });

  it("getForDocumentAsync reuses the in-flight resolution started by getForDocument", async () => {
    const source = "let a = 1\n";
    const doc = TextDocument.create("file:///test.vx", "vexa", 1, source);
    let resolveCount = 0;

    const cache = new AnalysisSessionCache(async () => {
      resolveCount++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { externalDeclarations: [], importedSymbolTypes: new Map() };
    });

    cache.getForDocument(doc);
    const [s1, s2] = await Promise.all([
      cache.getForDocumentAsync(doc),
      cache.getForDocumentAsync(doc)
    ]);

    expect(s1).toBe(s2);
    expect(resolveCount).toBe(1);
  });

  it("getForDocumentAsync does not reuse a pending resolution for a different version", async () => {
    const source1 = "let a = 1\n";
    const source2 = "let b = 2\n";
    const docV1 = TextDocument.create("file:///test.vx", "vexa", 1, source1);
    const docV2 = TextDocument.create("file:///test.vx", "vexa", 2, source2);

    let callCount = 0;
    const cache = new AnalysisSessionCache(async () => {
      callCount++;
      return { externalDeclarations: [], importedSymbolTypes: new Map() };
    });

    // Establish a v1 session in the cache
    await cache.getForDocumentAsync(docV1);

    // Requesting v2 must not reuse v1's resolution and must produce its own session
    const sessionV2 = await cache.getForDocumentAsync(docV2);
    expect(sessionV2.ast?.body.length).toBeGreaterThan(0);
    // The resolver was called at least once for v1 and at least once for v2
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
