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
  it("runs the ES2023-ES2025 native runtime additions", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-es2025-runtime-"));
    const sourcePath = join(outputRoot, "es2025.vx");
    const executablePath = join(outputRoot, "es2025");
    try {
      await writeFile(sourcePath, `
const values = [1, 2, 3, 2]
const copied = values.toReversed().toSpliced(1, 1, 9).with(-1, 7)
const grouped = Object.groupBy(values, value => value % 2)
const groupedMap = Map.groupBy(values, value => value % 2)
const set = new Set([1, 2])
const union = set.union(new Set([2, 3]))
const buffer = new ArrayBuffer(2, { maxByteLength: 4 })
buffer.resize(3)
const moved = buffer.transfer()
nativeRunTask(Promise.try(() => { }))
const deferred = Promise.withResolvers<int>()
deferred.resolve(3)
nativeRunTask(deferred.promise)
console.log(
  values.findLast(value => value % 2 == 0),
  values.findLastIndex(value => value == 2),
  copied,
  grouped,
  groupedMap,
  union,
  buffer.byteLength,
  moved.byteLength,
  buffer.maxByteLength,
  RegExp.escape("a.b"),
  "a-b-a".replaceAll("a", "x"),
  "text".isWellFormed(),
  "text".toWellFormed(),
)
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
      expect(result.stdout.trim()).toContain("2 3");
      expect(result.stdout.trim()).toContain("\\x61\\.b");
      expect(result.stdout.trim()).toContain("x-b-x");
      expect(result.stdout.trim()).toContain("0 3 0");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs Float16Array and DataView float16 operations", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-float16-runtime-"));
    const sourcePath = join(outputRoot, "float16.vx");
    const executablePath = join(outputRoot, "float16");
    try {
      await writeFile(sourcePath, `
const values = new Float16Array([1.5, -2.25])
const reversed = values.toReversed()
const sorted = values.toSorted((left, right) => left - right)
const replaced = values.with(-1, 4.5)
const view = new DataView(new ArrayBuffer(2))
view.setFloat16(0, 1.5, true)
console.log(values[0], reversed[0], sorted[0], replaced[1], view.getFloat16(0, true))
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
      expect(result.stdout.trim()).toBe("1.5 -2.25 -2.25 4.5 1.5");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs the Float16Array method surface", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-float16-methods-"));
    const sourcePath = join(outputRoot, "float16-methods.vx");
    const executablePath = join(outputRoot, "float16-methods");
    try {
      await writeFile(sourcePath, `
const values = new Float16Array([1.5, -2, 3])
const mapped = values.map((value, index) => value + index)
const filtered = values.filter(value => value > 0)
const total = values.reduce((left, right) => left + right, 0)
const keys = values.keys().toArray()
values.copyWithin(1, 0, 2)
values.fill(4.5, 0, 1)
console.log(mapped, filtered, total, keys, values.every(value => value > 0), Math.f16round(1.1), values.buffer.byteLength, values.BYTES_PER_ELEMENT)
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
      expect(result.stdout.trim()).toBe("1.5,-1,5 1.5,3 2.5 [0, 1, 2] false 1.099609375 6 2");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs Float16Array static constructors", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-float16-static-"));
    const sourcePath = join(outputRoot, "float16-static.vx");
    const executablePath = join(outputRoot, "float16-static");
    await writeFile(sourcePath, `
const source = [1, 2, 3]
const values = Float16Array.of(1.5, 2.25)
const mapped = Float16Array.from(source, (value, index) => value + index)
console.log(values, mapped)
`);
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
        join(outputRoot, "build"),
        "-O0",
      ]);
      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("1.5,2.25 1,3,5");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs ES2025 iterator helpers", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-iterator-runtime-"));
    const sourcePath = join(outputRoot, "iterator.vx");
    const executablePath = join(outputRoot, "iterator");
    try {
      await writeFile(sourcePath, `
const mapped = Iterator.from([1, 2, 3]).map((value, index) => value + index).filter(value => value > 2).take(2).toArray()
const flattened = Iterator.from([[1, 2], [3]]).flatMap(values => values).toArray()
const total = Iterator.from([1, 2, 3]).reduce((left: int, right: int, index: number) => right, 0)
console.log(mapped, flattened, total)
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
      expect(result.stdout.trim()).toBe("[3, 5] [1, 2, 3] 3");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs Intl.DurationFormat", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-duration-format-"));
    const sourcePath = join(outputRoot, "duration.vx");
    const executablePath = join(outputRoot, "duration");
    try {
      await writeFile(sourcePath, `
const formatter = new Intl.DurationFormat("en", { style: "long" })
const parts = formatter.formatToParts({ seconds: 3 })
const options = formatter.resolvedOptions()
console.log(formatter.format({ hours: 1, minutes: 2 }), parts)
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
      expect(result.stdout.trim()).toContain("1 hour, 2 minutes");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs SharedArrayBuffer growth and RegExp flags", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-shared-buffer-"));
    const sourcePath = join(outputRoot, "shared.vx");
    const executablePath = join(outputRoot, "shared");
    try {
      await writeFile(sourcePath, `
const buffer = new SharedArrayBuffer(2, { maxByteLength: 4 })
buffer.grow(4)
const expression = new RegExp("a", "gimsvd")
console.log(buffer.growable, buffer.maxByteLength, expression.global, expression.unicodeSets, expression.flags)
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
      expect(result.stdout.trim()).toBe("true 4 true true dgimsv");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("runs Atomics.waitAsync", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-atomics-"));
    const sourcePath = join(outputRoot, "atomics.vx");
    const executablePath = join(outputRoot, "atomics");
    try {
      await writeFile(sourcePath, `
const result = Atomics.waitAsync(new Int32Array([0]), 0, 1, 0)
const bigResult = Atomics.waitAsync(new BigInt64Array([0n]), 0, 1n, 0)
console.log(result, bigResult)
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
      expect(result.stdout.trim()).toBe("[object Object] [object Object]");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

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
      expect(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selfVersion.stdout.trim())).toBe(true);

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
