import { build, context, type BuildOptions, type Plugin } from "esbuild";
import { mkdir, readFile, rm, watch, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pathExists } from "./prepare.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptDirectory, "..");
const projectRoot = resolve(websiteRoot, "..");
const generatedAssetsRoot = resolve(websiteRoot, "src/assets/generated");
const generatedRuntimeRoot = resolve(generatedAssetsRoot, "runtime");
const legacyGeneratedPlaygroundRoot = resolve(generatedAssetsRoot, "playground");
const generatedManifestPath = resolve(websiteRoot, "src/generated/embed-asset-manifest.ts");
const embedEntryPoint = resolve(websiteRoot, "src/assets/vexa-embed.ts");
const workerEntryPoint = resolve(websiteRoot, "node_modules/monaco-editor/esm/vs/editor/editor.worker.js");
const vexaLanguageWorkerEntryPoint = resolve(websiteRoot, "src/assets/monaco/vexaLanguageWorker.ts");
const browserStubsRoot = resolve(websiteRoot, "src/assets/monaco/browser-stubs");
const generatedSourceRoot = resolve(websiteRoot, "src/generated");
const generatedEcmaDeclarationsBrowserModulePath = resolve(generatedSourceRoot, "ecmascriptDeclarations.browser.ts");
const generatedDomDeclarationsBrowserModulePath = resolve(generatedSourceRoot, "domDeclarations.browser.ts");

const bundledRuntimeSourcePath = resolve(projectRoot, "compiler/runtime/es2025.d.ts");
const bundledVexaRuntimeSourcePath = resolve(projectRoot, "compiler/runtime/vexascript.d.vx");
const bundledDomRuntimeSourcePath = resolve(projectRoot, "compiler/runtime/dom.d.ts");
const bundledRuntimeOutputPath = resolve(generatedRuntimeRoot, "es2025.d.ts");
const bundledVexaRuntimeOutputPath = resolve(generatedRuntimeRoot, "vexascript.d.vx");
const bundledDomRuntimeOutputPath = resolve(generatedRuntimeRoot, "dom.d.ts");

const isWatch = process.argv.includes("--watch");
const isDevelopmentBuild = process.argv.includes("--mode=development") || process.argv.includes("--mode") && process.argv.includes("development");

function manifestSource(): string {
  return [
    'export const editorWorkerUrl = "/assets/generated/editor.worker.js";',
    'export const vexaLanguageWorkerUrl = "/assets/generated/vexa-language.worker.js";',
    'export const bundledRuntimeUrl = "/assets/generated/runtime/es2025.d.ts";',
    'export const bundledVexaRuntimeUrl = "/assets/generated/runtime/vexascript.d.vx";',
    'export const bundledDomRuntimeUrl = "/assets/generated/runtime/dom.d.ts";',
    "",
  ].join("\n");
}

function ecmaDeclarationsBrowserModuleSource(): string {
  return [
    "import {",
    "  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,",
    "  ensureEcmaScriptRuntimeProgram,",
    "  getEcmaScriptRuntimeDeclarationFilePath,",
    "  getEcmaScriptRuntimeProgram,",
    "  isEcmaScriptRuntimeNode,",
    "  setEcmaScriptRuntimeDeclarationFilePath",
    '} from "compiler/runtime/ecmascriptDeclarations.shared";',
    "import {",
    "  VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME,",
    "  ensureVexaScriptRuntimeProgram,",
    "  getVexaScriptRuntimeDeclarationFilePath,",
    "  getVexaScriptRuntimeProgram,",
    "  isVexaScriptRuntimeNode,",
    "  setVexaScriptRuntimeDeclarationFilePath",
    '} from "compiler/runtime/vexascriptDeclarations.shared";',
    "",
    'setEcmaScriptRuntimeDeclarationFilePath("/runtime/es2025.d.ts");',
    'setVexaScriptRuntimeDeclarationFilePath("/runtime/vexascript.d.vx");',
    "",
    "export {",
    "  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,",
    "  ensureEcmaScriptRuntimeProgram,",
    "  ensureVexaScriptRuntimeProgram,",
    "  getEcmaScriptRuntimeDeclarationFilePath,",
    "  getEcmaScriptRuntimeProgram,",
    "  getVexaScriptRuntimeDeclarationFilePath,",
    "  getVexaScriptRuntimeProgram,",
    "  isEcmaScriptRuntimeNode,",
    "  isVexaScriptRuntimeNode",
    "};",
    "",
  ].join("\n");
}

function domDeclarationsBrowserModuleSource(): string {
  return [
    'import { patchRuntimeDeclarationsHost } from "compiler/runtime/declarationHost";',
    "import {",
    "  TYPESCRIPT_DOM_DECLARATION_FILE_NAME,",
    "  ensureDomProgram,",
    "  getDomDeclarationFilePath,",
    "  isDomRuntimeNode",
    '} from "compiler/runtime/domDeclarations.shared";',
    'import { bundledDomRuntimeUrl } from "./embed-asset-manifest";',
    "",
    "patchRuntimeDeclarationsHost({",
    "  async loadDomDeclarations() {",
    "    const response = await fetch(bundledDomRuntimeUrl);",
    "    if (!response.ok) {",
    '      throw new Error(`Failed to load bundled DOM declarations from ${bundledDomRuntimeUrl}`);',
    "    }",
    "    return {",
    "      filePath: TYPESCRIPT_DOM_DECLARATION_FILE_NAME,",
    "      source: await response.text()",
    "    };",
    "  }",
    "});",
    "",
    "export {",
    "  TYPESCRIPT_DOM_DECLARATION_FILE_NAME,",
    "  ensureDomProgram,",
    "  getDomDeclarationFilePath,",
    "  isDomRuntimeNode",
    "};",
    "",
  ].join("\n");
}

function aliasPlugin(): Plugin {
  const exactAliases = new Map<string, string>([
    ["compiler/runtime/ecmascriptDeclarations", resolve(browserStubsRoot, "ecmascriptDeclarations.ts")],
    ["compiler/runtime/domDeclarations", resolve(generatedSourceRoot, "domDeclarations.browser.ts")],
    ["compiler/runtime/ecmascriptDeclarations", resolve(generatedSourceRoot, "ecmascriptDeclarations.browser.ts")],
    ["vscode-languageserver/node.js", "vscode-languageserver/browser"],
    ["node:path", resolve(browserStubsRoot, "node-path.ts")],
    ["node:url", resolve(browserStubsRoot, "node-url.ts")],
    ["node:fs/promises", resolve(browserStubsRoot, "node-fs-promises.ts")],
    ["node:fs", resolve(browserStubsRoot, "node-fs-promises.ts")],
  ]);

  return {
    name: "vexa-embed-aliases",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, (args) => {
        const replacement = exactAliases.get(args.path);
        return replacement ? { path: replacement } : null;
      });
      buildContext.onResolve({ filter: /^compiler\/.+/ }, async (args) => {
        const basePath = resolve(projectRoot, args.path);
        const candidates = [
          basePath,
          `${basePath}.ts`,
          `${basePath}.tsx`,
          `${basePath}.js`,
          `${basePath}.mjs`,
        ];
        for (const candidate of candidates) {
          if (await pathExists(candidate)) {
            return { path: candidate };
          }
        }
        return { path: basePath };
      });
    },
  };
}

async function writeGeneratedManifest(): Promise<void> {
  await mkdir(dirname(generatedManifestPath), { recursive: true });
  await writeFileIfChanged(generatedManifestPath, manifestSource());
}

async function writeGeneratedRuntimeBrowserModules(): Promise<void> {
  await mkdir(generatedSourceRoot, { recursive: true });
  await Promise.all([
    writeFileIfChanged(generatedEcmaDeclarationsBrowserModulePath, ecmaDeclarationsBrowserModuleSource()),
    writeFileIfChanged(generatedDomDeclarationsBrowserModulePath, domDeclarationsBrowserModuleSource()),
  ]);
}

export async function ensureGeneratedEmbedSupportFiles(): Promise<void> {
  await Promise.all([
    mkdir(generatedAssetsRoot, { recursive: true }),
    mkdir(generatedRuntimeRoot, { recursive: true }),
    writeGeneratedManifest(),
    writeGeneratedRuntimeBrowserModules(),
  ]);
}

async function writeFileIfChanged(filePath: string, nextContent: string): Promise<boolean> {
  const previousContent = await readFile(filePath, "utf8").catch(() => null);
  if (previousContent === nextContent) {
    return false;
  }
  await writeFile(filePath, nextContent, "utf8");
  return true;
}

async function removeLegacyPlaygroundArtifacts(): Promise<void> {
  await rm(legacyGeneratedPlaygroundRoot, { recursive: true, force: true });
}

async function copyRuntimeAssets(): Promise<void> {
  await mkdir(generatedRuntimeRoot, { recursive: true });
  await Promise.all([
    copyFileIfChanged(bundledRuntimeSourcePath, bundledRuntimeOutputPath),
    copyFileIfChanged(bundledVexaRuntimeSourcePath, bundledVexaRuntimeOutputPath),
    copyFileIfChanged(bundledDomRuntimeSourcePath, bundledDomRuntimeOutputPath),
  ]);
}

async function copyFileIfChanged(from: string, to: string): Promise<boolean> {
  const [sourceContent, targetContent] = await Promise.all([
    readFile(from, "utf8"),
    readFile(to, "utf8").catch(() => null),
  ]);
  if (sourceContent === targetContent) {
    return false;
  }
  await writeFile(to, sourceContent, "utf8");
  return true;
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  if (!await pathExists(from)) {
    return;
  }
  await copyFileIfChanged(from, to);
}

async function normalizeEmbedCssOutputs(): Promise<void> {
  const sourceCssPath = resolve(generatedAssetsRoot, "vexa-embed.css");
  const targetCssPath = resolve(generatedAssetsRoot, "style.css");
  const sourceMapPath = resolve(generatedAssetsRoot, "vexa-embed.css.map");
  const targetMapPath = resolve(generatedAssetsRoot, "style.css.map");
  await copyIfPresent(sourceCssPath, targetCssPath);
  await copyIfPresent(sourceMapPath, targetMapPath);
  if (await pathExists(targetCssPath)) {
    const css = await readFile(targetCssPath, "utf8");
    const normalizedCss = css.replace(/vexa-embed\.css\.map/g, "style.css.map");
    if (normalizedCss !== css) {
      await writeFile(targetCssPath, normalizedCss, "utf8");
    }
  }
}

function baseBuildOptions(): Pick<BuildOptions, "bundle" | "platform" | "sourcemap" | "minify" | "target" | "logLevel"> {
  return {
    bundle: true,
    platform: "browser",
    sourcemap: isDevelopmentBuild,
    minify: !isDevelopmentBuild,
    target: isDevelopmentBuild ? ["esnext"] : ["es2020"],
    logLevel: "info",
  };
}

function workerBuildOptions(): BuildOptions {
  return {
    ...baseBuildOptions(),
    entryPoints: [workerEntryPoint],
    outfile: resolve(generatedAssetsRoot, "editor.worker.js"),
    format: "esm",
  };
}

function vexaLanguageWorkerBuildOptions(): BuildOptions {
  return {
    ...baseBuildOptions(),
    absWorkingDir: websiteRoot,
    entryPoints: [vexaLanguageWorkerEntryPoint],
    outfile: resolve(generatedAssetsRoot, "vexa-language.worker.js"),
    format: "esm",
    plugins: [aliasPlugin()],
  };
}

function embedBuildOptions(): BuildOptions {
  return {
    ...baseBuildOptions(),
    absWorkingDir: websiteRoot,
    entryPoints: [embedEntryPoint],
    outdir: generatedAssetsRoot,
    entryNames: "vexa-embed",
    format: "iife",
    keepNames: isDevelopmentBuild,
    assetNames: "assets/[name]-[hash]",
    loader: {
      ".ttf": "file",
      ".woff": "file",
      ".woff2": "file",
      ".eot": "file",
      ".svg": "file",
    },
    plugins: [
      aliasPlugin(),
      {
        name: "vexa-embed-postbuild",
        setup(buildContext) {
          buildContext.onStart(async () => {
            await ensureGeneratedEmbedSupportFiles();
          });
          buildContext.onEnd(async (result) => {
            if (result.errors.length > 0) {
              return;
            }
            await copyRuntimeAssets();
            await normalizeEmbedCssOutputs();
          });
        },
      },
    ],
  };
}

async function startRuntimeAssetWatchers(): Promise<void> {
  const watchPaths = [bundledRuntimeSourcePath, bundledDomRuntimeSourcePath];
  for (const filePath of watchPaths) {
    const watcher = watch(filePath);
    void (async () => {
      for await (const _event of watcher) {
        await copyRuntimeAssets();
        console.log(`[website] Updated copied runtime asset ${filePath}.`);
      }
    })();
  }
}

async function runBuild(): Promise<void> {
  await ensureGeneratedEmbedSupportFiles();
  await removeLegacyPlaygroundArtifacts();
  await copyRuntimeAssets();
  if (isWatch) {
    await startRuntimeAssetWatchers();
    const [workerContext, vexaLanguageWorkerContext, embedContext] = await Promise.all([
      context(workerBuildOptions()),
      context(vexaLanguageWorkerBuildOptions()),
      context(embedBuildOptions()),
    ]);
    await Promise.all([workerContext.watch(), vexaLanguageWorkerContext.watch(), embedContext.watch()]);
    console.log("[website] esbuild is watching vexa-embed assets.");
    return;
  }
  await Promise.all([
    build(workerBuildOptions()),
    build(vexaLanguageWorkerBuildOptions()),
    build(embedBuildOptions()),
  ]);
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  await runBuild();
}
