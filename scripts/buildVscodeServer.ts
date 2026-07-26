import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { textModulePlugin } from "./textModulePlugin";

export async function buildVscodeServer(projectRoot: string): Promise<void> {
  const outputDirectory = resolve(projectRoot, "plugins/vscode/dist");
  const outputFile = resolve(outputDirectory, "vexa.mjs");
  const runtimeDirectory = resolve(projectRoot, "compiler/runtime");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: [resolve(projectRoot, "compiler/lsp/server.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: outputFile,
    sourcemap: true,
    external: [
      "vscode-languageserver",
      "vscode-languageserver/node.js",
      "vscode-languageserver-textdocument"
    ],
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "error",
    plugins: [textModulePlugin()]
  });
  await Promise.all([
    copyFile(resolve(runtimeDirectory, "es2025.d.ts"), resolve(outputDirectory, "es2025.d.ts")),
    copyFile(resolve(runtimeDirectory, "dom.d.ts"), resolve(outputDirectory, "dom.d.ts")),
    copyFile(resolve(runtimeDirectory, "vexascript.d.vx"), resolve(outputDirectory, "vexascript.d.vx"))
  ]);
  await chmod(outputFile, 0o755);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void buildVscodeServer(projectRoot).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
