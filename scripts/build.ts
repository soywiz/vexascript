import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export interface DistributionBuildPaths {
  entryPoint: string;
  outputDir: string;
  runtimeDir: string;
}

const runtimeFiles = ["es2025.d.ts", "dom.d.ts", "vexascript.d.vx"] as const;

export async function buildDistribution(paths: DistributionBuildPaths): Promise<void> {
  const outputFile = join(paths.outputDir, "vexa.js");
  await rm(paths.outputDir, { recursive: true, force: true });
  await mkdir(paths.outputDir, { recursive: true });
  await build({
    entryPoints: [paths.entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: outputFile,
    sourcemap: true,
    external: [
      "commander",
      "vscode-languageserver",
      "vscode-languageserver-textdocument",
      "source-map",
      "esbuild",
    ],
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "error",
  });
  await Promise.all(
    runtimeFiles.map((fileName) => copyFile(join(paths.runtimeDir, fileName), join(paths.outputDir, fileName)))
  );
  await chmod(outputFile, 0o755);
}

async function main(): Promise<void> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await buildDistribution({
    entryPoint: join(rootDir, "cli", "cli-bin.ts"),
    outputDir: join(rootDir, "dist"),
    runtimeDir: join(rootDir, "compiler", "runtime"),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
