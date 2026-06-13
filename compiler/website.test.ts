import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { cacheProgram } from "./runtime/programCache";
import { fileExists } from "./utils/fs";

describe("website project", () => {
  it("documents and exposes the current embed and playground entrypoints", async () => {
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
    expect(embedSource.includes('import { COMPILER_VERSION } from "compiler/compilerVersion"')).toBe(true);
    expect(embedSource.includes("createSimpleEditor")).toBe(true);
    expect(embedSource.includes("createTabbedEditor")).toBe(true);
    expect(embedSource.includes("createWorkspaceEditor")).toBe(true);
    expect(embedSource.includes("createWorkbenchEditor")).toBe(true);
    expect(embedSource.includes("bundleModuleGraph")).toBe(true);
    expect(embedSource.includes("registerCompletionItemProvider")).toBe(true);
    expect(embedSource.includes("registerHoverProvider")).toBe(true);
    expect(embedSource.includes("registerDefinitionProvider")).toBe(true);
    expect(embedSource.includes("registerRenameProvider")).toBe(true);
    expect(embedSource.includes("registerCodeActionProvider")).toBe(true);
    expect(embedSource.includes("ensureEmbeddedRuntimeReady")).toBe(true);
    expect(embedSource.includes("await ensureEmbeddedRuntimeReady();")).toBe(true);
    expect(embedSource.includes("ensureVexaScriptRuntimeProgram")).toBe(true);
    expect(embedSource.includes("bundledVexaRuntimeUrl")).toBe(true);
    expect(embedSource.includes('"/runtime/vexascript.d.vx"')).toBe(true);
    expect(embedSource.includes("modelSessionCache.clear();")).toBe(true);
    expect(embedSource.includes("refreshDiagnosticsAndGlyphs(editor, model, `${reason}-runtime-ready`)")).toBe(true);
    expect(embedSource.includes("autoAwaitGlyphRefreshVersions")).toBe(true);
    expect(embedSource.includes("const workspaceSessionCache")).toBe(false);
    expect(embedSource.includes('data-action="menu-toggle-inlay-hints"')).toBe(true);
    expect(embedSource.includes("inlayHintsStorageKey")).toBe(true);
    expect(embedSource.includes("editor.updateOptions({")).toBe(true);
    expect(embedSource.includes("stabilizeEditorLayout")).toBe(true);
    expect(embedSource.includes("glyphMargin: true")).toBe(true);
    expect(layoutSource.includes('generatedAssetHrefs.generatedStyleCss')).toBe(true);
    expect(layoutSource.includes('generatedAssetHrefs.generatedEmbedJs')).toBe(true);
    expect(layoutSource.includes("vexa-embeds-ready")).toBe(true);
    expect(layoutSource.includes('href="/cli"')).toBe(true);
    expect(layoutSource.includes('href="/playground"')).toBe(true);
    expect(layoutSource.includes('src="/favicon.svg"')).toBe(true);
    expect(landingPage.includes("{% highlightVexaScript %}")).toBe(true);
    expect(landingPage.includes('<a class="button" href="/playground">Try the editor</a>')).toBe(true);
    expect(landingPage.includes('<a class="button secondary" href="/quickstart">Open the quickstart</a>')).toBe(true);
    expect(landingPage.includes('<section id="cli" class="section alt">')).toBe(true);
    expect(embedPage.includes("VexaScriptEmbeds.createSimpleEditor")).toBe(true);
    expect(embedPage.includes("VexaScriptEmbeds.createWorkbenchEditor")).toBe(true);
    expect(embedPage.includes('window.addEventListener("vexa-embeds-ready"')).toBe(true);
    expect(playgroundPage.includes('id="playground-workbench"')).toBe(true);
    expect(playgroundPage.includes("embeds.createWorkbenchEditor")).toBe(true);
    expect(playgroundPage.includes('window.addEventListener("vexa-embeds-ready"')).toBe(true);
    expect(playgroundPage.includes('c2d.drawCard(cardOrigin, cardSize, "#8cb3d9", "VexaScript")')).toBe(true);
    expect(playgroundPage.includes('import { increment, LoggedProperty } from "./counter.vx"')).toBe(true);
    expect(playgroundPage.includes('import { drawCard, drawDot } from "./c2d.vx"')).toBe(true);
    expect(playgroundPage.includes('path: "/src/c2d.vx"')).toBe(true);
    expect(playgroundPage.includes('return ${BACKTICK}(\\${point.x}, \\${point.y})${BACKTICK}')).toBe(true);
    expect(playgroundPage.includes("delay(pulseDelay / 100)")).toBe(true);
    expect(playgroundPage.includes("requestAnimationFrame")).toBe(false);
    expect(syntaxPage.includes('class="doc-shell"')).toBe(true);
    expect(cliPage.includes("<code>bundle</code>")).toBe(true);
    expect(notFoundPage.includes("permalink: 404.html")).toBe(true);
    expect(notFoundPage.includes("<h1>Page not found.</h1>")).toBe(true);
  });

  it("keeps the website build wired through embed generation and Eleventy", async () => {
    const [buildScript, cleanScript, devScript, prepareScript, buildEmbedScript, packageJsonText, eleventyConfig, syntaxHighlighter, faviconExists] = await Promise.all([
      readFile("website/scripts/build.ts", "utf8"),
      readFile("scripts/clean.ts", "utf8"),
      readFile("website/scripts/dev.ts", "utf8"),
      readFile("website/scripts/prepare.ts", "utf8"),
      readFile("website/scripts/buildEmbed.ts", "utf8"),
      readFile("website/package.json", "utf8"),
      readFile("website/eleventy.config.mjs", "utf8"),
      readFile("website/src/syntaxHighlight.mjs", "utf8"),
      fileExists(resolve(process.cwd(), "website", "src", "assets", "favicon.svg")),
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(packageJson.scripts?.["clean"]).toBe("tsx ../scripts/clean.ts");
    expect(packageJson.scripts?.["build"]).toBe("tsx scripts/build.ts");
    expect(packageJson.scripts?.["dev"]).toBe("tsx scripts/dev.ts");
    expect(packageJson.scripts?.["build:site"]).toBe("eleventy --config eleventy.config.mjs");
    expect(packageJson.scripts?.["build:embeds"]).toBe("tsx scripts/buildEmbed.ts");
    expect(packageJson.dependencies?.["@fortawesome/fontawesome-free"]).toBeTruthy();
    expect(packageJson.dependencies?.["monaco-editor"]).toBeTruthy();
    expect(buildScript.includes("ensureCompilerBundle")).toBe(true);
    expect(buildScript.includes("ensureGeneratedSyntaxModule")).toBe(true);
    expect(buildScript.includes("scripts/buildEmbed.ts")).toBe(true);
    expect(buildScript.includes("eleventy.config.mjs")).toBe(true);
    expect(cleanScript.includes("ensureGeneratedSyntaxModule")).toBe(true);
    expect(cleanScript.includes("ensureGeneratedEmbedSupportFiles")).toBe(true);
    expect(cleanScript.includes('website/_site/syntax')).toBe(true);
    expect(devScript.includes("ensureGeneratedSyntaxModule")).toBe(true);
    expect(devScript.includes("scripts/buildEmbed.ts")).toBe(true);
    expect(devScript.includes("--watch")).toBe(true);
    expect(devScript.includes("--serve")).toBe(true);
    expect(buildEmbedScript.includes('globalName: "VexaScriptEmbeds"')).toBe(false);
    expect(buildEmbedScript.includes('outfile: resolve(generatedAssetsRoot, "editor.worker.js")')).toBe(true);
    expect(buildEmbedScript.includes('entryNames: "vexa-embed"')).toBe(true);
    expect(buildEmbedScript.includes('compiler/runtime/domDeclarations')).toBe(true);
    expect(buildEmbedScript.includes('compiler/runtime/ecmascriptDeclarations')).toBe(true);
    expect(buildEmbedScript.includes("bundledVexaRuntimeUrl")).toBe(true);
    expect(buildEmbedScript.includes("loadVexaScriptDeclarations")).toBe(true);
    expect(buildEmbedScript.includes("ensureVexaScriptRuntimeProgram")).toBe(true);
    expect(buildEmbedScript.includes("getVexaScriptRuntimeProgram")).toBe(true);
    expect(buildEmbedScript.includes("isVexaScriptRuntimeNode")).toBe(true);
    expect(buildEmbedScript.includes('"/assets/generated/runtime/vexascript.d.vx"')).toBe(true);
    expect(buildEmbedScript.includes("writeGeneratedRuntimeBrowserModules")).toBe(true);
    expect(buildEmbedScript.includes("ecmascriptDeclarations.browser.ts")).toBe(true);
    expect(buildEmbedScript.includes("domDeclarations.browser.ts")).toBe(true);
    expect(buildEmbedScript.includes("patchRuntimeDeclarationsHost")).toBe(true);
    expect(buildEmbedScript.includes('node:fs/promises')).toBe(true);
    expect(buildEmbedScript.includes("ensureGeneratedEmbedSupportFiles")).toBe(true);
    expect(buildEmbedScript.includes("buildContext.onStart")).toBe(true);
    expect(buildEmbedScript.includes("async function writeFileIfChanged")).toBe(true);
    expect(buildEmbedScript.includes("async function copyFileIfChanged")).toBe(true);
    expect(buildEmbedScript.includes("if (sourceContent === targetContent)")).toBe(true);
    expect(eleventyConfig.includes('./src/siteContent.mjs')).toBe(true);
    expect(eleventyConfig.includes('./src/syntaxHighlight.mjs')).toBe(true);
    expect(eleventyConfig.includes('{ "src/assets/favicon.png": "favicon.png" }')).toBe(true);
    expect(eleventyConfig.includes('config.addGlobalData("generatedAssetHrefs"')).toBe(true);
    expect(eleventyConfig.includes('src/assets/generated/vexa-embed.js')).toBe(true);
    expect(eleventyConfig.includes('src/assets/generated/style.css')).toBe(true);
    expect(prepareScript.includes('src/generated/vexa-monarch-language.mjs')).toBe(true);
    expect(prepareScript.includes("export const vexaPortableLanguage =")).toBe(true);
    expect(prepareScript.includes("export const vexaPrimitiveTypes =")).toBe(true);
    expect(syntaxHighlighter.includes("vexaPrimitiveTypes")).toBe(true);
    expect(faviconExists).toBe(true);
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
