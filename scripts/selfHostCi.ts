import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolve } from "../compiler/utils/path";
import { runCommandCapture, type CommandOutput } from "../cli/io";
import { compileNativeExecutable } from "../cli/nativeBuild";

export type SelfHostStageStatus = "passed" | "failed" | "blocked";

export interface SelfHostCiStage {
  name: string;
  elapsedMilliseconds: number;
  status: SelfHostStageStatus;
  detail: string;
}

export interface SelfHostCiTiming {
  host: string;
  generationMilliseconds: number | null;
  repeatGenerationMilliseconds: number | null;
  linkMilliseconds: number | null;
  repeatLinkMilliseconds: number | null;
  result: string;
}

interface TimedCommand extends CommandOutput {
  elapsedMilliseconds: number;
}

function formatMilliseconds(milliseconds: number): string {
  return `${milliseconds.toFixed(0)} ms`;
}

function summaryCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

export function renderSelfHostSummary(
  stages: readonly SelfHostCiStage[],
  runner: string,
  outputDirectory: string,
  timings: readonly SelfHostCiTiming[] = [],
): string {
  const failed = stages.filter((stage) => stage.status === "failed").length;
  const blocked = stages.filter((stage) => stage.status === "blocked").length;
  const status = failed === 0 && blocked === 0 ? "passed" : "failed";
  const rows = stages.map((stage) => [
    stage.name,
    formatMilliseconds(stage.elapsedMilliseconds),
    stage.status,
    stage.detail,
  ]);
  const timingRows = timings.map((timing) => [
    timing.host,
    timing.generationMilliseconds === null ? "—" : formatMilliseconds(timing.generationMilliseconds),
    timing.repeatGenerationMilliseconds === null ? "—" : formatMilliseconds(timing.repeatGenerationMilliseconds),
    timing.linkMilliseconds === null ? "—" : formatMilliseconds(timing.linkMilliseconds),
    timing.repeatLinkMilliseconds === null ? "—" : formatMilliseconds(timing.repeatLinkMilliseconds),
    timing.result,
  ]);

  return [
    "## Compiler self-hosting",
    "",
    `Status: **${status}** on \`${runner}\`.`,
    "",
    "### C++ generation and link timing",
    "",
    "| Host | Generation 1 | Generation 2 | Link 1 | Link 2 | Result |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...timingRows.map((row) => `| ${row.map(summaryCell).join(" | ")} |`),
    "",
    "### Stage status",
    "",
    "| Stage | Time | Status | Result |",
    "| --- | ---: | --- | --- |",
    ...rows.map((row) => `| ${row.map(summaryCell).join(" | ")} |`),
    "",
    `Generated files are kept in \`${outputDirectory}\` while this job is running.`,
  ].join("\n");
}

function commandFailure(command: string, args: readonly string[], result: CommandOutput): Error {
  const output = [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n");
  return new Error([
    `Command failed with exit code ${result.code ?? "unknown"}: ${command} ${args.join(" ")}`,
    output,
  ].filter((line) => line.length > 0).join("\n"));
}

async function timedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<TimedCommand> {
  const started = performance.now();
  const result = await runCommandCapture(command, [...args], { cwd });
  return { ...result, elapsedMilliseconds: performance.now() - started };
}

async function runCheckedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<TimedCommand> {
  const result = await timedCommand(command, args, cwd);
  if (result.code !== 0) {
    throw commandFailure(command, args, result);
  }
  return result;
}

async function compareOutputs(firstPath: string, secondPath: string, label: string): Promise<string> {
  const [first, second] = await Promise.all([readFile(firstPath), readFile(secondPath)]);
  if (!first.equals(second)) {
    throw new Error(`${label} outputs are not byte-identical`);
  }
  return createHash("sha256").update(first).digest("hex");
}

async function timedNativeLink(cppPath: string, executablePath: string): Promise<number> {
  const started = performance.now();
  await compileNativeExecutable(cppPath, executablePath, [], "-O0");
  return performance.now() - started;
}

async function writeGitHubSummary(
  stages: readonly SelfHostCiStage[],
  timings: readonly SelfHostCiTiming[],
  outputDirectory: string,
): Promise<void> {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (!summaryPath) {
    console.log(renderSelfHostSummary(stages, "local", outputDirectory, timings));
    return;
  }
  await appendFile(summaryPath, `${renderSelfHostSummary(stages, process.env["RUNNER_OS"] ?? "GitHub Actions", outputDirectory, timings)}\n`);
}

function detailForError(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
}

function compiledCliCommand(
  compiledCli: string,
  tsxLoader: string,
  textModuleLoader: string,
  args: readonly string[],
): string[] {
  const moduleUrl = JSON.stringify(pathToFileURL(compiledCli).href);
  const argv = JSON.stringify(["node", "vexa", ...args]);
  const source = `const { runCli } = await import(${moduleUrl}); await runCli(${argv});`;
  return ["--import", tsxLoader, "--import", textModuleLoader, "--input-type=module", "-e", source];
}

async function main(): Promise<void> {
  const rootDirectory = resolve(process.cwd());
  const outputDirectory = await mkdtemp(join(rootDirectory, "node_modules", ".vexa-self-host-ci-"));
  const tscDirectory = join(outputDirectory, "tsc");
  const javascriptEntryFile = resolve(rootDirectory, "cli", "cli-bin.ts");
  const cppEntryFile = resolve(rootDirectory, "cli", "cli.ts");
  const compiledCli = resolve(tscDirectory, "cli", "cli.js");
  const tsxLoader = resolve(rootDirectory, "node_modules", "tsx", "dist", "loader.mjs");
  const textModuleLoader = resolve(rootDirectory, "scripts", "registerTextModuleLoader.cjs");
  const stages: SelfHostCiStage[] = [];
  const timings: SelfHostCiTiming[] = [
    { host: "tsc", generationMilliseconds: null, repeatGenerationMilliseconds: null, linkMilliseconds: null, repeatLinkMilliseconds: null, result: "not run" },
    { host: "VexaScript JS", generationMilliseconds: null, repeatGenerationMilliseconds: null, linkMilliseconds: null, repeatLinkMilliseconds: null, result: "not run" },
    { host: "VexaScript C++", generationMilliseconds: null, repeatGenerationMilliseconds: null, linkMilliseconds: null, repeatLinkMilliseconds: null, result: "not run" },
  ];
  let bootstrapReady = false;

  try {
    const tsc = await timedCommand("pnpm", [
      "exec",
      "tsc",
      "--project",
      resolve(rootDirectory, "tsconfig.json"),
      "--outDir",
      tscDirectory,
      "--noEmit",
      "false",
      "--allowImportingTsExtensions",
      "false",
      "--rewriteRelativeImportExtensions",
      "--pretty",
      "false",
    ], rootDirectory);
    stages.push({
      name: "tsc",
      elapsedMilliseconds: tsc.elapsedMilliseconds,
      status: tsc.code === 0 ? "passed" : "failed",
      detail: tsc.code === 0 ? "TypeScript compiler emitted JavaScript" : detailForError(commandFailure("pnpm", ["exec", "tsc", "--outDir", tscDirectory], tsc)),
    });
    if (tsc.code !== 0) {
      console.error(commandFailure("pnpm", ["exec", "tsc", "--outDir", tscDirectory], tsc).message);
    }

    try {
      if (tsc.code !== 0) throw new Error("blocked by tsc");
      await mkdir(resolve(tscDirectory, "compiler", "runtime"), { recursive: true });
      await mkdir(resolve(tscDirectory, "native"), { recursive: true });
      await mkdir(resolve(outputDirectory, "node_modules"), { recursive: true });
      await Promise.all([
        copyFile(resolve(rootDirectory, "tsconfig.json"), resolve(tscDirectory, "tsconfig.json")),
        copyFile(resolve(rootDirectory, "compiler", "runtime", "dom.d.ts"), resolve(tscDirectory, "compiler", "runtime", "dom.d.ts")),
        copyFile(resolve(rootDirectory, "compiler", "runtime", "es2025.d.ts"), resolve(tscDirectory, "compiler", "runtime", "es2025.d.ts")),
        copyFile(resolve(rootDirectory, "compiler", "runtime", "vexascript.d.vx"), resolve(tscDirectory, "compiler", "runtime", "vexascript.d.vx")),
        copyFile(resolve(rootDirectory, "native", "runtime.cpp"), resolve(tscDirectory, "native", "runtime.cpp")),
        copyFile(resolve(rootDirectory, "native", "bigint.h"), resolve(tscDirectory, "native", "bigint.h")),
        copyFile(resolve(rootDirectory, "native", "utf.h"), resolve(tscDirectory, "native", "utf.h")),
        copyFile(resolve(rootDirectory, "native", "oilpan-20260622.zip"), resolve(tscDirectory, "native", "oilpan-20260622.zip")),
        copyFile(resolve(rootDirectory, "native", "mimalloc-3.4.3.zip"), resolve(tscDirectory, "native", "mimalloc-3.4.3.zip")),
      ]);
      await symlink(resolve(tscDirectory, "compiler"), resolve(outputDirectory, "node_modules", "compiler"), "dir");
      bootstrapReady = true;
    } catch (error) {
      console.error(`Compiler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const jsStarted = performance.now();
    try {
      if (!bootstrapReady) throw new Error("blocked by compiler bootstrap");
      const firstJavaScript = join(outputDirectory, "vexa-self-host-1.js");
      const secondJavaScript = join(outputDirectory, "vexa-self-host-2.js");
      await runCheckedCommand("node", compiledCliCommand(compiledCli, tsxLoader, textModuleLoader, ["bundle", javascriptEntryFile, "--platform", "node", "--out", firstJavaScript]), tscDirectory);
      await runCheckedCommand("node", [firstJavaScript, "bundle", javascriptEntryFile, "--platform", "node", "--out", secondJavaScript], outputDirectory);
      const hash = await compareOutputs(firstJavaScript, secondJavaScript, "JavaScript self-host");
      stages.push({
        name: "VexaScript JS",
        elapsedMilliseconds: performance.now() - jsStarted,
        status: "passed",
        detail: `two generations are byte-identical (${hash})`,
      });
    } catch (error) {
      stages.push({
        name: "VexaScript JS",
        elapsedMilliseconds: performance.now() - jsStarted,
        status: bootstrapReady ? "failed" : "blocked",
        detail: detailForError(error),
      });
      console.error(`JavaScript self-host failed: ${error instanceof Error ? error.message : String(error)}`);
      timings[1]!.result = "failed";
    }

    const cppStarted = performance.now();
    try {
      if (!bootstrapReady) throw new Error("blocked by compiler bootstrap");
      const tscBuildDirectory = join(outputDirectory, "cpp-build-tsc");
      const jsBuildDirectory = join(outputDirectory, "cpp-build-js");
      const cppBuildDirectory = join(outputDirectory, "cpp-build-cpp");
      const cppRepeatBuildDirectory = join(outputDirectory, "cpp-build-cpp-repeat");
      const tscCpp = join(tscBuildDirectory, "main.cpp");
      const jsCpp = join(jsBuildDirectory, "main.cpp");
      const cppCpp = join(cppBuildDirectory, "main.cpp");
      const cppRepeat = join(cppRepeatBuildDirectory, "main.cpp");
      const tscExecutable = join(outputDirectory, "vexa-tsc-host");
      const jsExecutable = join(outputDirectory, "vexa-js-host");
      const cppExecutable = join(outputDirectory, "vexa-cpp-host");
      const cppRepeatExecutable = join(outputDirectory, "vexa-cpp-host-repeat");

      const tscGenerationStarted = performance.now();
      await runCheckedCommand("node", compiledCliCommand(compiledCli, tsxLoader, textModuleLoader, ["cpp", "build", cppEntryFile, "--out", tscCpp]), tscDirectory);
      timings[0]!.generationMilliseconds = performance.now() - tscGenerationStarted;
      timings[0]!.linkMilliseconds = await timedNativeLink(tscCpp, tscExecutable);

      const jsGenerationStarted = performance.now();
      await runCheckedCommand("node", [join(outputDirectory, "vexa-self-host-2.js"), "cpp", "build", cppEntryFile, "--out", jsCpp], outputDirectory);
      timings[1]!.generationMilliseconds = performance.now() - jsGenerationStarted;
      timings[1]!.linkMilliseconds = await timedNativeLink(jsCpp, jsExecutable);

      const cppGenerationStarted = performance.now();
      await runCheckedCommand(tscExecutable, ["cpp", "build", cppEntryFile, "--out", cppCpp], rootDirectory);
      timings[2]!.generationMilliseconds = performance.now() - cppGenerationStarted;
      timings[2]!.linkMilliseconds = await timedNativeLink(cppCpp, cppExecutable);

      const cppRepeatGenerationStarted = performance.now();
      await runCheckedCommand(cppExecutable, ["cpp", "build", cppEntryFile, "--out", cppRepeat], rootDirectory);
      timings[2]!.repeatGenerationMilliseconds = performance.now() - cppRepeatGenerationStarted;
      timings[2]!.repeatLinkMilliseconds = await timedNativeLink(cppRepeat, cppRepeatExecutable);

      const hash = await compareOutputs(tscCpp, jsCpp, "C++ host generation");
      await compareOutputs(tscCpp, cppCpp, "C++ native self-host generation");
      await compareOutputs(cppCpp, cppRepeat, "C++ repeated self-host generation");
      timings[0]!.result = "byte-identical";
      timings[1]!.result = "byte-identical";
      timings[2]!.result = `byte-identical (${hash})`;
      stages.push({
        name: "VexaScript C++",
        elapsedMilliseconds: performance.now() - cppStarted,
        status: "passed",
        detail: `tsc, JS, and two native generations are byte-identical (${hash})`,
      });
    } catch (error) {
      stages.push({
        name: "VexaScript C++",
        elapsedMilliseconds: performance.now() - cppStarted,
        status: bootstrapReady ? "failed" : "blocked",
        detail: detailForError(error),
      });
      for (const timing of timings) {
        if (timing.result === "not run") timing.result = bootstrapReady ? "failed" : "blocked";
      }
      console.error(`C++ self-host failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await writeGitHubSummary(stages, timings, outputDirectory);
  }

  if (stages.some((stage) => stage.status !== "passed")) {
    throw new Error("Compiler self-hosting did not pass all stages");
  }

  await rm(outputDirectory, { recursive: true, force: true });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
