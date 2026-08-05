import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface CoverageMetric {
  hit: number;
  found: number;
}

export interface CoverageTotals {
  lines: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export interface CoverageSummaryOptions {
  coveragePath: string;
  summaryPath: string;
  repository: string;
  sha: string;
}

export function parseLcovTotals(content: string): CoverageTotals {
  const totals: CoverageTotals = {
    lines: { hit: 0, found: 0 },
    functions: { hit: 0, found: 0 },
    branches: { hit: 0, found: 0 },
  };

  for (const line of content.split("\n")) {
    const match = /^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    switch (match[1]) {
      case "LF": totals.lines.found += value; break;
      case "LH": totals.lines.hit += value; break;
      case "FNF": totals.functions.found += value; break;
      case "FNH": totals.functions.hit += value; break;
      case "BRF": totals.branches.found += value; break;
      case "BRH": totals.branches.hit += value; break;
    }
  }

  if (totals.lines.found === 0 && totals.functions.found === 0 && totals.branches.found === 0) {
    throw new Error("LCOV report contains no coverage totals");
  }
  return totals;
}

function formatPercentage(metric: CoverageMetric): string {
  return metric.found === 0 ? "n/a" : `${((metric.hit / metric.found) * 100).toFixed(2)}%`;
}

export function renderCoverageSummary(
  totals: CoverageTotals,
  commit: { repository: string; sha: string },
): string {
  const repositoryParts = commit.repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part.length === 0)) {
    throw new Error(`Invalid GitHub repository: ${commit.repository}`);
  }
  const repositoryPath = repositoryParts.map(encodeURIComponent).join("/");
  const sha = encodeURIComponent(commit.sha);
  const codecovUrl = `https://app.codecov.io/gh/${repositoryPath}/commit/${sha}`;
  const rows: Array<[string, CoverageMetric]> = [
    ["Lines", totals.lines],
    ["Functions", totals.functions],
    ["Branches", totals.branches],
  ];

  return [
    "## Code coverage",
    "",
    "| Metric | Covered | Total | Coverage |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(([name, metric]) => `| ${name} | ${metric.hit} | ${metric.found} | ${formatPercentage(metric)} |`),
    "",
    `[View commit \`${commit.sha.slice(0, 7)}\` in Codecov](${codecovUrl})`,
  ].join("\n");
}

export async function writeCoverageSummary(options: CoverageSummaryOptions): Promise<void> {
  const coverage = await readFile(options.coveragePath, "utf8");
  const summary = renderCoverageSummary(parseLcovTotals(coverage), options);
  await appendFile(options.summaryPath, `${summary}\n`, "utf8");
}

async function main(): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!summaryPath || !repository || !sha) {
    throw new Error("GITHUB_STEP_SUMMARY, GITHUB_REPOSITORY, and GITHUB_SHA are required");
  }

  await writeCoverageSummary({
    coveragePath: resolve(process.cwd(), process.argv[2] ?? "lcov.info"),
    summaryPath,
    repository,
    sha,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
