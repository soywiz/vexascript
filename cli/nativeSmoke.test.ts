import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
  vi,
} from "../compiler/test/expect";
import { runCli } from "./cli";
import {
  ensureRuntimeDependencies,
  resolveProjectForSource,
} from "./cliShared";
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runCli([
        "node",
        "vexa",
        "cpp",
        "link",
        sourcePath,
        "--out",
        executablePath,
        "--build-dir",
        buildRoot,
      ]);

      await runCli([
        "node",
        "vexa",
        "cpp",
        "link",
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
      const logs = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(/Compiled: .*\(project-load [\d.]+ms, declarations [\d.]+ms, load-and-parse [\d.]+ms,/.test(logs)).toBe(true);
      expect(/cpp-emission [\d.]+ms/.test(logs)).toBe(true);
      expect(/type-check [\d.]+ms, write [\d.]+ms, cpp-generation-total [\d.]+ms/.test(logs)).toBe(true);
      expect(/Compiling native executable with g\+\+ -O2:/.test(logs)).toBe(true);
      expect(/native-compile-link [\d.]+ms/.test(logs)).toBe(true);
      expect(logs).toContain(`Reusing cached C++: ${join(buildRoot, "main.cpp")}`);
      expect(logs).toContain(`Reusing cached native executable: ${executablePath}`);
    } finally {
      logSpy.mockRestore();
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("uses the native C++ CLI to produce fixture and Pixi JavaScript bundles", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-cli-bundle-"));
    const nativeCliPath = join(outputRoot, "vexa-native-cli");
    const bundlePath = join(outputRoot, "sample.js");
    const pixiBundlePath = join(outputRoot, "pixi.js");
    const buildRoot = join(outputRoot, "build");
    try {
      await runCli([
        "node",
        "vexa",
        "cpp",
        "link",
        join(process.cwd(), "cli", "cli.ts"),
        "--out",
        nativeCliPath,
        "--build-dir",
        buildRoot,
        "-O0",
      ]);

      const bundle = await runCommandCapture(nativeCliPath, [
        "bundle",
        join(process.cwd(), "testFixtures", "sample.vx"),
        "--platform",
        "node",
        "--out",
        bundlePath,
      ], { cwd: process.cwd() });
      expect(bundle.code, bundle.stdout).toBe(0);
      const executed = await runCommandCapture(process.execPath, [bundlePath], { cwd: outputRoot });
      expect(executed.code).toBe(0);
      expect(executed.stdout).toContain("Point { x: 4, y: 6 }");

      const pixiSourcePath = join(process.cwd(), "samples", "pixi", "html.vx");
      const pixiProject = await resolveProjectForSource(pixiSourcePath);
      await ensureRuntimeDependencies(pixiSourcePath, pixiProject);
      const pixiBundle = await runCommandCapture(nativeCliPath, [
        "bundle",
        pixiSourcePath,
        "--platform",
        "browser",
        "--out",
        pixiBundlePath,
      ], { cwd: process.cwd() });
      expect(pixiBundle.code, `${pixiBundle.stdout}\n${pixiBundle.stderr}`).toBe(0);
      const pixiCode = await readFile(pixiBundlePath, "utf8");
      expect(pixiCode).toContain("pixi-ready");
      expect(pixiCode).toContain("new Graphics()");
      expect(pixiCode).toContain("Container$$position$set");
      expect(/"@pixi\/[^"]+":null/.test(pixiCode)).toBe(false);
      const syntaxCheck = await runCommandCapture(process.execPath, ["--check", pixiBundlePath]);
      expect(syntaxCheck.code, syntaxCheck.stderr).toBe(0);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
