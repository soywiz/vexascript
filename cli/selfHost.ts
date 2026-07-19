import "./localVfs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "../compiler/utils/path";
import { runCli } from "./cli";
import { runCommandCapture } from "./io";

export interface SelfHostOptions {
  entryFile?: string;
  outputDir: string;
  roundTrips?: number;
}

export interface SelfHostResult {
  outputPaths: string[];
  sha256: string;
}

function failedCompilerMessage(outputPath: string, stdout: string, stderr: string): string {
  return [
    `Self-hosted compiler failed: ${outputPath}`,
    stdout.trim(),
    stderr.trim()
  ].filter((line) => line.length > 0).join("\n");
}

async function runGeneratedCompiler(
  compilerPath: string,
  entryFile: string,
  outputPath: string,
  isolatedCwd: string
): Promise<void> {
  const result = await runCommandCapture(process.execPath, [
    compilerPath,
    "bundle",
    entryFile,
    "--platform",
    "node",
    "--out",
    outputPath
  ], { cwd: isolatedCwd });
  if (result.code !== 0) {
    throw new Error(failedCompilerMessage(compilerPath, result.stdout, result.stderr));
  }
}

/**
 * Builds the compiler once with the source compiler and then repeatedly asks
 * each generated compiler to rebuild the same entrypoint. Stable output is a
 * fixed-point assertion over parsing, analysis, emission, and bundling.
 */
export async function selfHostCompiler(options: SelfHostOptions): Promise<SelfHostResult> {
  const roundTrips = options.roundTrips ?? 3;
  if (!Number.isInteger(roundTrips) || roundTrips < 2) {
    throw new Error("Self-hosting requires at least two roundtrips");
  }

  const entryFile = resolve(options.entryFile ?? resolve(process.cwd(), "cli", "cli-bin.ts"));
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });

  const outputPaths = Array.from(
    { length: roundTrips },
    (_, index) => resolve(outputDir, `vexa-self-host-${index + 1}.js`)
  );
  const firstOutput = outputPaths[0]!;
  await runCli([
    process.execPath,
    "vexa",
    "bundle",
    entryFile,
    "--platform",
    "node",
    "--out",
    firstOutput
  ]);

  for (let index = 1; index < outputPaths.length; index += 1) {
    await runGeneratedCompiler(outputPaths[index - 1]!, entryFile, outputPaths[index]!, outputDir);
  }

  const outputs = await Promise.all(outputPaths.map((outputPath) => readFile(outputPath)));
  const first = outputs[0]!;
  for (let index = 1; index < outputs.length; index += 1) {
    if (!first.equals(outputs[index]!)) {
      throw new Error(`Self-hosting did not reach a fixed point at roundtrip ${index + 1}`);
    }
  }

  const version = await runCommandCapture(process.execPath, [outputPaths.at(-1)!, "--version"], {
    cwd: outputDir
  });
  if (version.code !== 0) {
    throw new Error(failedCompilerMessage(outputPaths.at(-1)!, version.stdout, version.stderr));
  }

  return {
    outputPaths,
    sha256: createHash("sha256").update(first).digest("hex")
  };
}
