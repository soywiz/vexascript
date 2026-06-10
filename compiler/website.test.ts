import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { cacheProgram } from "./runtime/programCache";

describe("website project", () => {
  it("documents and exposes both MyLang Monaco embedding modes", async () => {
    const [embedSource, landingPage, layoutSource] = await Promise.all([
      readFile("website/src/assets/mylang-embed.ts", "utf8"),
      readFile("website/src/index.njk", "utf8"),
      readFile("website/src/_includes/layout.njk", "utf8"),
    ]);

    expect(embedSource.includes('import "monaco-editor/min/vs/editor/editor.main.css"')).toBe(true);
    expect(embedSource.includes("createSimpleEditor")).toBe(true);
    expect(embedSource.includes("createWorkspaceEditor")).toBe(true);
    expect(embedSource.includes("createCompletionItemsForPosition")).toBe(true);
    expect(embedSource.includes("registerCompletionItemProvider")).toBe(true);
    expect(embedSource.includes("selection?: monaco.IRange")).toBe(true);
    expect(embedSource.includes("stabilizeEditorLayout")).toBe(true);
    expect(layoutSource.includes('/assets/generated/style.css')).toBe(true);
    expect(landingPage.includes("MyLangEmbeds.createSimpleEditor")).toBe(true);
    expect(landingPage.includes("MyLangEmbeds.createWorkspaceEditor")).toBe(true);
    expect(landingPage.includes("const counterSnippet = `class Counter")).toBe(true);
    expect(landingPage.includes("startLineNumber: 4")).toBe(true);
    expect(landingPage.includes("fun increment(): int")).toBe(false);
  });

  it("keeps the website build wired through Vite and 11ty after preparing the compiler bundle", async () => {
    const [buildScript, packageJsonText] = await Promise.all([
      readFile("website/scripts/build.ts", "utf8"),
      readFile("website/package.json", "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build"]).toBe("tsx scripts/build.ts");
    expect(buildScript.includes("ensureCompilerBundle")).toBe(true);
    expect(buildScript.includes("eleventy")).toBe(true);
    expect(buildScript.includes("vite")).toBe(true);
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
