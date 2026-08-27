import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selfHostCompiler } from "../cli/selfHost";

export interface SelfHostCiStage {
  name: string;
  elapsedMilliseconds: number;
  status: "passed" | "failed";
  detail: string;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(2) + " s";
}

function summaryCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderSelfHostSummary(
  stages: readonly SelfHostCiStage[],
  runner: string,
  outputDirectory: string,
): string {
  const passed = stages.every((stage) => stage.status === "passed");
  return [
    "## VexaScript JavaScript self-hosting",
    "",
    "Status: **" + (passed ? "passed" : "failed") + "** on " + runner + ".",
    "",
    "| Stage | Wall time | Status | Result |",
    "| --- | ---: | --- | --- |",
    ...stages.map((stage) =>
      "| " + summaryCell(stage.name) + " | " + seconds(stage.elapsedMilliseconds) +
      " | " + stage.status + " | " + summaryCell(stage.detail) + " |"
    ),
    "",
    "Generated files are kept in " + outputDirectory + " while this job is running.",
  ].join("\n");
}

async function writeGitHubSummary(stages: readonly SelfHostCiStage[], outputDirectory: string): Promise<void> {
  const summary = renderSelfHostSummary(
    stages,
    process.env["RUNNER_OS"] ?? "local",
    outputDirectory,
  );
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (!summaryPath) {
    console.log(summary);
    return;
  }
  await appendFile(summaryPath, summary + "\n");
}

async function main(): Promise<void> {
  const outputDirectory = await mkdtemp(join(resolve(process.cwd(), "node_modules"), ".vexa-self-host-ci-"));
  const stages: SelfHostCiStage[] = [];
  let failure: unknown;

  const startedAt = performance.now();
  try {
    const result = await selfHostCompiler({ outputDir: outputDirectory, roundTrips: 2 });
    stages.push({
      name: "VexaScript JavaScript",
      elapsedMilliseconds: performance.now() - startedAt,
      status: "passed",
      detail: "two generations are byte-identical (" + result.sha256 + ")",
    });
  } catch (error) {
    failure = error;
    stages.push({
      name: "VexaScript JavaScript",
      elapsedMilliseconds: performance.now() - startedAt,
      status: "failed",
      detail: error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error),
    });
  }

  await writeGitHubSummary(stages, outputDirectory);
  await rm(outputDirectory, { recursive: true, force: true });
  if (failure) throw failure;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
