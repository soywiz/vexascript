import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolve } from "../compiler/utils/path";
import { runCommandCapture, type CommandOutput } from "../cli/io";
import {
  compileNativeExecutable,
  prepareNativeBuildDependencies,
  type NativeOptimization,
} from "../cli/nativeBuild";

const SELF_HOST_NATIVE_OPTIMIZATION: NativeOptimization = "-O3";

export type SelfHostStageStatus = "passed" | "failed" | "blocked";

export interface SelfHostCiStage {
  name: string;
  elapsedMilliseconds: number;
  status: SelfHostStageStatus;
  detail: string;
}

export interface SelfHostCiTiming {
  host: string;
  optimization: string;
  generationMilliseconds: number | null;
  repeatGenerationMilliseconds: number | null;
  result: string;
}

export interface CppSelfHostHashes {
  bootstrapHash: string;
  nativeHash: string;
}

interface TimedCommand extends CommandOutput {
  elapsedMilliseconds: number;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)} s`;
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
    formatSeconds(stage.elapsedMilliseconds),
    stage.status,
    stage.detail,
  ]);
  const timingRows = timings.map((timing) => [
    timing.host,
    timing.optimization,
    timing.generationMilliseconds === null ? "—" : formatSeconds(timing.generationMilliseconds),
    timing.repeatGenerationMilliseconds === null ? "—" : formatSeconds(timing.repeatGenerationMilliseconds),
    timing.result,
  ]);

  return [
    "## Compiler self-hosting",
    "",
    `Status: **${status}** on \`${runner}\`.`,
    "",
    "### C++ generation timing",
    "",
    "| Host | Runtime / optimization | Generation 1 | Generation 2 | Result |",
    "| --- | --- | ---: | ---: | --- |",
    ...timingRows.map((row) => `| ${row.map(summaryCell).join(" | ")} |`),
    "",
    "Only `vexa cpp build` is timed. Native dependency setup and C++ compilation/linking run separately and are excluded from generation values.",
    "",
    "### Stage status",
    "",
    "Stage wall times include validation and unreported native compilation/linking; use the generation table for compiler comparisons.",
    "",
    "| Stage | Wall time | Status | Result |",
    "| --- | ---: | --- | --- |",
    ...rows.map((row) => `| ${row.map(summaryCell).join(" | ")} |`),
    "",
    `Generated files are kept in \`${outputDirectory}\` while this job is running.`,
  ].join("\n");
}

function commandFailure(command: string, args: readonly string[], result: CommandOutput): Error {
  const output = [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n");
  const termination = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`;
  return new Error([
    `Command failed with ${termination}: ${command} ${args.join(" ")}`,
    output,
  ].filter((line) => line.length > 0).join("\n"));
}

async function timedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<TimedCommand> {
  const started = performance.now();
  const result = await runCommandCapture(command, [...args], {
    cwd,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
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

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyCppSelfHostContents(
  tscOutput: string,
  javascriptOutput: string,
  firstNativeOutput: string,
  secondNativeOutput: string,
): CppSelfHostHashes {
  if (tscOutput !== javascriptOutput) {
    throw new Error("TypeScript and JavaScript host C++ outputs are not byte-identical");
  }
  if (firstNativeOutput !== secondNativeOutput) {
    throw new Error("consecutive native C++ outputs are not byte-identical");
  }
  return {
    bootstrapHash: contentHash(tscOutput),
    nativeHash: contentHash(firstNativeOutput),
  };
}

async function verifyCppSelfHostOutputs(
  tscDirectory: string,
  javascriptDirectory: string,
  firstNativeDirectory: string,
  secondNativeDirectory: string,
): Promise<CppSelfHostHashes> {
  const outputs = await Promise.all([
    serializedCppOutput(tscDirectory),
    serializedCppOutput(javascriptDirectory),
    serializedCppOutput(firstNativeDirectory),
    serializedCppOutput(secondNativeDirectory),
  ]);
  return verifyCppSelfHostContents(outputs[0], outputs[1], outputs[2], outputs[3]);
}

async function generatedCppPaths(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.endsWith(".cpp"))
    .sort()
    .map((name) => join(directory, name));
}

async function serializedCppOutput(directory: string): Promise<string> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".cpp") || name.endsWith(".hpp"))
    .sort();
  const contents = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
  return JSON.stringify(names.map((name, index) => [name, contents[index]]));
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
    { host: "tsc", optimization: "Node.js / V8 JIT", generationMilliseconds: null, repeatGenerationMilliseconds: null, result: "not run" },
    { host: "VexaScript JS", optimization: "Node.js / V8 JIT", generationMilliseconds: null, repeatGenerationMilliseconds: null, result: "not run" },
    { host: "VexaScript C++", optimization: `g++ ${SELF_HOST_NATIVE_OPTIMIZATION}`, generationMilliseconds: null, repeatGenerationMilliseconds: null, result: "not run" },
  ];
  let bootstrapReady = false;
  let javascriptReady = false;
  let nativeDependenciesReady = false;

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
      javascriptReady = true;
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

    const nativeSetupStarted = performance.now();
    try {
      await prepareNativeBuildDependencies();
      nativeDependenciesReady = true;
      stages.push({
        name: "Native dependencies",
        elapsedMilliseconds: performance.now() - nativeSetupStarted,
        status: "passed",
        detail: "Oilpan and mimalloc prepared outside measured C++ generation intervals",
      });
    } catch (error) {
      stages.push({
        name: "Native dependencies",
        elapsedMilliseconds: performance.now() - nativeSetupStarted,
        status: "failed",
        detail: detailForError(error),
      });
      console.error(`Native dependency setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const cppStarted = performance.now();
    try {
      if (!bootstrapReady) throw new Error("blocked by compiler bootstrap");
      if (!javascriptReady) throw new Error("blocked by JavaScript self-host");
      if (!nativeDependenciesReady) throw new Error("blocked by native dependency setup");
      const tscBuildDirectory = join(outputDirectory, "cpp-build-tsc");
      const jsBuildDirectory = join(outputDirectory, "cpp-build-js");
      const cppBuildDirectory = join(outputDirectory, "cpp-build-cpp");
      const cppRepeatBuildDirectory = join(outputDirectory, "cpp-build-cpp-repeat");
      const tscCpp = join(tscBuildDirectory, "main.cpp");
      const jsCpp = join(jsBuildDirectory, "main.cpp");
      const cppCpp = join(cppBuildDirectory, "main.cpp");
      const cppRepeat = join(cppRepeatBuildDirectory, "main.cpp");
      const jsExecutable = join(outputDirectory, "vexa-js-host");
      const cppExecutable = join(outputDirectory, "vexa-cpp-host");

      const tscGenerationStarted = performance.now();
      await runCheckedCommand("node", compiledCliCommand(compiledCli, tsxLoader, textModuleLoader, ["cpp", "build", cppEntryFile, "--out", tscCpp]), tscDirectory);
      timings[0]!.generationMilliseconds = performance.now() - tscGenerationStarted;

      const jsGenerationStarted = performance.now();
      await runCheckedCommand("node", [join(outputDirectory, "vexa-self-host-2.js"), "cpp", "build", cppEntryFile, "--out", jsCpp], outputDirectory);
      timings[1]!.generationMilliseconds = performance.now() - jsGenerationStarted;
      const jsNativeBuild = await compileNativeExecutable(
        await generatedCppPaths(jsBuildDirectory),
        jsExecutable,
        [],
        SELF_HOST_NATIVE_OPTIMIZATION
      );
      timings[2]!.optimization = `${jsNativeBuild.compiler} ${SELF_HOST_NATIVE_OPTIMIZATION}${jsNativeBuild.fallbackFromGcc ? " (g++ ICE fallback)" : ""}`;

      const cppGenerationStarted = performance.now();
      await runCheckedCommand(jsExecutable, ["cpp", "build", cppEntryFile, "--out", cppCpp], rootDirectory);
      timings[2]!.generationMilliseconds = performance.now() - cppGenerationStarted;
      await compileNativeExecutable(
        await generatedCppPaths(cppBuildDirectory),
        cppExecutable,
        [],
        SELF_HOST_NATIVE_OPTIMIZATION
      );

      const cppRepeatGenerationStarted = performance.now();
      await runCheckedCommand(cppExecutable, ["cpp", "build", cppEntryFile, "--out", cppRepeat], rootDirectory);
      timings[2]!.repeatGenerationMilliseconds = performance.now() - cppRepeatGenerationStarted;

      const hashes = await verifyCppSelfHostOutputs(
        tscBuildDirectory,
        jsBuildDirectory,
        cppBuildDirectory,
        cppRepeatBuildDirectory
      );
      timings[0]!.result = `matches VexaScript JS (${hashes.bootstrapHash})`;
      timings[1]!.result = `matches tsc (${hashes.bootstrapHash})`;
      timings[2]!.result = `native fixed point (${hashes.nativeHash})`;
      stages.push({
        name: "VexaScript C++",
        elapsedMilliseconds: performance.now() - cppStarted,
        status: "passed",
        detail: `tsc and JS bootstrap outputs match (${hashes.bootstrapHash}); consecutive native outputs match (${hashes.nativeHash})`,
      });
    } catch (error) {
      stages.push({
        name: "VexaScript C++",
        elapsedMilliseconds: performance.now() - cppStarted,
        status: bootstrapReady && javascriptReady && nativeDependenciesReady ? "failed" : "blocked",
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
