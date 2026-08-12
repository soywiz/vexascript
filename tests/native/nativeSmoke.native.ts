import {
  describe,
  dirname,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  readdir,
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

async function readGeneratedNativeSources(outputPath: string): Promise<string> {
  const directory = dirname(outputPath);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".cpp") || name.endsWith(".hpp"))
    .sort();
  const parts: string[] = [];
  for (const name of names) parts.push(await readFile(join(directory, name), "utf8"));
  return parts.join("\n");
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
    when value == 1: "one"
    value == 2 -> {
      val label = "two"
      label
    }
    default -> "other"
  }
}

type Result =
  | { kind: "ok", value: int }
  | { kind: "error", message: string }

class Box(val value: int)

fun describe(result: Result): string {
  return match (result) {
    { kind: "ok" } -> result.value.toString()
    else -> result.message
  }
}

fun classify(value: any): string {
  return match {
    value is ({ kind: "ok" } and { value }) -> "object"
    value is (["error", 500] or ["error", 503]) -> "array"
    value is "plain" -> "literal"
    value is Box -> "box"
    value is ["open", ..., "close"] -> "variable-array"
    value is { kind: /^ready-/i } -> "nested-regexp"
    value is /^regex-[0-9]+$/i -> "regexp"
    value is /^$/ -> "empty-regexp"
    else -> "other"
  }
}

fun range(value: int): string {
  return match (value) {
    when >= 10 and < 20: "inside"
    else -> "outside"
  }
}

fun typedPattern(value: any): string {
  return match (value) {
    [string, val bound: number, 3] -> "typed:" + bound
    [1, val bound, ...] -> "captured:" + bound
    ["tail", ..., val ending: string] -> "ending:" + ending
    [val box: Box] -> "box:" + box.value
    { kind: val kind: string, value: val amount: number } -> kind + ":" + amount
    string -> "string"
    number -> "number"
    boolean -> "boolean"
    bigint -> "bigint"
    else -> "other"
  }
}

var subjectEvaluations = 0
fun nextSubject(): int {
  subjectEvaluations += 1
  return 15
}

fun updateMatchedSubject(value: int): int {
  match (value) {
    >= 10 -> value = 99
    else -> value = 0
  }
  return value
}

console.log(pick(1), pick(2), pick(3))
console.log(describe({ kind: "ok", value: 7 }), describe({ kind: "error", message: "failed" }))
console.log(classify({ kind: "ok", value: 1 }), classify(["error", 503]), classify("plain"), classify(Box(1)), classify(["open", 1, 2, "close"]), classify({ kind: "READY-now" }), classify("REGEX-42"), classify(""), classify(0), classify(false))
console.log(range(9), range(10), range(19), range(20))
console.log(typedPattern(["test", 2, 3]), typedPattern([1, "value", 9]), typedPattern(["tail", 1, 2, "done"]), typedPattern([Box(8)]), typedPattern({ kind: "object", value: 7 }), typedPattern("text"), typedPattern(4), typedPattern(true), typedPattern(4n), typedPattern({}))
val captured = match (nextSubject()) {
  >= 10 and < 20 -> "captured"
  else -> "missed"
}
console.log(captured, subjectEvaluations, updateMatchedSubject(15), updateMatchedSubject(5))
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
      expect(result.stdout.trim()).toBe([
        "one two other",
        "7 failed",
        "object array literal box variable-array nested-regexp regexp empty-regexp other other",
        "outside inside inside outside",
        "typed:2 captured:value ending:done box:8 object:7 string number boolean bigint other",
        "captured 1 99 0"
      ].join("\n"));
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
        "-O0",
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
        "-O0",
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
      expect(/Compiling native executable with (?:g\+\+|clang\+\+) -O0:/.test(logs)).toBe(true);
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

  it("self-compiles the native C++ CLI", {
    skip: process.env["VEXA_SKIP_NATIVE_COMPILER_CLI"] === "1",
  }, async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-cli-self-compilation-"));
    const nativeCliPath = join(outputRoot, "vexa-native-cli");
    const selfExecutablePath = join(outputRoot, "vexa-self-hosted");
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
      expect(selfVersion.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("uses the native C++ CLI to produce fixture and Pixi JavaScript bundles", {
    skip: process.env["VEXA_SKIP_NATIVE_COMPILER_CLI"] === "1",
  }, async () => {
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
      const ffiCode = await readGeneratedNativeSources(ffiCppPath);
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
