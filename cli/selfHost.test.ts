import { describe, expect, it, mkdtemp, tmpdir, join } from "../compiler/test/expect";
import { runCommandCapture } from "./io";
import { selfHostCompiler } from "./selfHost";

describe("compiler self-hosting", () => {
  it("rebuilds the complete compiler for three byte-stable roundtrips", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "vexa-self-host-"));
    const result = await selfHostCompiler({ outputDir, roundTrips: 3 });

    expect(result.outputPaths.length).toBe(3);
    expect(/^[a-f0-9]{64}$/.test(result.sha256)).toBe(true);

    const execution = await runCommandCapture(process.execPath, [
      result.outputPaths.at(-1)!,
      "bundle",
      join(process.cwd(), "testFixtures", "sample.vx"),
      "--platform",
      "node",
      "--out",
      join(outputDir, "sample.js")
    ], { cwd: outputDir });
    expect(execution.code).toBe(0);

    const sampleExecution = await runCommandCapture(process.execPath, [join(outputDir, "sample.js")], {
      cwd: outputDir
    });
    expect(sampleExecution.code).toBe(0);
    expect(sampleExecution.stdout).toContain("Point { x: 4, y: 6 }");
  });
});
