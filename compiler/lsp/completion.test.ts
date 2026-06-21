import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, readFile, tmpdir, writeFile } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { parseSource } from "compiler/pipeline/parse";
import { createAnalysisSession } from "./analysisSession";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import { createClassResolverCache, resolveClassMemberNames, resolveClassStatementAcrossFiles } from "./classResolver";
import { resolveDefinitionAcrossFiles } from "./crossFileNavigation";
import { collectAllImportedDeclarations, collectImportedTypeDeclarations, collectImportedSymbolTypes } from "./importedDeclarations";
import { getProjectIndex } from "./projectAnalysis";
import { buildVisibleSymbolCompletionItems } from "./symbolCompletion";
import { Vfs } from "compiler/vfs";
import { resolveTypeNameFromPath } from "./memberCompletionPathTypes";
import { resolveExtensionMemberTypeName } from "./memberCompletionExtensionMembers";

function parseAmbientModule(src: string, moduleName: string) {
  const result = parseSource(src, { language: "typescript" });
  const ns = result.ast?.body?.find(
    (statement) => statement.kind === "NamespaceStatement"
      && (statement as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: import("compiler/ast/ast").Statement[] } } | undefined;
  return ns?.body?.body ?? [];
}

function recoverSessionFrom(source: string, session: ReturnType<typeof createAnalysisSession>) {
  return createAnalysisSession(
    source,
    session.externalDeclarations,
    new Map(),
    session.ambientDeclarations,
    session.ambientModuleDeclarations,
    session.ambientModuleLocations,
    new Map(),
    session.invalidImportedBindings,
    session.ambientDeclarationLocations,
    session.importedSymbols
  );
}

describe("createCompletionItemsForPosition", () => {
  it("includes in-scope variables and parameters inside function body", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let top = 1
      fun demo(a, b: int) {
        let inner = a
        ^^^return inner
      }
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(labels).toContain("a");
    expect(labels).toContain("b");
    expect(labels).toContain("inner");
    expect(labels).toContain("top");
    expect(labels).toContain("demo");
    expect(byLabel.get("top")?.detail).toBe("In-scope variable: int");
    expect(byLabel.get("inner")?.detail).toBe("In-scope variable: unknown");
    expect(byLabel.get("b")?.detail).toBe("In-scope parameter: int");
    expect(byLabel.get("demo")?.detail).toBe("In-scope function: (a: unknown, b: int) => unknown");
  });

  it("offers contextually typed Promise executor parameters", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let promise = new Promise((resolve, reject) => {
        ^^^resolve(1)
      })
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("resolve")?.detail).toBe("In-scope parameter: (arg1: int) => void");
    expect(byLabel.get("reject")?.detail).toBe("In-scope parameter: (arg1: Error) => void");
  });

  it("does not suggest existing symbols while typing a function declaration name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(): number => 1
      fun demo2(): number => 2
      fun de^^^m()
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("demo");
    expect(labels).not.toContain("demo2");
  });

  it("does not suggest existing symbols while typing an incomplete function declaration name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number)

      fun poin^^^
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("Point");
    expect(labels).not.toContain("PromiseConstructor");
  });

  it("does not suggest existing symbols while typing a parameter name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let shared = 1
      fun demo(par^^^am: int) {
        return shared
      }
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("shared");
    expect(labels).not.toContain("demo");
  });

  it("does not suggest existing symbols while typing a variable declaration name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let shared = 1
      let val^^^ue = shared
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("shared");
    expect(labels).not.toContain("value");
  });

  it("does not suggest existing symbols while typing a class member name", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Counter {
        total: int
        rea^^^d(): int {
          return total
        }
      }
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("total");
    expect(labels).not.toContain("read");
  });

  it("includes triple-slash documentation comments in in-scope function completions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      /// searches [sub] in [str]
      /// and returns its index or -1
      fun demo(str: string, sub: string): int {
      }

      fun demo2() {
        de^^^mo()
      }
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(ast, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("demo")?.documentation).toBe("searches [sub] in [str]\nand returns its index or -1");
  });

  it("suggests named arguments inside an empty call argument list", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun connect(host: string, port: number) {}
      connect(^^^)
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.has("host:")).toBe(true);
    expect(byLabel.has("port:")).toBe(true);
    expect(byLabel.get("host:")?.insertText).toBe("host: ");
    expect(byLabel.get("host:")?.filterText).toBe("host");
    expect(byLabel.get("host:")?.detail).toBe("Named argument: string");
  });

  it("suggests named arguments for new expressions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number)
      val p = new Point(^^^)
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.has("x:")).toBe(true);
    expect(byLabel.has("y:")).toBe(true);
  });

  it("does not suggest named arguments outside of a call argument list", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun connect(host: string, port: number) {}
      ^^^connect
      `
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(ast, line, character);
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("host:");
    expect(labels).not.toContain("port:");
  });

  it("keeps keyword completions available", async () => {
    const labels = createKeywordOnlyCompletionItems().map((item) => item.label);
    expect(labels).toContain("fn");
    expect(labels).toContain("type");
    expect(labels).toContain("annotation");
    expect(labels).toContain("interface");
    expect(labels).toContain("namespace");
    expect(labels).toContain("module");
    expect(labels).toContain("declare");
    expect(labels).toContain("int");
    expect(labels).toContain("number");
    expect(labels).toContain("bigint");
    expect(labels).toContain("long");
    expect(labels).toContain("string");
    expect(labels).toContain("boolean");
  });

  it("includes auto-import completion items with additional text edits", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return ^^^Poi\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [
        {
          symbol: { name: "Point", filePath: "/tmp/a.vx", kind: "class" },
          importPath: "./a.vx",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          }
        }
      ]
    );
    const point = items.find((item) => item.label === "Point");

    expect(point).toBeDefined();
    expect(point?.detail).toBe("Auto import from ./a.vx");
    expect(point?.additionalTextEdits?.[0]?.newText).toBe(
      "import { Point } from \"./a.vx\"\n"
    );
  });

  it("suggests annotations after '@'", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      annotation LocalTag(val value: string)

      @^^^
      fun demo() {}
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("LocalTag")?.detail).toBe("Annotation");
    expect(byLabel.get("LocalTag")?.insertText).toBe("LocalTag($1)");
    expect(byLabel.has("JsName")).toBe(true);
    expect(byLabel.has("JsInline")).toBe(true);
  });

  it("inserts zero-argument annotations without parentheses", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      annotation DemoAnnotation

      @^^^
      fun demo() {}
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("DemoAnnotation")?.insertText).toBe("DemoAnnotation");
  });

  it("computes auto-import completion items from exported-symbol callbacks", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return Poi^^^\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.vx",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "Point", filePath: "/models/point.vx", kind: "class" },
        ],
      }
    );
    const point = items.find((item) => item.label === "Point");

    expect(point).toBeDefined();
    expect(point?.detail).toBe("Auto import from ./models/point.vx");
    expect(point?.additionalTextEdits?.[0]?.newText).toBe(
      "import { Point } from \"./models/point.vx\"\n"
    );
  });

  it("computes auto-import completion items for ambient module exports", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return gre^^^\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.vx",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "greet", filePath: "/virtual/@types/my-lib/index.d.ts", importPath: "my-lib", kind: "function" },
        ],
      }
    );
    const greet = items.find((item) => item.label === "greet");

    expect(greet).toBeDefined();
    expect(greet?.detail).toBe("Auto import from my-lib");
    expect(greet?.additionalTextEdits?.[0]?.newText).toBe(
      "import { greet } from \"my-lib\"\n"
    );
  });

  it("reuses an existing import from the same module when auto-import completion inserts another symbol", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      import { readFile } from "fs/promises"
      fun demo() {
        return rea^^^
      }
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.vx",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "readdir", filePath: "/virtual/@types/node/fs/promises.d.ts", importPath: "fs/promises", kind: "function" },
        ],
      }
    );
    const readdir = items.find((item) => item.label === "readdir");

    expect(readdir).toBeDefined();
    expect(readdir?.detail).toBe("Auto import from fs/promises");
    expect(readdir?.additionalTextEdits?.[0]?.newText).toBe(
      'import { readFile, readdir } from "fs/promises"'
    );
    expect(readdir?.additionalTextEdits?.[0]?.range.start).toEqual({ line: 0, character: 0 });
  });

  it("adds a separate named import when the module is already imported as a namespace", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      import * as THREE from "three"
      fun demo() {
        return WebGL^^^
      }
    `);
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.vx",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "WebGLRenderer", filePath: "/virtual/@types/three/index.d.ts", importPath: "three", kind: "class" },
        ],
      }
    );
    const renderer = items.find((item) => item.label === "WebGLRenderer");

    expect(renderer).toBeDefined();
    expect(renderer?.detail).toBe("Auto import from three");
    expect(renderer?.additionalTextEdits?.[0]?.newText).toBe(
      'import { WebGLRenderer } from "three"\n'
    );
    expect(renderer?.additionalTextEdits?.[0]?.range.start).toEqual({ line: 1, character: 0 });
  });

  it("offers type-only auto-import completions from named exports of an already imported node_modules module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-"));
    const packageDir = join(root, "node_modules", "preact");
    const packageJson = join(packageDir, "package.json");
    const typings = join(packageDir, "index.d.ts");
    const consumerFile = join(root, "consumer.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      import { h } from "preact"
      fun demo(props: { children: Compon^^^ }) {
        return h()
      }
    `);

    await mkdir(packageDir, { recursive: true });
    await writeFile(packageJson, JSON.stringify({ name: "preact", types: "index.d.ts" }), "utf8");
    await writeFile(typings, 'export function h(): void;\nexport type ComponentChildren = string | number;\n', "utf8");
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      {
        text: source,
        uri: pathToFileURL(consumerFile).toString(),
        sourceRoots: [root]
      }
    );
    const componentChildren = items.find((item) => item.label === "ComponentChildren");

    expect(componentChildren).toBeDefined();
    expect(componentChildren?.detail).toBe("Auto import from preact");
    expect(componentChildren?.additionalTextEdits?.[0]?.newText).toBe(
      'import { h, type ComponentChildren } from "preact"'
    );
  });

  it("offers zod-style namespace type member completions from imported node_modules packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-zod-"));
    const packageDir = join(root, "node_modules", "zod");
    const libDir = join(packageDir, "lib");
    const consumerFile = join(root, "consumer.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      import { z } from "zod"

      val schema: z.inf^^^ = z.string()
    `);

    await mkdir(libDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "zod", types: "index.d.ts" }), "utf8");
    await writeFile(join(packageDir, "index.d.ts"), 'export * from "./lib";\nexport as namespace Zod;\n', "utf8");
    await writeFile(
      join(libDir, "index.d.ts"),
      dedent`
        import * as z from "./external";
        export * from "./external";
        export { z };
        export default z;
      `,
      "utf8"
    );
    await writeFile(
      join(libDir, "external.d.ts"),
      dedent`
        export interface ZString {
          min(size: number): ZString;
        }

        export type infer<T extends ZString = ZString> = T;
        declare const stringType: () => ZString;
        export { stringType as string };
      `,
      "utf8"
    );
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      {
        text: source,
        uri: pathToFileURL(consumerFile).toString(),
        sourceRoots: [root]
      }
    );
    const inferItems = items.filter((item) => item.label === "infer");

    expect(inferItems.length).toBeGreaterThan(0);
  });

  it("shows all auto-import completion candidates when multiple modules export the same name", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  return gre^^^\n}\n");
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.vx",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "greet", filePath: "/virtual/@types/alpha/index.d.ts", importPath: "alpha", kind: "function" },
          { name: "greet", filePath: "/virtual/@types/beta/index.d.ts", importPath: "beta", kind: "function" },
        ],
      }
    );
    const greets = items.filter((item) => item.label === "greet");

    expect(greets).toHaveLength(2);
    expect(greets.map((item) => item.detail)).toEqual([
      "Auto import from alpha",
      "Auto import from beta"
    ]);
  });

  it("prioritizes auto-import completions from modules already imported in the file", async () => {
    const { source, line, character } = sourceWithCursor(
      'import { existing } from "beta"\nfun demo() {\n  return gre^^^\n}\n'
    );
    const ast = parseFile(tokenizeReader(source));
    const items = await createCompletionItemsForPosition(
      ast,
      line,
      character,
      undefined,
      [],
      {
        text: source,
        uri: "file:///consumer.vx",
        sourceRoots: [],
        getExportedSymbols: async () => [
          { name: "greet", filePath: "/virtual/@types/alpha/index.d.ts", importPath: "alpha", kind: "function" },
          { name: "greet", filePath: "/virtual/@types/beta/index.d.ts", importPath: "beta", kind: "function" },
        ],
      }
    );
    const greets = items.filter((item) => item.label === "greet");

    expect(greets).toHaveLength(2);
    expect(greets.map((item) => item.detail)).toEqual([
      "Auto import from beta",
      "Auto import from alpha"
    ]);
  });

  it("offers exported runtime namespace members for member access", async () => {
    const { source, line, character } = sourceWithCursor(
      "namespace Tools { export const version = 1; const hidden = 2; export function read() { return version } }\nTools.^^^"
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining(["version", "read"]));
    expect(items.map((item) => item.label)).not.toContain("hidden");
  });

  it("offers ECMAScript runtime members for built-in globals", async () => {
    const { source, line, character } = sourceWithCursor("fun demo() {\n  Math.^^^\n}\n");
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["abs", "floor", "max", "random"]));
    expect(labels).not.toContain("demo");
  });

  it("offers DOM interface members for variables typed from tsconfig lib declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      fun createDocument(): Document => document
      const root: HTMLElement = createDocument().createElement("main")
      root.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root]
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["className", "id", "children", "getAttribute", "setAttribute", "tagName"]));
  });

  it("offers local extension members for numeric literal member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class TimeSpan(val ms: number)
      val number.milliseconds => TimeSpan(this)
      val number.seconds => TimeSpan(this * 1000)
      10.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["milliseconds", "seconds"]));
  });

  it("merges boxed Number members with extension members for class numeric properties", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class TimeSpan(val ms: number)
      class Adler32 {
        value: int => checksum
        private checksum = 1
      }
      val number.milliseconds => TimeSpan(this)
      val number.seconds => TimeSpan(this * 1000)
      const adler = Adler32()
      adler.value.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(labels).toEqual(expect.arrayContaining(["milliseconds", "seconds", "toLocaleString", "valueOf"]));
    expect(byLabel.get("toLocaleString")?.sortText).toBe("2-toLocaleString");
    expect(byLabel.get("milliseconds")?.sortText).toBe("3-milliseconds");
  });

  it("infers getter shorthand property types in class member completions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Adler32 {
        private checksum = 1
        value => checksum
      }
      val adler = Adler32()
      adler.v^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("value")?.detail).toBe("Class property: int");
  });

  it("offers generic Array extension members for array member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun <T> Array<T>.second(): T { return this[1] }
      val <T> Array<T>.doubledLength => length * 2
      let xs = [1, 2, 3]
      xs.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["second", "doubledLength"]));
  });

  it("offers imported extension members from TypeScript-extension modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-imported-ts-extension-"));
    const durationFile = join(root, "duration.ts");
    const consumerFile = join(root, "consumer.vx");
    const durationSource = dedent`
      class TimeSpan(val ms: number)
      export val number.seconds => TimeSpan(this * 1000)
    `;
    await writeFile(durationFile, durationSource, "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      import { seconds } from "./duration"
      10.^^^
    `);
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const durationSession = createAnalysisSession(durationSource);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(consumerFile).toString(),
      getSessionForFilePath: (filePath) => filePath === durationFile
        ? durationSession
        : filePath === consumerFile
          ? session
          : null
    });

    expect(items.some((item) => item.label === "seconds" && item.detail === "Extension property: number")).toBe(true);
  });

  it("offers auto-imported extension members for numeric literal member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-"));
    const durationFile = join(root, "duration.vx");
    const consumerFile = join(root, "consumer.vx");
    await writeFile(
      durationFile, dedent`
      class TimeSpan(val ms: number)
      export val number.milliseconds => TimeSpan(this)
      export val number.seconds => TimeSpan(this * 1000)
      `,
      "utf8"
    );
    const { source, line, character } = sourceWithCursor("10.^^^\n");
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(consumerFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => {
        if (filePath === durationFile) {
          return createAnalysisSession(dedent`
            class TimeSpan(val ms: number)
            export val number.milliseconds => TimeSpan(this)
            export val number.seconds => TimeSpan(this * 1000)
            `
          );
        }
        return filePath === consumerFile ? session : null;
      }
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("milliseconds")?.detail).toBe("Auto import extension from ./duration.vx");
    expect(byLabel.get("milliseconds")?.additionalTextEdits?.[0]?.newText).toBe(
      "import { milliseconds } from \"./duration.vx\"\n"
    );
    expect(byLabel.get("seconds")?.detail).toBe("Auto import extension from ./duration.vx");
  });

  it("resolves chained members after extension properties", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class TimeSpan(val ms: number)
      val number.seconds => TimeSpan(this * 1000)
      10.seconds.^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("ms");
  });

  it("offers constructor properties inside template interpolation", async () => {
    const source = dedent`
      class TimeSpan(val ms: number) {
        toString() => \`\${m}\`
      }
      `;
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, 1, 20, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels[0]).toBe("ms");
    expect(labels).toContain("this");
  });

  it("offers constructor properties inside empty template interpolation", async () => {
    const source = dedent`
      class TimeSpan(val ms: number) {
        toString() => \`\${}\`
      }
      `;
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, 1, 18, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels[0]).toBe("ms");
    expect(labels).toContain("this");
  });

  it("resolves member completions from explicitly typed variables", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo() {
        const result: Point = value
        return result.^^^
      }
      class Point(val x: int, val y: int)
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["x", "y"]));
    expect(labels).not.toEqual(expect.arrayContaining(["result", "value", "true"]));
  });

  it("offers enum members for enum member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      enum Demo {
        HELLO,
        WORLD
      }

      Demo.HE^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));
    const labels = items.map((item) => item.label);

    expect(labels).toContain("HELLO");
    expect(labels).not.toContain("WORLD");
    expect(byLabel.get("HELLO")?.detail).toBe("Enum member: Demo");
  });

  it("does not offer enum members on enum values", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      enum StrEnum {
        ADA = "ADA",
        CPP = "CPP"
      }

      StrEnum.CPP.AD^^^
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).not.toContain("ADA");
    expect(labels).not.toContain("CPP");
  });

  it("offers String members for variables annotated as string", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(str: string) {
        str.toLo^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("toLowerCase");
    expect(labels).toContain("toLocaleLowerCase");
  });

  it("offers Number members for variables annotated as number", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(value: number) {
        value.toLoc^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("toLocaleString");
    expect(labels).not.toContain("BigIntToLocaleStringOptions");
  });

  it("offers Boolean members for variables annotated as boolean", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(flag: boolean) {
        flag.val^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("valueOf");
  });

  it("prioritizes class member completions for member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: int, val y: int) {
        sum() {
          return 0
        }
      }
      fun demo() {
        const point = new Point(1, 2)
        point.^^^x
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("x");
    expect(labels).toContain("y");
    expect(labels).toContain("sum");
    expect(labels).not.toContain("demo");
    expect(labels).not.toContain("point");
  });

  it("matches camelCase member completions with lowercase typed prefixes", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Stage {
        addChild() {
        }
        addChildAt(index: int) {
        }
      }
      fun demo() {
        const stage = new Stage()
        stage.addc^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("addChild");
    expect(labels).toContain("addChildAt");
    expect(labels).not.toContain("demo");
    expect(labels).not.toContain("stage");
  });

  it("resolves imported class member completions through the configured VFS", async () => {
    const mainPath = "/workspace/main.vx";
    const stagePath = "/workspace/stage.vx";
    const source = dedent`
      import { Stage } from "./stage"

      fun demo() {
        val stage = Stage()
        stage.addc
      }
    `;
    const cursorCharacter = source.lastIndexOf("addc") + "addc".length;
    const cursorLine = source.split("\n").findIndex((line) => line.includes("stage.addc"));
    const stageSource = dedent`
      export class Stage {
        addChild() {}
        addChildAt(index: int) {}
      }
    `;

    class TestVfs extends Vfs {
      override async readFile(filePath: string): Promise<string> {
        if (filePath === mainPath) {
          return source;
        }
        if (filePath === stagePath) {
          return stageSource;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      }

      override async stat(filePath: string) {
        if (filePath === mainPath || filePath === stagePath) {
          return { mtimeMs: 0, isFile: true, isDirectory: false };
        }
        throw new Error(`Unexpected stat: ${filePath}`);
      }
    }

    const vfs = new TestVfs();
    const mainUri = "file:///workspace/main.vx";
    const stageSession = createAnalysisSession(stageSource);
    const baseSession = createAnalysisSession(source);
    const getSessionForFilePath = async (filePath: string) => {
      if (filePath === stagePath) {
        return stageSession;
      }
      if (filePath === mainPath) {
        return baseSession;
      }
      return null;
    };
    const resolverContext = {
      uri: mainUri,
      vfs,
      getSessionForFilePath
    };
    const [externalDeclarations, importedSymbolTypes] = await Promise.all([
      collectImportedTypeDeclarations(baseSession.ast!, resolverContext),
      collectImportedSymbolTypes(baseSession.ast!, resolverContext)
    ]);
    const session = createAnalysisSession(source, externalDeclarations, importedSymbolTypes);

    const items = await createCompletionItemsForPosition(
      session.ast!,
      cursorLine,
      cursorCharacter,
      session.analysis!,
      [],
      {
        text: source,
        uri: mainUri,
        vfs,
        getSessionForFilePath,
        recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("addChild");
    expect(labels).toContain("addChildAt");
    expect(labels).not.toContain("demo");
    expect(labels).not.toContain("stage");
  });

  it("includes members from merged interfaces on imported classes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-merged-interface-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const mainPath = join(root, "main.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      import { Container } from "pixi-like"

      fun demo() {
        val stage = Container()
        stage.addc^^^
      }
    `);
    const pkgSource = dedent`
      export interface ChildrenHelperMixin {
        addChild(): void;
        addChildAt(index: number): void;
      }

      declare global {
        namespace PixiMixins {
          interface Container extends ChildrenHelperMixin {}
        }
      }

      export interface Container extends PixiMixins.Container {}

      export declare class Container {
      }

      export { };
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );
    const resolverOptions = {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    };
    const resolverCache = createClassResolverCache();
    const resolvedTypeName = await resolveTypeNameFromPath(
      session.ast!,
      session.analysis!,
      ["stage"],
      line,
      4,
      resolverOptions,
      resolverCache,
      resolveExtensionMemberTypeName
    );
    const classResolution = await resolveClassStatementAcrossFiles(
      session.ast!,
      "Container",
      resolverOptions,
      resolverCache
    );
    const resolvedMemberNames = classResolution
      ? await resolveClassMemberNames(classResolution.classStatement, "Container", {
          ast: session.ast!,
          options: resolverOptions,
          analysis: session.analysis!,
          cache: resolverCache
        })
      : [];

    expect(resolvedTypeName).toBe("Container");
    expect(resolvedMemberNames).toContain("addChild");
    expect(resolvedMemberNames).toContain("addChildAt");

    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      {
        text: source,
        ...resolverOptions
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("addChild");
    expect(labels).toContain("addChildAt");
  });

  it("offers Array<T> members for array-typed variable member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Array<T> {
        length: number
        push(item: T): number
        map<R>(callback: (value: T) => R): Array<R>
      }
      fun demo() {
        const items: int[] = []
        items.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect([...byLabel.keys()]).toContain("push");
    expect([...byLabel.keys()]).toContain("map");
    expect([...byLabel.keys()]).toContain("length");
    expect(byLabel.get("push")?.detail).toBe("Class method: (item: int) => number");
  });

  it("offers Array<T> members for unknown[] member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Array<T> {
        push(item: T): number
      }
      fun demo() {
        const items: unknown[] = []
        items.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("push");
  });

  it("surfaces builtin array length as an int property", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo() {
        const items: int[] = []
        items.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("length")?.detail).toBe("Interface property: int");
  });

  it("offers Array<T> members after chained trailing-lambda calls", async () => {
    const { source, line, character } = sourceWithCursor(
      'val res = [1, 2, 3, 4, 5, 6].map { it * 2 }.filter { it % 3 == 0 }.map { "value" }.ma^^^'
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("map");
    expect(labels).not.toContain("Math");
  });

  it("offers members on an auto-awaited call receiver inside a sync function", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Response {
        arrayBuffer(): Promise<ArrayBuffer>
      }
      declare fun fetch(url: string): Promise<Response>
      sync fun demo() {
        fetch("https://hello.world/demo.txt").array^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("arrayBuffer");
    // The general identifier fallback (in-scope classes such as Array) must not
    // leak in when the receiver type is known.
    expect(labels).not.toContain("Array");
  });

  it("offers members after a bare dot on an auto-awaited call receiver inside a sync function", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare class Response {
        arrayBuffer(): Promise<ArrayBuffer>
      }
      declare fun fetch(url: string): Promise<Response>
      sync fun demo() {
        fetch("https://hello.world/demo.txt").^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("arrayBuffer");
  });

  it("offers members on a chained method-call receiver", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Builder {
        self(): Builder
        value(): int
      }
      fun demo(builder: Builder) {
        builder.self().val^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
  });

  it("offers members after a same-line chain operator", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Builder {
        self(): Builder
        value(): int
      }
      fun build(): Builder {
        return new Builder()
      }
      fun demo() {
        build()..val^^^
      }
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
    expect(labels).not.toContain("build");
  });

  it("offers members after a chain operator on a continuation line", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Builder {
        self(): Builder
        value(): int
      }
      fun build(): Builder {
        return new Builder()
      }
      fun demo() {
        build()
          ..self()
          ..val^^^
      }
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
    expect(labels).not.toContain("build");
  });

  it("offers members after a leading dot on a continuation line", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Builder {
        self(): Builder
        value(): int
      }
      fun build(): Builder {
        return new Builder()
      }
      fun demo() {
        build()
          .self()
          .val^^^
      }
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("value");
    expect(labels).not.toContain("build");
  });

  it("offers members after accessing a nullable inherited DOM member", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-child-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.firstChild.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root]
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent"]));
  });

  it("offers Document members while typing a DOM method prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-document-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      document.crea^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("createElement");
  });

  it("returns call snippets for DOM method completions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      document.crea^^^
    `);
    const ambientDeclarations = (await ensureDomProgram()).body;
    const session = createAnalysisSession(source, [], new Map(), ambientDeclarations);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      ambientDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const createElement = items.find((item) => item.label === "createElement");

    expect(createElement?.insertText).toBe("createElement($1)");
    expect(createElement?.insertTextFormat).toBe(2);
    expect(createElement?.command).toEqual({
      title: "Trigger parameter hints",
      command: "editor.action.triggerParameterHints",
    });
  });

  it("offers Document members immediately after a bare dot", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-document-dot-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      document.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("createElement");
  });

  it("offers Document members from ambient declarations without project roots", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      document.crea^^^
    `);
    const ambientDeclarations = (await ensureDomProgram()).body;
    const session = createAnalysisSession(source, [], new Map(), ambientDeclarations);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      ambientDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("createElement");
  });

  it("offers members for default imports backed by ambient module exports", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      import util from "node:util"

      util.form^^^
    `);
    const ambientModuleDeclarations = new Map<string, import("compiler/ast/ast").Statement[]>([
      ["node:util", parseAmbientModule(
        `declare module "node:util" {
          export function format(value: string): string;
          export function inspect(value: unknown): string;
        }`,
        "node:util"
      )]
    ]);
    const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      ambientModuleDeclarations,
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      ambientModuleDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });

    expect(items.map((item) => item.label)).toContain("format");
    const format = items.find((item) => item.label === "format");
    expect(format?.insertText).toBe("format($1)");
    expect(format?.insertTextFormat).toBe(2);
    expect(format?.command).toEqual({
      title: "Trigger parameter hints",
      command: "editor.action.triggerParameterHints",
    });
  });

  it("returns call snippets for callable named imports", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      import { readFile } from "node:fs/promises"

      readFi^^^
    `);
    const ambientModuleDeclarations = new Map<string, import("compiler/ast/ast").Statement[]>([
      ["node:fs/promises", parseAmbientModule(
        `declare module "node:fs/promises" {
          export type PathLike = string;
          export function readFile(path: PathLike, encoding?: string): Promise<string>;
        }`,
        "node:fs/promises"
      )]
    ]);
    const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      ambientModuleDeclarations,
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      ambientModuleDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });

    const readFile = items.find((item) => item.label === "readFile");
    expect(readFile?.insertText).toBe("readFile($1)");
    expect(readFile?.insertTextFormat).toBe(2);
    expect(readFile?.command).toEqual({
      title: "Trigger parameter hints",
      command: "editor.action.triggerParameterHints",
    });
  });

  it("includes documentation for directly imported ambient module functions", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      import { readFile } from "node:fs/promises"

      readFi^^^
    `);
    const ambientModuleDeclarations = new Map<string, import("compiler/ast/ast").Statement[]>([
      ["node:fs/promises", parseAmbientModule(
        `declare module "node:fs/promises" {
          /**
           * Reads the entire contents of a file.
           */
          export function readFile(path: string): Promise<string>;
        }`,
        "node:fs/promises"
      )]
    ]);
    const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      ambientModuleDeclarations,
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      ambientModuleDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });

    expect(items.find((item) => item.label === "readFile")?.documentation).toBe(
      "Reads the entire contents of a file."
    );
  });

  it("offers contextual interface properties inside object literal arguments", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      import util from "node:util"

      util.formatWithOptions({ ^^^}, "%s", "test")
    `);
    const ambientModuleDeclarations = new Map<string, import("compiler/ast/ast").Statement[]>([
      ["node:util", parseAmbientModule(
        `declare module "node:util" {
          export interface InspectOptions {
            showHidden?: boolean;
            depth?: number;
          }
          export function formatWithOptions(inspectOptions: InspectOptions, format?: any, ...param: any[]): string;
        }`,
        "node:util"
      )]
    ]);
    const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      ambientModuleDeclarations,
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      ambientModuleDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(items.map((item) => item.label)).toContain("depth");
    expect(items.map((item) => item.label)).toContain("showHidden");
    expect(byLabel.get("showHidden")?.insertText).toBe("showHidden: ");
    expect(byLabel.get("depth")?.insertText).toBe("depth: ");
  });

  it("offers string literal union values inside object literal property values", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      interface ApplicationOptions {
        preference?: "webgl" | "webgpu" | "canvas" | undefined
        failIfMajorPerformanceCaveat?: boolean
      }

      declare function init(options?: Partial<ApplicationOptions>): Promise<void>

      init({
        preference: ^^^
      })
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      recoverAnalysisSession: (recoveredSource) =>
        createAnalysisSession(recoveredSource)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(items.map((item) => item.label)).toContain("webgl");
    expect(items.map((item) => item.label)).toContain("webgpu");
    expect(items.map((item) => item.label)).toContain("canvas");
    expect(byLabel.get("webgl")?.insertText).toBe("\"webgl\"");
    expect(byLabel.get("webgpu")?.insertText).toBe("\"webgpu\"");
    expect(byLabel.get("canvas")?.insertText).toBe("\"canvas\"");
  });

  it("re-triggers suggest after accepting an object property whose value has literal candidates", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      interface ApplicationOptions {
        preference?: "webgl" | "webgpu" | "canvas" | undefined
        failIfMajorPerformanceCaveat?: boolean
      }

      declare function init(options?: Partial<ApplicationOptions>): Promise<void>

      init({
        ^^^
      })
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      recoverAnalysisSession: (recoveredSource) =>
        createAnalysisSession(recoveredSource)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("preference")?.insertText).toBe("preference: ");
    expect(byLabel.get("preference")?.command).toEqual({
      title: "Trigger suggest",
      command: "editor.action.triggerSuggest"
    });
    expect(byLabel.get("failIfMajorPerformanceCaveat")?.command).toBe(undefined);
  });

  it("offers numeric literal union values inside object literal property values", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      declare function useConfig(config: { retryMs: 100 | 250 | 500 }): void

      useConfig({
        retryMs: ^^^
      })
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      recoverAnalysisSession: (recoveredSource) => createAnalysisSession(recoveredSource)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(items.map((item) => item.label)).toContain("100");
    expect(items.map((item) => item.label)).toContain("250");
    expect(items.map((item) => item.label)).toContain("500");
    expect(byLabel.get("100")?.insertText).toBe("100");
    expect(byLabel.get("250")?.insertText).toBe("250");
    expect(byLabel.get("500")?.insertText).toBe("500");
  });

  it("offers enum values inside object literal property values", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      enum Renderer {
        WebGL,
        WebGPU,
        Canvas,
      }

      declare function useConfig(config: { renderer: Renderer }): void

      useConfig({
        renderer: ^^^
      })
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      recoverAnalysisSession: (recoveredSource) => createAnalysisSession(recoveredSource)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(items.map((item) => item.label)).toContain("WebGL");
    expect(items.map((item) => item.label)).toContain("WebGPU");
    expect(items.map((item) => item.label)).toContain("Canvas");
    expect(byLabel.get("WebGL")?.insertText).toBe("Renderer.WebGL");
    expect(byLabel.get("WebGPU")?.insertText).toBe("Renderer.WebGPU");
    expect(byLabel.get("Canvas")?.insertText).toBe("Renderer.Canvas");
  });

  it("offers mixed literal and enum values across unions inside object literal property values", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      enum Renderer {
        WebGL,
        WebGPU,
      }

      declare function useConfig(config: { mode: Renderer | "auto" | 60 }): void

      useConfig({
        mode: ^^^
      })
    `);
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: "file:///virtual/main.vx",
      recoverAnalysisSession: (recoveredSource) => createAnalysisSession(recoveredSource)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(items.map((item) => item.label)).toContain("auto");
    expect(items.map((item) => item.label)).toContain("60");
    expect(items.map((item) => item.label)).toContain("WebGL");
    expect(items.map((item) => item.label)).toContain("WebGPU");
    expect(byLabel.get("auto")?.insertText).toBe("\"auto\"");
    expect(byLabel.get("60")?.insertText).toBe("60");
    expect(byLabel.get("WebGL")?.insertText).toBe("Renderer.WebGL");
    expect(byLabel.get("WebGPU")?.insertText).toBe("Renderer.WebGPU");
  });

  it("offers imported type-alias literal values inside object literal property values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-imported-literal-values-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const libDir = join(pkgDir, "lib");
    const sceneDir = join(libDir, "scene");
    const textDir = join(sceneDir, "text");
    const mainPath = join(root, "main.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      import { TextStyle } from "pixi-like"

      val style = TextStyle({
        align: ^^^
      })
    `);
    const textStyleSource = dedent`
      export type TextStyleAlign = 'left' | 'center' | 'right' | 'justify';

      export interface TextStyleOptions {
        align?: TextStyleAlign;
      }

      export declare class TextStyle {
        constructor(options?: Partial<TextStyleOptions>);
      }
    `;

    await mkdir(textDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "lib/index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(libDir, "index.d.ts"), "export * from './scene';\n", "utf8");
    await writeFile(join(sceneDir, "index.d.ts"), "export * from './text/TextStyle';\n", "utf8");
    await writeFile(join(textDir, "TextStyle.d.ts"), textStyleSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(items.map((item) => item.label)).toContain("left");
    expect(items.map((item) => item.label)).toContain("center");
    expect(items.map((item) => item.label)).toContain("right");
    expect(items.map((item) => item.label)).toContain("justify");
    expect(byLabel.get("left")?.insertText).toBe("\"left\"");
    expect(byLabel.get("center")?.insertText).toBe("\"center\"");
    expect(byLabel.get("right")?.insertText).toBe("\"right\"");
    expect(byLabel.get("justify")?.insertText).toBe("\"justify\"");
  });

  it("resolves go-to-definition for DOM members from ambient declarations with an absolute project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-definition-"));
    const file = join(root, "main.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      document.createEleme^^^nt("div")
    `);
    await writeFile(file, source, "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const session = createAnalysisSession(source, [], new Map(), ambientDeclarations);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line,
      character,
      session,
      sourceRoots: [root]
    });

    expect(location).not.toBeNull();
    expect(location?.uri.endsWith("dom.d.ts")).toBe(true);
  });

  it("offers Document members while typing a DOM method prefix in an imported workspace file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-document-imported-"));
    const file = join(root, "main.vx");
    const counterFile = join(root, "counter.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    await writeFile(counterFile, 'export fun increment(value: int): int => value + 1\n', "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      import { increment } from "./counter.vx"

      val current = increment(41)
      document.crea^^^
    `);
    await writeFile(file, source, "utf8");

    const baseSession = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      getSessionForFilePath: async (filePath) => {
        if (filePath !== counterFile) {
          return null;
        }
        const counterSource = await readFile(counterFile, "utf8");
        return createAnalysisSession(counterSource, [], new Map(), (await ensureDomProgram()).body);
      }
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      getSessionForFilePath: async (filePath) => {
        if (filePath !== counterFile) {
          return null;
        }
        const counterSource = await readFile(counterFile, "utf8");
        return createAnalysisSession(counterSource, [], new Map(), (await ensureDomProgram()).body);
      }
    });
    const session = createAnalysisSession(source, externalDeclarations, importedSymbolTypes, (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      getSessionForFilePath: async (filePath) => {
        if (filePath !== counterFile) {
          return null;
        }
        const counterSource = await readFile(counterFile, "utf8");
        return createAnalysisSession(counterSource, [], new Map(), (await ensureDomProgram()).body);
      },
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toContain("createElement");
  });

  it("offers members after a DOM querySelector call receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-query-selector-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo").^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent", "querySelector"]));
  });

  it("keeps DOM property completions as plain text", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.^^^
    `);
    const ambientDeclarations = (await ensureDomProgram()).body;
    const session = createAnalysisSession(source, [], new Map(), ambientDeclarations);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      ambientDeclarations,
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const nodeType = items.find((item) => item.label === "nodeType");

    expect(nodeType?.insertText).toBeUndefined();
    expect(nodeType?.insertTextFormat).toBeUndefined();
  });

  it("offers members after an optional DOM querySelector call receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-optional-query-selector-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo")?.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent", "querySelector"]));
  });

  it("offers members after a non-null-asserted DOM querySelector call receiver", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-non-null-query-selector-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo")!.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent", "querySelector"]));
  });

  it("offers members after accessing a member on a non-null-asserted DOM querySelector result", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-dom-non-null-query-selector-child-"));
    const file = join(root, "main.vx");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      const root: HTMLElement = document.createElement("main")
      root.querySelector(".demo")!.firstChild.^^^
    `);
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), (await ensureDomProgram()).body);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], {
      text: source,
      uri: pathToFileURL(file).toString(),
      sourceRoots: [root],
      recoverAnalysisSession: (recoveredSource) => recoverSessionFrom(recoveredSource, session)
    });
    const labels = items.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["nodeType", "parentNode", "textContent"]));
  });

  it("includes constructor parameter properties in member completion", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class User { constructor(public id: string, readonly age: int) {} }
      let user = new User("a", 1)
      user.^^^id
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("id")?.detail).toBe("Class property: string");
    expect(byLabel.get("age")?.detail).toBe("Class property: int");
  });

  it("prioritizes primary constructor properties ahead of methods in member completion", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point => Point(x + other.x, y + other.y)
        operator*(scale: number): Point => Point(x * scale, y * scale)
      }
      fun demo(point: Point) {
        point.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);

    expect(labels.slice(0, 2)).toEqual(["x", "y"]);
  });

  it("keeps operator member completions visible and edits member access safely", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point => Point(x + other.x, y + other.y)
        operator*(scale: number): Point => Point(x * scale, y * scale)
      }
      fun demo(point: Point) {
        point.^^^
      }
      `
    );
    const session = createAnalysisSession(source);
    const items = await createCompletionItemsForPosition(session.ast!, line, character, session.analysis!, [], { text: source });
    const labels = items.map((item) => item.label);
    const operatorItem = items.find((item) => item.label === "operator*");

    expect(labels).toContain("operator+");
    expect(labels).toContain("operator*");
    expect(operatorItem?.filterText).toBe("operator*");
    expect(operatorItem?.textEdit).toEqual({
      range: {
        start: { line, character },
        end: { line, character }
      },
      newText: " * "
    });
    expect(operatorItem?.additionalTextEdits).toEqual([
      {
        range: {
          start: { line, character: character - 1 },
          end: { line, character }
        },
        newText: ""
      }
    ]);
  });

  it("resolves member completions for chained member access", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Point(val x: int, val y: int)
      class Holder(val point: Point)
      fun demo() {
        const holder = new Holder(new Point(1, 2))
        holder.point.^^^x
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("x");
    expect(labels).toContain("y");
    expect(labels).not.toContain("holder");
  });

  it("resolves specialized generic member types in completion details", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Map<K, V> {
        a: K
        b: V
        get(key: K): V { }
      }
      fun demo() {
        const map = new Map<string, int>()
        map.^^^a
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("a")?.detail).toBe("Class property: string");
  });

  it("includes inherited generic members in completion details", async () => {
    const { source, valueLine, valueCharacter } = (() => {
      const first = sourceWithCursor(dedent`
        class Base<T> {
          value: T
          getValue(): T { }
        }
        class Child extends Base<string> {
        }
        fun demo() {
          const child = new Child()
          child.^^^v
          child.g
        }
        `
      );
      return {
        source: first.source,
        valueLine: first.line,
        valueCharacter: first.character
      };
    })();
    const { line: methodLine, character: methodCharacter } = sourceWithCursor(dedent`
      class Base<T> {
        value: T
        getValue(): T { }
      }
      class Child extends Base<string> {
      }
      fun demo() {
        const child = new Child()
        child.v
        child.^^^g
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const valueItems = await createCompletionItemsForPosition(
      session.ast!,
      valueLine,
      valueCharacter,
      session.analysis!,
      [],
      { text: source }
    );
    const valueByLabel = new Map(valueItems.map((item) => [item.label, item]));
    expect(valueByLabel.get("value")?.detail).toBe("Class property: string");

    const methodItems = await createCompletionItemsForPosition(
      session.ast!,
      methodLine,
      methodCharacter,
      session.analysis!,
      [],
      { text: source }
    );
    const methodByLabel = new Map(methodItems.map((item) => [item.label, item]));

    expect(methodByLabel.get("getValue")?.detail).toBe("Class method: () => string");
  });

  it("ranks in-scope symbols by nearest scope distance", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      let top = 1
      fun demo() {
        let outer = 2
        {
          let inner = 3
          ^^^inn
        }
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const symbolLabels = items
      .filter((item) => item.detail?.startsWith("In-scope "))
      .map((item) => item.label);

    expect(symbolLabels.indexOf("inner")).toBeLessThan(symbolLabels.indexOf("outer"));
    expect(symbolLabels.indexOf("outer")).toBeLessThan(symbolLabels.indexOf("top"));
  });

  it("ranks call-argument completions by expected parameter type relevance", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun takesNumber(value: number) {
      }
      fun demo() {
        let exact: number = 2
        let count: int = 1
        let text: string = "a"
        takesNumber(^^^ex)
      }
      `
    );
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: source }
    );
    const symbolLabels = items
      .filter((item) => item.detail?.startsWith("In-scope "))
      .map((item) => item.label);

    expect(symbolLabels.indexOf("exact")).toBeLessThan(symbolLabels.indexOf("count"));
    expect(symbolLabels.indexOf("count")).toBeLessThan(symbolLabels.indexOf("text"));
  });

  it("builds ranked visible-symbol completion items through the extracted helper", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      /// documented function docs
      fun documented(): number {
        return 2
      }
      let exact: number = 2
      let count: int = 1
      let text: string = "a"
      ^^^exact
    `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const items = buildVisibleSymbolCompletionItems({
      ast: session.ast!,
      analysis: session.analysis!,
      line,
      character,
      expectedTypeName: "number",
      options: { text: source },
      seenLabels: new Set<string>()
    });
    const rankedSubset = items
      .filter((item) => item.detail?.startsWith("In-scope "))
      .map((item) => item.label)
      .filter((label) => label === "exact" || label === "count" || label === "text");
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(rankedSubset).toEqual(["exact", "count", "text"]);
    expect(byLabel.get("documented")?.documentation).toBe("documented function docs");
  });

  it("offers members from a node_modules namespace when typing obj.^^^", async () => {
    const MINI_DTS = dedent`
      declare function pkg(x: string): pkg.Result;
      declare namespace pkg {
        interface Result {
          value(): string;
        }
        export function helper(): Result;
        export function parse(input: string): Result;
      }
      export = pkg;
    `;
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-nm-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "index.d.ts"), MINI_DTS, "utf8");
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", typings: "./index.d.ts" }),
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      import pkg from "pkg"
      pkg.^^^
    `);
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const ctx = { uri: pathToFileURL(mainPath).href, sourceRoots: [root], getSessionForFilePath: () => null };
    const declarations = await collectImportedTypeDeclarations(baseSession.ast!, ctx);
    const symbolTypes = await collectImportedSymbolTypes(baseSession.ast!, ctx);
    const session = createAnalysisSession(source, declarations, symbolTypes);

    const items = await createCompletionItemsForPosition(
      session.ast!, line, character, session.analysis!, [],
      { text: source, uri: ctx.uri }
    );
    const labels = items.map((item) => item.label);
    expect(labels).toContain("helper");
    expect(labels).toContain("parse");
  });

  it("offers members from imported object type aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-type-alias-"));
    const scenariosPath = join(root, "scenarios.vx");
    const mainPath = join(root, "main.vx");
    await writeFile(scenariosPath, dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `, "utf8");
    const first = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.vx"

      function lex(source: string) {}

      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.sou^^^)
      }
    `);
    await writeFile(mainPath, first.source, "utf8");

    const session = createAnalysisSession(first.source);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      first.line,
      first.character,
      session.analysis!,
      [],
      {
        text: first.source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root]
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("source");

    const labelPrefix = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.vx"

      function summarizeScenario(scenario: Scenario): string {
        return scenario.lab^^^
      }
    `);
    await writeFile(mainPath, labelPrefix.source, "utf8");
    const labelSession = createAnalysisSession(labelPrefix.source);
    const labelItems = await createCompletionItemsForPosition(
      labelSession.ast!,
      labelPrefix.line,
      labelPrefix.character,
      labelSession.analysis!,
      [],
      {
        text: labelPrefix.source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root]
      }
    );
    const labelLabels = labelItems.map((item) => item.label);

    expect(labelLabels).toContain("label");

    const second = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.vx"

      function summarizeScenario(scenario: Scenario): string {
        return scenario.^^^
      }
    `);
    await writeFile(mainPath, second.source, "utf8");
    const secondSession = createAnalysisSession(second.source);
    const secondItems = await createCompletionItemsForPosition(
      secondSession.ast!,
      second.line,
      second.character,
      secondSession.analysis!,
      [],
      {
        text: second.source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root]
      }
    );
    const secondLabels = secondItems.map((item) => item.label);

    expect(secondLabels).toContain("label");
    expect(secondLabels).toContain("source");
    expect(secondLabels).toContain("showTree");
  });

  it("offers members from a smart-cast 'is' check against an imported class", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-smart-cast-"));
    const astPath = join(root, "ast.vx");
    const optimizerPath = join(root, "optimizer.vx");
    await writeFile(astPath, dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }

      export class UnaryExpr(val operator: string, val operand: any) {
        readonly kind = "unary"
      }
    `, "utf8");
    const marked = sourceWithCursor(dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"

      export function foldConstants(expression: any): any {
        if (expression is UnaryExpr) {
          return expression.opera^^^
        }
      }
    `);
    await writeFile(optimizerPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const projectIndex = getProjectIndex([root]);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(optimizerPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(optimizerPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const session = createAnalysisSession(marked.source, externalDeclarations, importedSymbolTypes);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      marked.line,
      marked.character,
      session.analysis!,
      [],
      {
        text: marked.source,
        uri: pathToFileURL(optimizerPath).href,
        sourceRoots: [root],
        getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath),
        recoverAnalysisSession: (recovered) => createAnalysisSession(recovered, externalDeclarations, importedSymbolTypes)
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("operator");
    expect(labels).toContain("operand");
  });

  it("offers members from an 'instanceof' smart-cast against an imported class", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-smart-cast-instanceof-"));
    const astPath = join(root, "ast.vx");
    const optimizerPath = join(root, "optimizer.vx");
    await writeFile(astPath, dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }

      export class UnaryExpr(val operator: string, val operand: any) {
        readonly kind = "unary"
      }
    `, "utf8");
    const marked = sourceWithCursor(dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"

      export function foldConstants(expression: any): any {
        if (expression instanceof UnaryExpr) {
          return expression.opera^^^
        }
      }
    `);
    await writeFile(optimizerPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const projectIndex = getProjectIndex([root]);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(optimizerPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(optimizerPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const session = createAnalysisSession(marked.source, externalDeclarations, importedSymbolTypes);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      marked.line,
      marked.character,
      session.analysis!,
      [],
      {
        text: marked.source,
        uri: pathToFileURL(optimizerPath).href,
        sourceRoots: [root],
        getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath),
        recoverAnalysisSession: (recovered) => createAnalysisSession(recovered, externalDeclarations, importedSymbolTypes)
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("operator");
    expect(labels).toContain("operand");
  });

  it("offers smart-cast members for incomplete member access inside nested expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-smart-cast-nested-"));
    const astPath = join(root, "ast.vx");
    const optimizerPath = join(root, "optimizer.vx");
    await writeFile(astPath, dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }

      export class UnaryExpr(val operator: string, val operand: any) {
        readonly kind = "unary"
      }
    `, "utf8");
    const marked = sourceWithCursor(dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"

      export function foldConstants(expression: any): any {
        if (expression is UnaryExpr) {
          const operand = foldConstants(expression.operand)
          if (operand is NumberExpr) {
            return NumberExpr(expression.operat^^^)
          }
          return UnaryExpr(expression.operator, operand)
        }
      }
    `);
    await writeFile(optimizerPath, marked.source, "utf8");

    const baseSession = createAnalysisSession(marked.source);
    const projectIndex = getProjectIndex([root]);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(optimizerPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(optimizerPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const session = createAnalysisSession(marked.source, externalDeclarations, importedSymbolTypes);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      marked.line,
      marked.character,
      session.analysis!,
      [],
      {
        text: marked.source,
        uri: pathToFileURL(optimizerPath).href,
        sourceRoots: [root],
        getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath),
        recoverAnalysisSession: (recovered) => createAnalysisSession(recovered, externalDeclarations, importedSymbolTypes)
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("operator");
    expect(labels).not.toContain("operand");
  });

  it("offers members when imported aliases are expanded to structural object types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-completion-structural-type-"));
    const scenariosPath = join(root, "scenarios.vx");
    const mainPath = join(root, "main.vx");
    await writeFile(scenariosPath, dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `, "utf8");
    const { source, line, character } = sourceWithCursor(dedent`
      import { Scenario } from "./scenarios.vx"

      function lex(source: string) {}

      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.lab^^^)
      }
    `);
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const projectIndex = getProjectIndex([root]);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(mainPath).href,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath)
    });
    const session = createAnalysisSession(source, externalDeclarations, importedSymbolTypes);
    const items = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      {
        text: source,
        uri: pathToFileURL(mainPath).href,
        sourceRoots: [root],
        getSessionForFilePath: (filePath) => projectIndex.getSessionForFilePath(filePath),
        recoverAnalysisSession: (recovered) => createAnalysisSession(recovered, externalDeclarations, importedSymbolTypes)
      }
    );
    const labels = items.map((item) => item.label);

    expect(labels).toContain("label");
    expect(labels).not.toContain("Lowercase");
  });
  it("accepts a classResolverCache option and reuses it across calls", async () => {
    const source = dedent`
      class Counter {
        val count: int
        fun increment(): Counter => Counter(count + 1)
      }
      val c = Counter(0)
      c.^^^
    `;
    const { source: src, line, character } = sourceWithCursor(source);
    const session = createAnalysisSession(src);
    const sharedCache = createClassResolverCache();

    const items1 = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: src, classResolverCache: sharedCache }
    );
    const labels1 = items1.map((i) => i.label);
    expect(labels1).toContain("count");
    expect(labels1).toContain("increment");

    // Second call reusing the same cache — results must be identical
    const items2 = await createCompletionItemsForPosition(
      session.ast!,
      line,
      character,
      session.analysis!,
      [],
      { text: src, classResolverCache: sharedCache }
    );
    const labels2 = items2.map((i) => i.label);
    expect(labels2).toContain("count");
    expect(labels2).toContain("increment");
  });

  it("keeps the completion strategy modules layered under the orchestrator", async () => {
    // completion.ts orchestrates the strategy modules; the strategies must
    // never import back from it, so each one stays testable in isolation.
    const { readFile } = await import("node:fs/promises");
    for (const strategyModule of [
      "compiler/lsp/completionModel.ts",
      "compiler/lsp/memberCompletion.ts",
      "compiler/lsp/argumentCompletion.ts",
      "compiler/lsp/importCompletion.ts",
      "compiler/lsp/symbolCompletion.ts"
    ]) {
      const source = await readFile(strategyModule, "utf8");
      expect(source.includes('from "./completion"')).toBe(false);
    }
  });
});
