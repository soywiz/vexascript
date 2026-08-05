import { describe, expect, it, join, mkdtemp, readFile, tmpdir, writeFile } from "../compiler/test/expect";
import {
  parseLcovTotals,
  renderCoverageSummary,
  writeCoverageSummary,
} from "./coverageSummary";

const LCOV = [
  "TN:",
  "SF:compiler/first.ts",
  "FNF:4",
  "FNH:3",
  "BRF:6",
  "BRH:4",
  "LF:10",
  "LH:8",
  "end_of_record",
  "TN:",
  "SF:compiler/second.ts",
  "FNF:2",
  "FNH:2",
  "BRF:0",
  "BRH:0",
  "LF:5",
  "LH:5",
  "end_of_record",
].join("\n");

describe("coverage job summary", () => {
  it("aggregates LCOV totals and renders a Codecov commit link", () => {
    const totals = parseLcovTotals(LCOV);
    const summary = renderCoverageSummary(totals, {
      repository: "soywiz/vexascript",
      sha: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(totals).toEqual({
      lines: { hit: 13, found: 15 },
      functions: { hit: 5, found: 6 },
      branches: { hit: 4, found: 6 },
    });
    expect(summary).toContain("## Code coverage");
    expect(summary).toContain("| Lines | 13 | 15 | 86.67% |");
    expect(summary).toContain("| Functions | 5 | 6 | 83.33% |");
    expect(summary).toContain("| Branches | 4 | 6 | 66.67% |");
    expect(summary).toContain(
      "[View commit `0123456` in Codecov](https://app.codecov.io/gh/soywiz/vexascript/commit/0123456789abcdef0123456789abcdef01234567)",
    );
  });

  it("appends the rendered LCOV summary to the GitHub step summary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vexa-coverage-summary-"));
    const coveragePath = join(directory, "lcov.info");
    const summaryPath = join(directory, "summary.md");
    await writeFile(coveragePath, LCOV, "utf8");

    await writeCoverageSummary({
      coveragePath,
      summaryPath,
      repository: "soywiz/vexascript",
      sha: "0123456789abcdef0123456789abcdef01234567",
    });

    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("## Code coverage");
    expect(summary.endsWith("\n")).toBe(true);
  });
});
