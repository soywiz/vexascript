import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { cacheProgram } from "./runtime/programCache";

describe("website project", () => {
  it("documents and exposes both MyLang Monaco embedding modes", async () => {
    const [embedSource, landingPage, layoutSource, syntaxPage, cliPage] = await Promise.all([
      readFile("website/src/assets/mylang-embed.ts", "utf8"),
      readFile("website/src/index.njk", "utf8"),
      readFile("website/src/_includes/layout.njk", "utf8"),
      readFile("website/src/syntax.njk", "utf8"),
      readFile("website/src/cli.njk", "utf8"),
    ]);

    expect(embedSource.includes('import "monaco-editor/min/vs/editor/editor.main.css"')).toBe(true);
    expect(embedSource.includes("createSimpleEditor")).toBe(true);
    expect(embedSource.includes("createWorkspaceEditor")).toBe(true);
    expect(embedSource.includes("createCompletionItemsForPosition")).toBe(true);
    expect(embedSource.includes("registerCompletionItemProvider")).toBe(true);
    expect(embedSource.includes("registerHoverProvider")).toBe(true);
    expect(embedSource.includes("registerDefinitionProvider")).toBe(true);
    expect(embedSource.includes("registerRenameProvider")).toBe(true);
    expect(embedSource.includes("registerCodeActionProvider")).toBe(true);
    expect(embedSource.includes("editor.action.rename")).toBe(true);
    expect(embedSource.includes("editor.action.quickFix")).toBe(true);
    expect(embedSource.includes("selection?: monaco.IRange")).toBe(true);
    expect(embedSource.includes("stabilizeEditorLayout")).toBe(true);
    expect(embedSource.includes('scrollbar: { vertical: "visible", horizontal: "visible", alwaysConsumeMouseWheel: false }')).toBe(true);
    expect(layoutSource.includes('/assets/generated/style.css')).toBe(true);
    expect(layoutSource.includes('href="/cli/"')).toBe(true);
    expect(landingPage.includes("{% highlightMyLang %}")).toBe(true);
    expect(landingPage.includes("MyLangEmbeds.createSimpleEditor")).toBe(true);
    expect(landingPage.includes("MyLangEmbeds.createWorkspaceEditor")).toBe(true);
    expect(landingPage.includes('<section id="cli" class="section alt">')).toBe(true);
    expect(landingPage.includes("Compile, bundle, run, inspect, and format from the terminal.")).toBe(true);
    expect(landingPage.includes('href="/cli/"')).toBe(true);
    expect(landingPage.includes("Open the CLI guide")).toBe(true);
    expect(landingPage.includes("pnpm tsx compiler/cli.ts build src/main.my --out dist/main.js --target optimized")).toBe(false);
    expect(landingPage.includes("Operator overloading")).toBe(true);
    expect(landingPage.includes("JSX with Preact")).toBe(true);
    expect(landingPage.includes("Implicit property access")).toBe(true);
    expect(landingPage.includes("operator+(other: Vec2) => Vec2(x + other.x, y + other.y)")).toBe(true);
    expect(landingPage.includes('import { h } from "preact"')).toBe(true);
    expect(landingPage.includes("return <section>Hello {props.name}</section>")).toBe(true);
    expect(landingPage.includes("value++")).toBe(true);
    expect(landingPage.includes("function dedent(strings, ...values)")).toBe(true);
    expect(landingPage.includes("String.raw({ raw: strings }, ...values)")).toBe(true);
    expect(landingPage.includes('const counterSnippet = dedent`')).toBe(true);
    expect(landingPage.includes("startLineNumber: 4")).toBe(true);
    expect(landingPage.includes("fun increment(): int")).toBe(true);
    expect(landingPage.includes('.find(str1)')).toBe(false);
    expect(syntaxPage.includes("This page renders the canonical")).toBe(false);
    expect(syntaxPage.includes('class="doc-content"')).toBe(false);
    expect(syntaxPage.includes('class="section"')).toBe(true);
    expect(cliPage.includes("pnpm tsx compiler/cli.ts build src/main.my --out dist/main.js --target optimized")).toBe(true);
    expect(cliPage.includes("<code>--bundle</code>")).toBe(true);
    expect(cliPage.includes("<code>--root &lt;dir&gt;</code>")).toBe(true);
  });

  it("keeps the website build wired through Vite and 11ty after preparing the compiler bundle", async () => {
    const [buildScript, packageJsonText, eleventyConfig, generatedSyntaxModule, syntaxHighlighter] = await Promise.all([
      readFile("website/scripts/build.ts", "utf8"),
      readFile("website/package.json", "utf8"),
      readFile("website/eleventy.config.mjs", "utf8"),
      readFile("website/src/generated/mylang-monarch-language.mjs", "utf8"),
      readFile("website/src/syntaxHighlight.mjs", "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build"]).toBe("tsx scripts/build.ts");
    expect(buildScript.includes("ensureCompilerBundle")).toBe(true);
    expect(buildScript.includes("ensureGeneratedSyntaxModule")).toBe(true);
    expect(buildScript.includes("createPortableMonarchLanguage")).toBe(true);
    expect(buildScript.includes("MYLANG_PRIMITIVE_TYPES")).toBe(true);
    expect(buildScript.includes("eleventy")).toBe(true);
    expect(buildScript.includes("vite")).toBe(true);
    expect(eleventyConfig.includes('./src/siteContent.mjs')).toBe(true);
    expect(eleventyConfig.includes('./src/syntaxHighlight.mjs')).toBe(true);
    expect(eleventyConfig.includes('config.addShortcode("year", function()')).toBe(true);
    expect(eleventyConfig.includes('config.addPairedShortcode("highlightMyLang", function(content)')).toBe(true);
    expect(generatedSyntaxModule.includes("export const mylangPortableLanguage =")).toBe(true);
    expect(generatedSyntaxModule.includes("export const mylangPrimitiveTypes =")).toBe(true);
    expect(syntaxHighlighter.includes("mylangPrimitiveTypes")).toBe(true);
  });

  it("keeps embedded syntax pages using toned-down top-level heading sizes", async () => {
    const siteCss = await readFile("website/src/assets/site.css", "utf8");

    expect(siteCss.includes('.section > h1')).toBe(true);
    expect(siteCss.includes('font-size: clamp(2.2rem, 5vw, 4rem)')).toBe(true);
    expect(siteCss.includes('.section > h2')).toBe(true);
    expect(siteCss.includes('font-size: clamp(1.6rem, 3vw, 2.4rem)')).toBe(true);
    expect(siteCss.includes('.cli-layout')).toBe(true);
    expect(siteCss.includes('.cli-command-list')).toBe(true);
    expect(siteCss.includes('.editor-shell { overflow: visible; }')).toBe(true);
    expect(siteCss.includes('.mylang-embed-workspace { display: grid; grid-template-rows: auto 1fr; border-radius: 1.5rem; overflow: visible; }')).toBe(true);
    expect(siteCss.includes('.token-keyword-declaration')).toBe(true);
    expect(siteCss.includes('.syntax-block')).toBe(true);
  });

  it("keeps Monaco browser entrypoints wired for browser-safe runtime support", async () => {
    const [monacoMain, monacoViteConfig, browserFsStub, runtimeProgramCache] = await Promise.all([
      readFile("plugins/monaco/src/main.ts", "utf8"),
      readFile("plugins/monaco/vite.config.ts", "utf8"),
      readFile("plugins/monaco/src/browser-stubs/node-fs-promises.ts", "utf8"),
      readFile("compiler/runtime/programCache.ts", "utf8"),
    ]);

    expect(monacoMain.includes('import "monaco-editor/min/vs/editor/editor.main.css"')).toBe(true);
    expect(monacoViteConfig.includes("programCacheStub")).toBe(false);
    expect(browserFsStub.includes("export async function mkdir")).toBe(true);
    expect(runtimeProgramCache.includes("cacheProgram")).toBe(true);
    expect(runtimeProgramCache.includes("_hash")).toBe(true);
    expect(runtimeProgramCache.includes("crypto.subtle")).toBe(true);
    expect(runtimeProgramCache.includes("node:")).toBe(false);
  });

  it("stores browser runtime programs under a path key plus a hash key", async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storageState = new Map<string, string>();
    const fakeStorage = {
      getItem(key: string): string | null {
        return storageState.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageState.set(key, value);
      },
    };

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: fakeStorage,
    });

    try {
      const sourceFilePath = "/runtime/dom.d.ts";
      const mtimeMs = 1234;
      const cacheSalt = "dom-runtime-v1";
      const program = { kind: "Program", statements: [] } as never;

      let generateCount = 0;
      const first = await cacheProgram(sourceFilePath, `${cacheSalt}:${mtimeMs}`, async () => {
        generateCount += 1;
        return program;
      });
      const second = await cacheProgram(sourceFilePath, `${cacheSalt}:${mtimeMs}`, async () => {
        generateCount += 1;
        return { kind: "Program", body: [] } as never;
      });

      expect(storageState.has(`mylang.runtime.program-cache.v1.${sourceFilePath}`)).toBe(true);
      expect(storageState.has(`mylang.runtime.program-cache.v1.${sourceFilePath}_hash`)).toBe(true);
      expect(first).toEqual(program);
      expect(second).toEqual(program);
      expect(generateCount).toBe(1);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});
