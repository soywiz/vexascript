import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { cacheProgram } from "./runtime/programCache";
import { fileExists } from "./utils/fs";

describe("website project", () => {
  it("documents and exposes both VexaScript Monaco embedding modes", async () => {
    const [embedSource, landingPage, layoutSource, syntaxPage, cliPage, embedPage, playgroundPage, notFoundPage] = await Promise.all([
      readFile("website/src/assets/vexa-embed.ts", "utf8"),
      readFile("website/src/index.njk", "utf8"),
      readFile("website/src/_includes/layout.njk", "utf8"),
      readFile("website/src/syntax.njk", "utf8"),
      readFile("website/src/cli.njk", "utf8"),
      readFile("website/src/embed.njk", "utf8"),
      readFile("website/src/playground.njk", "utf8"),
      readFile("website/src/404.njk", "utf8"),
    ]);

    expect(embedSource.includes('import "monaco-editor/min/vs/editor/editor.main.css"')).toBe(true);
    expect(embedSource.includes('import "@fortawesome/fontawesome-free/css/all.min.css"')).toBe(true);
    expect(embedSource.includes("createSimpleEditor")).toBe(true);
    expect(embedSource.includes("createTabbedEditor")).toBe(true);
    expect(embedSource.includes("createWorkspaceEditor")).toBe(true);
    expect(embedSource.includes("createWorkbenchEditor")).toBe(true);
    expect(embedSource.includes("bundleModuleGraph")).toBe(true);
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
    expect(embedSource.includes('import { createAutoAwaitDecorations } from "compiler/lsp/autoAwaitDecorations"')).toBe(true);
    expect(embedSource.includes("glyphMargin: true")).toBe(true);
    expect(embedSource.includes('glyphMarginClassName: "vexa-auto-await-glyph"')).toBe(true);
    expect(embedSource.includes("function updateAutoAwaitGlyphs(")).toBe(true);
    expect(layoutSource.includes('generatedAssetHrefs.generatedStyleCss')).toBe(true);
    expect(layoutSource.includes('generatedAssetHrefs.generatedEmbedJs')).toBe(true);
    expect(layoutSource.includes('generatedAssetHrefs.generatedPlaygroundHtml')).toBe(false);
    expect(layoutSource.includes('href="/cli/"')).toBe(true);
    expect(layoutSource.includes('href="/playground/"')).toBe(true);
    expect(layoutSource.includes('class="brand-icon"')).toBe(true);
    expect(layoutSource.includes('src="/favicon.svg"')).toBe(true);
    expect(landingPage.includes("{% highlightVexaScript %}")).toBe(true);
    expect(landingPage.includes("VexaScriptEmbeds.createSimpleEditor")).toBe(false);
    expect(landingPage.includes("VexaScriptEmbeds.createWorkspaceEditor")).toBe(false);
    expect(landingPage.includes('<section id="cli" class="section alt">')).toBe(true);
    expect(landingPage.includes("Compile, bundle, run, inspect, and format from the terminal.")).toBe(true);
    expect(landingPage.includes('href="/cli/"')).toBe(true);
    expect(landingPage.includes("Open the CLI guide")).toBe(true);
    expect(landingPage.includes("pnpm tsx compiler/cli.ts build src/main.vx --out dist/main.js --target optimized")).toBe(false);
    expect(landingPage.includes("Operator overloading")).toBe(true);
    expect(landingPage.includes("JSX with Preact")).toBe(true);
    expect(landingPage.includes("Implicit property access")).toBe(true);
    expect(landingPage.includes("operator+(other: Vec2) => Vec2(x + other.x, y + other.y)")).toBe(true);
    expect(landingPage.includes('import { h } from "preact"')).toBe(true);
    expect(landingPage.includes("return <section>Hello {name}</section>")).toBe(true);
    expect(landingPage.includes("++value")).toBe(true);
    expect(embedPage.includes("VexaScriptEmbeds.createSimpleEditor")).toBe(true);
    expect(embedPage.includes("VexaScriptEmbeds.createTabbedEditor")).toBe(true);
    expect(embedPage.includes("VexaScriptEmbeds.createWorkspaceEditor")).toBe(true);
    expect(embedPage.includes("VexaScriptEmbeds.createWorkbenchEditor")).toBe(true);
    expect(embedSource.includes('data-action="expand"')).toBe(true);
    expect(embedSource.includes('fa-solid fa-arrow-left')).toBe(true);
    expect(embedSource.includes('fa-solid fa-arrow-right')).toBe(true);
    expect(embedSource.includes('fa-solid fa-wand-magic-sparkles')).toBe(true);
    expect(embedSource.includes('fa-solid fa-floppy-disk')).toBe(true);
    expect(embedSource.includes('fa-solid fa-play')).toBe(true);
    expect(embedSource.includes('fa-solid fa-up-right-and-down-left-from-center')).toBe(true);
    expect(embedSource.includes('data-action="run"')).toBe(true);
    expect(embedSource.includes('vexa-embed-workbench-preview')).toBe(true);
    expect(embedSource.includes('vexa-workbench-console')).toBe(true);
    expect(embedPage.includes("function dedent(strings, ...values)")).toBe(true);
    expect(embedPage.includes("String.raw({ raw: strings }, ...values)")).toBe(true);
    expect(embedPage.includes('const counterSnippet = dedent`')).toBe(true);
    expect(embedPage.includes("startLineNumber: 4")).toBe(true);
    expect(embedPage.includes("increment(): int => ++value")).toBe(true);
    expect(embedPage.includes('<div id="workbench-editor" class="workbench-demo"></div>')).toBe(true);
    expect(embedPage.includes("workspace tree, toolbar, formatting, and save controls")).toBe(true);
    expect(embedSource.includes('Collapse')).toBe(true);
    expect(playgroundPage.includes('id="playground-workbench"')).toBe(true);
    expect(playgroundPage.includes("VexaScriptEmbeds.createWorkbenchEditor")).toBe(true);
    expect(playgroundPage.includes('class="playground-frame"')).toBe(false);
    expect(landingPage.includes('.find(str1)')).toBe(false);
    expect(syntaxPage.includes("This page renders the canonical")).toBe(false);
    expect(syntaxPage.includes('class="doc-content"')).toBe(false);
    expect(syntaxPage.includes('class="section"')).toBe(true);
    expect(cliPage.includes("pnpm tsx compiler/cli.ts build src/main.vx --out dist/main.js --target optimized")).toBe(true);
    expect(cliPage.includes("<code>bundle</code>")).toBe(true);
    expect(cliPage.includes("<code>--root &lt;dir&gt;</code>")).toBe(true);
    expect(notFoundPage.includes("permalink: 404.html")).toBe(true);
    expect(notFoundPage.includes("<h1>Page not found.</h1>")).toBe(true);
    expect(notFoundPage.includes('href="/syntax/"')).toBe(true);
  });

  it("keeps the website build wired through Vite and 11ty after preparing the compiler bundle", async () => {
    const [buildScript, devScript, prepareScript, packageJsonText, eleventyConfig, syntaxHighlighter, faviconExists] = await Promise.all([
      readFile("website/scripts/build.ts", "utf8"),
      readFile("website/scripts/dev.ts", "utf8"),
      readFile("website/scripts/prepare.ts", "utf8"),
      readFile("website/package.json", "utf8"),
      readFile("website/eleventy.config.mjs", "utf8"),
      readFile("website/src/syntaxHighlight.mjs", "utf8"),
      fileExists(resolve(process.cwd(), "website", "src", "assets", "favicon.svg")),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build"]).toBe("tsx scripts/build.ts");
    expect(packageJson.scripts?.["dev"]).toBe("tsx scripts/dev.ts");
    expect(packageJson.scripts?.["build:playground"]).toBe("vite build --config vite.playground.config.ts");
    expect((JSON.parse(packageJsonText) as { dependencies?: Record<string, string> }).dependencies?.["@fortawesome/fontawesome-free"]).toBeTruthy();
    expect(buildScript.includes("ensureCompilerBundle")).toBe(true);
    expect(buildScript.includes("ensureGeneratedSyntaxModule")).toBe(true);
    expect(buildScript.includes('vite.playground.config.ts')).toBe(true);
    expect(devScript.includes("ensureGeneratedSyntaxModule")).toBe(true);
    expect(devScript.includes('vite.playground.config.ts')).toBe(true);
    expect(devScript.includes("websiteRoot")).toBe(true);
    expect(devScript.includes('eleventy')).toBe(true);
    expect(buildScript.includes("eleventy")).toBe(true);
    expect(buildScript.includes("vite")).toBe(true);
    expect(eleventyConfig.includes('./src/siteContent.mjs')).toBe(true);
    expect(eleventyConfig.includes('./src/syntaxHighlight.mjs')).toBe(true);
    expect(eleventyConfig.includes('{ "src/assets/favicon.svg": "favicon.svg" }')).toBe(true);
    expect(eleventyConfig.includes('config.addGlobalData("generatedAssetHrefs"')).toBe(true);
    expect(eleventyConfig.includes('src/assets/generated/vexa-embed.js')).toBe(true);
    expect(eleventyConfig.includes('src/assets/generated/playground/index.html')).toBe(true);
    expect(eleventyConfig.includes('src/assets/generated/style.css')).toBe(true);
    expect(eleventyConfig.includes('config.addShortcode("year", function()')).toBe(true);
    expect(eleventyConfig.includes('config.addPairedShortcode("highlightVexaScript", function(content)')).toBe(true);
    expect(prepareScript.includes('src/generated/vexa-monarch-language.mjs')).toBe(true);
    expect(prepareScript.includes("export const vexaPortableLanguage =")).toBe(true);
    expect(prepareScript.includes("export const vexaPrimitiveTypes =")).toBe(true);
    expect(syntaxHighlighter.includes("vexaPrimitiveTypes")).toBe(true);
    expect(faviconExists).toBe(true);
  });

  it("keeps embedded syntax pages using toned-down top-level heading sizes", async () => {
    const [siteCss, layoutSource] = await Promise.all([
      readFile("website/src/assets/site.css", "utf8"),
      readFile("website/src/_includes/layout.njk", "utf8"),
    ]);

    expect(siteCss.includes('.section > h1')).toBe(true);
    expect(siteCss.includes('font-size: clamp(2.2rem, 5vw, 4rem)')).toBe(true);
    expect(siteCss.includes('.section > h2')).toBe(true);
    expect(siteCss.includes('font-size: clamp(1.6rem, 3vw, 2.4rem)')).toBe(true);
    expect(siteCss.includes('.cli-layout')).toBe(true);
    expect(siteCss.includes('.brand-icon')).toBe(true);
    expect(siteCss.includes('.cli-command-list')).toBe(true);
    expect(siteCss.includes('.editor-shell { overflow: visible; }')).toBe(true);
    expect(siteCss.includes('.vexa-embed-workspace { display: grid; grid-template-rows: auto 1fr; border-radius: 1.5rem; overflow: visible; }')).toBe(true);
    expect(siteCss.includes('.playground-frame {')).toBe(true);
    expect(siteCss.includes('.workbench-demo { height: 760px; }')).toBe(true);
    expect(siteCss.includes('.vexa-embed-workbench-shell {')).toBe(true);
    expect(siteCss.includes('.vexa-embed-workbench.is-expanded {')).toBe(true);
    expect(siteCss.includes('.vexa-embed-toolbar-button-icon-only')).toBe(true);
    expect(siteCss.includes('.vexa-embed-workbench-runner {')).toBe(true);
    expect(siteCss.includes('.vexa-embed-workbench-preview {')).toBe(true);
    expect(siteCss.includes('.vexa-embed-workbench-output {')).toBe(true);
    expect(siteCss.includes('.token-keyword-declaration')).toBe(true);
    expect(siteCss.includes('.syntax-block')).toBe(true);
    expect(layoutSource.includes('rel="icon"')).toBe(true);
    expect(layoutSource.includes('href="/favicon.svg"')).toBe(true);
  });

  it("keeps Monaco browser entrypoints wired for browser-safe runtime support", async () => {
    const [monacoMain, monacoViteConfig, playgroundViteConfig, browserFsStub, runtimeProgramCache] = await Promise.all([
      readFile("plugins/monaco/src/main.ts", "utf8"),
      readFile("plugins/monaco/vite.config.ts", "utf8"),
      readFile("website/vite.playground.config.ts", "utf8"),
      readFile("plugins/monaco/src/browser-stubs/node-fs-promises.ts", "utf8"),
      readFile("compiler/runtime/programCache.ts", "utf8"),
    ]);

    expect(monacoMain.includes('import "monaco-editor/min/vs/editor/editor.main.css"')).toBe(true);
    expect(monacoViteConfig.includes("programCacheStub")).toBe(false);
    expect(playgroundViteConfig.includes('find: "monaco-editor"')).toBe(true);
    expect(playgroundViteConfig.includes('resolve(__dirname, "node_modules/monaco-editor")')).toBe(true);
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

      expect(storageState.has(`vexa.runtime.program-cache.v1.${sourceFilePath}`)).toBe(true);
      expect(storageState.has(`vexa.runtime.program-cache.v1.${sourceFilePath}_hash`)).toBe(true);
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
