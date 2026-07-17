import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
  writeFile,
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

      const result = await runCommandCapture(executablePath, [], { cwd: root });
      const expected = await readFile(expectedPath, "utf8");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(expected.trim());
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("settles a real asynchronous file read on the native event loop", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-async-io-"));
    const sourcePath = join(outputRoot, "main.vx");
    const inputPath = join(outputRoot, "message.txt");
    const executablePath = join(outputRoot, "async-io");
    try {
      await writeFile(inputPath, "native io works\n", "utf8");
      await writeFile(sourcePath, `sync fun load(path: string): string {
  return await readTextFile(path)
}
console.log(await load(${JSON.stringify(inputPath)}))
`, "utf8");
      await runCli(["node", "vexa", "executable", sourcePath, "--out", executablePath]);
      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("native io works\n\n");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("reports an uncaught failure at its VexaScript source location", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-source-location-"));
    const sourcePath = join(outputRoot, "failure.vx");
    const executablePath = join(outputRoot, "failure");
    try {
      await writeFile(sourcePath, `fun explode() {
  throw Error("boom")
}
explode()
`, "utf8");
      await runCli(["node", "vexa", "executable", sourcePath, "--out", executablePath]);
      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Uncaught boom at ${sourcePath}:2:3`);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("matches JavaScript BigInt arithmetic and bitwise semantics", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-bigint-differential-"));
    const sourcePath = join(outputRoot, "bigint.vx");
    const executablePath = join(outputRoot, "bigint");
    const cases = [
      [123456789012345678901234567890n, 9876543210987654321n, 17n],
      [-123456789012345678901234567890n, 9876543210987654321n, 31n],
      [340282366920938463463374607431768211455n, -18446744073709551617n, 65n],
      [-999999999999999999999999999999999999n, -4294967297n, 7n],
    ] as const;
    const literal = (value: bigint): string => value < 0n ? `(${value}n)` : `${value}n`;
    const source = cases.map(([left, right, shift]) => `console.log(
  ${literal(left)} + ${literal(right)},
  ${literal(left)} - ${literal(right)},
  ${literal(left)} * ${literal(right)},
  ${literal(left)} / ${literal(right)},
  ${literal(left)} % ${literal(right)},
  ${literal(left)} & ${literal(right)},
  ${literal(left)} | ${literal(right)},
  ${literal(left)} ^ ${literal(right)},
  ${literal(left)} << ${literal(shift)},
  ${literal(left)} >> ${literal(shift)}
)`).join("\n");
    const expected = cases.map(([left, right, shift]) => [
      left + right,
      left - right,
      left * right,
      left / right,
      left % right,
      left & right,
      left | right,
      left ^ right,
      left << shift,
      left >> shift,
    ].map(String).join(" ")).join("\n") + "\n";
    try {
      await writeFile(sourcePath, source, "utf8");
      await runCli(["node", "vexa", "executable", sourcePath, "--out", executablePath]);
      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(expected);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
