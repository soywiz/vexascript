import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
} from "../compiler/test/expect";
import { runCli } from "./cli";
import { runCommandCapture } from "./io";

describe("native language smoke", () => {
  it("compiles the complete native sample, runs it, and matches its expected output", async () => {
    const root = process.cwd();
    const sampleRoot = join(root, "samples", "native-language-smoke");
    const sourcePath = join(sampleRoot, "main.vx");
    const expectedPath = join(sampleRoot, "expected.native.txt");
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-language-smoke-"));
    const executablePath = join(outputRoot, "smoke");
    const buildRoot = join(outputRoot, "build");

    try {
      await runCli([
        "node",
        "vexa",
        "executable",
        sourcePath,
        "--out",
        executablePath,
        "--build-dir",
        buildRoot,
      ]);

      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      const expected = await readFile(expectedPath, "utf8");

      expect(
        result.code,
        `Native executable failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(expected.trim());
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
