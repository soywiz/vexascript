import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli";
import { runCommandCapture } from "./io";

export const NATIVE_BENCHMARK_SOURCE = `val arrayStart = performance.now()
val values: int[] = [0]
for (index of 1 ..< 100000) values.push(index)
var arrayTotal: number = 0
values.forEach((value: int) => { arrayTotal += value })
console.log("array_ms", performance.now() - arrayStart, arrayTotal)

val bigintStart = performance.now()
var bigintValue = 123456789012345678901234567890n
for (index of 0 ..< 250) {
  bigintValue = (bigintValue * 33n + 17n) / 3n
}
console.log("bigint_ms", performance.now() - bigintStart, bigintValue > 0n)

val eventLoopStart = performance.now()
var completedTimers = 0
for (index of 0 ..< 250) {
  setTimeout(() => { completedTimers += 1 }, 0)
}
setTimeout(() => console.log("event_loop_ms", performance.now() - eventLoopStart, completedTimers), 0)
`;

export interface NativeBenchmarkResult {
  platform: string;
  architecture: string;
  compileMilliseconds: number;
  binaryBytes: number;
  startupMedianMilliseconds: number;
  workloadMedianMilliseconds: number;
  gcStressMilliseconds: number;
  arrayMilliseconds: number;
  bigintMilliseconds: number;
  eventLoopMilliseconds: number;
  nodeStartupMedianMilliseconds: number;
  nodeWorkloadMedianMilliseconds: number;
  nodeArrayMilliseconds: number;
  nodeBigintMilliseconds: number;
  nodeEventLoopMilliseconds: number;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function parseWorkloadMetrics(output: string): Pick<NativeBenchmarkResult,
  "arrayMilliseconds" | "bigintMilliseconds" | "eventLoopMilliseconds"> {
  const metrics = new Map(output.trim().split("\n").map((line) => {
    const [name, value] = line.split(" ");
    return [name!, Number(value)] as const;
  }));
  return {
    arrayMilliseconds: metrics.get("array_ms") ?? Number.NaN,
    bigintMilliseconds: metrics.get("bigint_ms") ?? Number.NaN,
    eventLoopMilliseconds: metrics.get("event_loop_ms") ?? Number.NaN,
  };
}

async function timedExecution(command: string, args: string[] = []): Promise<{ milliseconds: number; stdout: string }> {
  const started = performance.now();
  const result = await runCommandCapture(command, args);
  const milliseconds = performance.now() - started;
  if (result.code !== 0) throw new Error(result.stderr || `Benchmark command '${command}' exited with ${result.code}`);
  return { milliseconds, stdout: result.stdout };
}

async function compile(sourcePath: string, executablePath: string, buildRoot: string): Promise<number> {
  const started = performance.now();
  await runCli(["node", "vexa", "executable", sourcePath, "--out", executablePath, "--build-dir", buildRoot]);
  return performance.now() - started;
}

export async function runNativeBenchmark(): Promise<NativeBenchmarkResult> {
  const root = await mkdtemp(join(tmpdir(), "vexa-native-benchmark-"));
  try {
    const sourcePath = join(root, "workload.vx");
    const executablePath = join(root, "workload");
    const javaScriptPath = join(root, "workload.js");
    await writeFile(sourcePath, NATIVE_BENCHMARK_SOURCE, "utf8");
    const compileMilliseconds = await compile(sourcePath, executablePath, join(root, "build"));
    await runCli(["node", "vexa", "build", sourcePath, "--out", javaScriptPath, "--transpile-only"]);
    const binaryBytes = (await stat(executablePath)).size;

    const workloadRuns = [];
    let workloadOutput = "";
    for (let index = 0; index < 5; index += 1) {
      const run = await timedExecution(executablePath);
      workloadRuns.push(run.milliseconds);
      workloadOutput = run.stdout;
    }
    const nodeWorkloadRuns = [];
    let nodeWorkloadOutput = "";
    for (let index = 0; index < 5; index += 1) {
      const run = await timedExecution(process.execPath, [javaScriptPath]);
      nodeWorkloadRuns.push(run.milliseconds);
      nodeWorkloadOutput = run.stdout;
    }

    const emptySourcePath = join(root, "empty.vx");
    const emptyExecutablePath = join(root, "empty");
    const emptyJavaScriptPath = join(root, "empty.js");
    await writeFile(emptySourcePath, "", "utf8");
    await compile(emptySourcePath, emptyExecutablePath, join(root, "empty-build"));
    await runCli(["node", "vexa", "build", emptySourcePath, "--out", emptyJavaScriptPath, "--transpile-only"]);
    const startupRuns = [];
    const nodeStartupRuns = [];
    for (let index = 0; index < 9; index += 1) {
      startupRuns.push((await timedExecution(emptyExecutablePath)).milliseconds);
      nodeStartupRuns.push((await timedExecution(process.execPath, [emptyJavaScriptPath])).milliseconds);
    }

    const previousStress = process.env["VEXA_NATIVE_GC_STRESS"];
    process.env["VEXA_NATIVE_GC_STRESS"] = "1";
    const stressExecutablePath = join(root, "workload-stress");
    try {
      await compile(sourcePath, stressExecutablePath, join(root, "stress-build"));
    } finally {
      if (previousStress === undefined) delete process.env["VEXA_NATIVE_GC_STRESS"];
      else process.env["VEXA_NATIVE_GC_STRESS"] = previousStress;
    }
    const gcStressMilliseconds = (await timedExecution(stressExecutablePath)).milliseconds;

    const nodeMetrics = parseWorkloadMetrics(nodeWorkloadOutput);
    return {
      platform: process.platform,
      architecture: process.arch,
      compileMilliseconds,
      binaryBytes,
      startupMedianMilliseconds: median(startupRuns),
      workloadMedianMilliseconds: median(workloadRuns),
      gcStressMilliseconds,
      ...parseWorkloadMetrics(workloadOutput),
      nodeStartupMedianMilliseconds: median(nodeStartupRuns),
      nodeWorkloadMedianMilliseconds: median(nodeWorkloadRuns),
      nodeArrayMilliseconds: nodeMetrics.arrayMilliseconds,
      nodeBigintMilliseconds: nodeMetrics.bigintMilliseconds,
      nodeEventLoopMilliseconds: nodeMetrics.eventLoopMilliseconds,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function formatNativeBenchmarkMarkdown(result: NativeBenchmarkResult): string {
  const rows = [
    ["Compile", result.compileMilliseconds, "ms"],
    ["Binary size", result.binaryBytes, "bytes"],
    ["Startup median", result.startupMedianMilliseconds, "ms"],
    ["Workload median", result.workloadMedianMilliseconds, "ms"],
    ["GC-stress workload", result.gcStressMilliseconds, "ms"],
    ["Array workload", result.arrayMilliseconds, "ms"],
    ["Bigint workload", result.bigintMilliseconds, "ms"],
    ["Event-loop workload", result.eventLoopMilliseconds, "ms"],
    ["Node startup median", result.nodeStartupMedianMilliseconds, "ms"],
    ["Node workload median", result.nodeWorkloadMedianMilliseconds, "ms"],
    ["Node array workload", result.nodeArrayMilliseconds, "ms"],
    ["Node bigint workload", result.nodeBigintMilliseconds, "ms"],
    ["Node event-loop workload", result.nodeEventLoopMilliseconds, "ms"],
    ["Native workload speedup", result.nodeWorkloadMedianMilliseconds / Math.max(result.workloadMedianMilliseconds, Number.EPSILON), "x"],
  ];
  return [
    `Platform: ${result.platform}/${result.architecture}`,
    "",
    "| Metric | Value | Unit |",
    "| --- | ---: | --- |",
    ...rows.map(([name, value, unit]) => `| ${name} | ${Number(value).toFixed(2)} | ${unit} |`),
  ].join("\n");
}
