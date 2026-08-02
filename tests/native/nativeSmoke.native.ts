import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  tmpdir,
  vi,
} from "../../compiler/test/expect";
import { runCli } from "../../cli/cli";
import {
  ensureRuntimeDependencies,
  resolveProjectForSource,
} from "../../cli/cliShared";
import { runCommandCapture } from "../../cli/io";

function nativeCliModuleArgs(): string[] {
  return [
    "--import", "tsx",
    "--import", "./scripts/registerTextModuleLoader.cjs",
    "./cli/cli.ts",
  ];
}

describe("native language smoke", () => {
  it("compiles and runs match expressions with value-producing arms", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-match-expression-"));
    const sourcePath = join(outputRoot, "match.vx");
    const executablePath = join(outputRoot, "match");
    try {
      await writeFile(sourcePath, `
fun pick(value: int): string {
  return match {
    when value == 1 -> "one"
    value == 2 -> {
      val label = "two"
      label
    }
    default -> "other"
  }
}

console.log(pick(1), pick(2), pick(3))
`, "utf8");

      await runCli([
        "node",
        "vexa",
        "cpp",
        "link",
        sourcePath,
        "--out",
        executablePath,
        "--build-dir",
        join(outputRoot, "build"),
        "-O0",
      ]);

      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("one two other");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

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
      expect(/Compiling native executable with (?:g\+\+|clang\+\+) -O2:/.test(logs)).toBe(true);
      expect(/native-compile-link [\d.]+ms/.test(logs)).toBe(true);
      expect(logs).toContain(`Reusing cached C++: ${join(buildRoot, "main.cpp")}`);
      expect(logs).toContain(`Reusing cached native executable: ${executablePath}`);
    } finally {
      logSpy.mockRestore();
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("compiles, links, and runs the deterministic native sample matrix", async () => {
    const root = process.cwd();
    const sampleNames = [
      "adler32",
      "binary-buffer-constructors",
      "class-delegate",
      "collections",
      "crc32",
      "defer",
      "delegated-state",
      "json-text-import",
      "map-constructor-call",
      "native-oilpan",
      "sync-orchestration",
      "typescript-import",
      "typed-array-constructor",
      "virtual-dom",
    ];
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-sample-matrix-"));
    const normalizeOutput = (value: string): string => value
      .replace(/\[\s+/g, "[")
      .replace(/\s+\]/g, "]")
      .replace(/,\s+/g, ",");

    try {
      for (const sampleName of sampleNames) {
        const sampleRoot = join(root, "samples", sampleName);
        const executablePath = join(outputRoot, sampleName);
        const link = await runCommandCapture("node", [
          ...nativeCliModuleArgs(),
          "cpp", "link", join(sampleRoot, "main.vx"),
          "--out", executablePath,
          "--build-dir", join(outputRoot, `${sampleName}-build`),
          "-O0",
        ], { cwd: root });
        expect(link.code, `${sampleName} link failed.\n${link.stdout}\n${link.stderr}`).toBe(0);

        const run = await runCommandCapture(executablePath, [], { cwd: outputRoot });
        const expected = await readFile(join(sampleRoot, "expected.txt"), "utf8");
        expect(run.code, `${sampleName} run failed.\n${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stderr).toBe("");
        expect(normalizeOutput(run.stdout.trim())).toBe(normalizeOutput(expected.trim()));
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("compiles, links, and runs the minimal native construct regression fixture", async () => {
    const root = process.cwd();
    const sourcePath = join(root, "testFixtures", "native-constructs-smoke.vx");
    const expectedPath = join(root, "testFixtures", "native-constructs-smoke.expected.txt");
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-constructs-smoke-"));
    const executablePath = join(outputRoot, "smoke");
    try {
      const link = await runCommandCapture("node", [
        ...nativeCliModuleArgs(),
        "cpp", "link", sourcePath,
        "--out", executablePath,
        "--build-dir", join(outputRoot, "build"),
        "-O0",
      ], { cwd: root });
      expect(link.code, `${link.stdout}\n${link.stderr}`).toBe(0);

      const run = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      const expected = await readFile(expectedPath, "utf8");
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout.trim()).toBe(expected.trim());
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("uses the native C++ CLI to produce fixture and Pixi JavaScript bundles", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-cli-bundle-"));
    const nativeCliPath = join(outputRoot, "vexa-native-cli");
    const bundlePath = join(outputRoot, "sample.js");
    const pixiBundlePath = join(outputRoot, "pixi.js");
    const cliBundlePath = join(outputRoot, "cli.js");
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

      const selfExecutablePath = join(outputRoot, "vexa-self-hosted");
      const selfLink = await runCommandCapture(nativeCliPath, [
        "cpp",
        "link",
        join(process.cwd(), "cli", "cli.ts"),
        "--out",
        selfExecutablePath,
        "--build-dir",
        join(outputRoot, "self-build"),
        "-O0",
      ], { cwd: process.cwd() });
      expect(selfLink.code, `${selfLink.stdout}\n${selfLink.stderr}`).toBe(0);
      const selfVersion = await runCommandCapture(selfExecutablePath, ["--version"], { cwd: process.cwd() });
      expect(selfVersion.code).toBe(0);
      expect(selfVersion.stdout.trim()).toBe("0.10.0");

      const ffiSourcePath = join(process.cwd(), "testFixtures", "native-ffi-smoke.vx");
      const ffiCppPath = join(outputRoot, "native-ffi-smoke.cpp");
      const ffiBuild = await runCommandCapture(nativeCliPath, [
        "cpp",
        "build",
        ffiSourcePath,
        "--out",
        ffiCppPath,
      ], { cwd: process.cwd() });
      expect(ffiBuild.code, `${ffiBuild.stdout}\n${ffiBuild.stderr}`).toBe(0);
      const ffiCode = await readFile(ffiCppPath, "utf8");
      expect(ffiCode).toContain("makeManaged<vexa::ArrayBufferObject>(8)");
      expect(ffiCode).toContain("NativePair");

      const ffiExecutablePath = join(outputRoot, "native-ffi-smoke");
      const ffiLink = await runCommandCapture(nativeCliPath, [
        "cpp",
        "link",
        ffiSourcePath,
        "--out",
        ffiExecutablePath,
        "--build-dir",
        join(outputRoot, "ffi-build"),
        "-O0",
      ], { cwd: process.cwd() });
      expect(ffiLink.code, `${ffiLink.stdout}\n${ffiLink.stderr}`).toBe(0);
      const ffiRun = await runCommandCapture(ffiExecutablePath, [], { cwd: outputRoot });
      expect(ffiRun.code, `${ffiRun.stdout}\n${ffiRun.stderr}`).toBe(0);
      expect(ffiRun.stdout.trim()).toBe("7");

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

      const cliBundle = await runCommandCapture(nativeCliPath, [
        "bundle",
        join(process.cwd(), "cli", "cli.ts"),
        "--platform",
        "node",
        "--out",
        cliBundlePath,
      ], { cwd: process.cwd() });
      expect(cliBundle.code, `${cliBundle.stdout}\n${cliBundle.stderr}`).toBe(0);
      const cliCode = await readFile(cliBundlePath, "utf8");
      expect(cliCode).toContain("VexaScript compiler CLI");
      const cliSyntaxCheck = await runCommandCapture(process.execPath, ["--check", cliBundlePath]);
      expect(cliSyntaxCheck.code, cliSyntaxCheck.stderr).toBe(0);

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
