import { spawn, type StdioOptions } from "node:child_process";
import { Buffer } from "node:buffer";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, resolve } from "../compiler/utils/path";
import { vfs } from "../compiler/vfs";
import type { Statement } from "../compiler/ast/ast";
import type { ImportedSymbolResolution } from "../compiler/importedSymbols";
export { fileExists, isDirectory } from "../compiler/utils/fs";

export interface CommandOutput {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CommandCaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function runtimePid(): number {
  return process.pid;
}

export function runAsyncMain(task: Promise<void>): void {
  void task;
}

export function isBootstrappedCliExecution(): boolean {
  return (globalThis as { __vexaCliBootstrappedEntry?: boolean }).__vexaCliBootstrappedEntry === true;
}

export async function isDirectModuleExecution(): Promise<boolean> {
  const entryName = process.argv[1] ? basename(process.argv[1]) : "";
  return entryName === "cli.ts" || entryName === "vexa.js";
}

export async function executeJavaScriptModule(code: string, sourceMap: string | undefined, sourcePath: string): Promise<void> {
  const inlineSourceMap = sourceMap
    ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(sourceMap, "utf8").toString("base64")}`
    : "";
  const jsToExecute = `${code}${inlineSourceMap}\n//# sourceURL=${sourcePath}`;
  const tmpPath = resolve(dirname(sourcePath), `.vexa-run-${runtimePid()}-${Date.now()}.mjs`);
  try {
    await vfs().writeFile(tmpPath, jsToExecute);
    await import(pathToFileURL(tmpPath).href);
  } finally {
    await vfs().unlink(tmpPath).catch(() => undefined);
  }
}

export async function startLanguageServer(): Promise<void> {
  await import("../compiler/lsp/server");
}

export async function runTestFiles(
  paths: string[],
  nodeArgs: string[],
  compile: (source: string, testFile: string, outputFile: string) => Promise<void>
): Promise<string[]> {
  const { discoverVexaScriptTestFiles, prependTestTypeDeclarations } = await import("./testRunner");
  const cwd = process.cwd();
  const roots = paths.length > 0 ? paths : [cwd];
  const discovered = await Promise.all(roots.map((path) => discoverVexaScriptTestFiles(path, cwd)));
  const testFiles = [...new Set(discovered.flat())].sort();
  if (testFiles.length === 0) {
    throw new Error("No .test.vx files found");
  }

  const outputFiles: string[] = [];
  try {
    for (const [index, testFile] of testFiles.entries()) {
      const outputFile = `${testFile}.vexa-test-${process.pid}-${index}.mjs`;
      outputFiles.push(outputFile);
      const source = await vfs().readFile(testFile);
      await compile(prependTestTypeDeclarations(source), testFile, outputFile);
    }

    const nodeEnvironment = { ...process.env };
    delete nodeEnvironment["NODE_TEST_CONTEXT"];
    const result = await runCommandCapture("node", ["--test", ...nodeArgs, ...outputFiles], {
      cwd,
      env: nodeEnvironment
    });
    if (result.stdout.trim().length > 0) console.log(result.stdout.trimEnd());
    if (result.stderr.trim().length > 0) console.error(result.stderr.trimEnd());
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Node test runner exited with code ${result.code}`);
    }
    return testFiles;
  } finally {
    await Promise.all(outputFiles.map((outputFile) => unlink(outputFile).catch(() => undefined)));
  }
}

export async function resolveNodeModuleImportsForCli(
  source: string,
  sourcePath: string,
  ambientGlobalDeclarations: readonly Statement[] = []
): Promise<{
  externalDeclarations: Statement[];
  importedSymbols: Map<string, ImportedSymbolResolution>;
}> {
  const { parseSource } = await import("../compiler/pipeline/parse");
  const parsed = parseSource(source, {});
  if (!parsed.ast) {
    return { externalDeclarations: [], importedSymbols: new Map() };
  }
  const { resolveNodeModuleImportsForRuntime } = await import("../compiler/nodeModuleImportResolution");
  return await resolveNodeModuleImportsForRuntime(
    parsed.ast,
    sourcePath,
    vfs(),
    ambientGlobalDeclarations
  );
}

export async function testRuntimeImportsForCli(source: string): Promise<string> {
  const { testRuntimeImports } = await import("./testRunner");
  return testRuntimeImports(source);
}

export async function tokenizeForCli(source: string): Promise<unknown> {
  const { tokenize } = await import("../compiler/runtime/tooling");
  return tokenize(source);
}

export async function astForCli(source: string): Promise<unknown> {
  const { toAstPreview } = await import("../compiler/runtime/tooling");
  return toAstPreview(source);
}

export async function formatForCli(source: string): Promise<string> {
  const { format } = await import("../compiler/runtime/tooling");
  return format(source);
}

export async function renderSyntaxForCli(target: string): Promise<string> {
  const { renderSyntaxTarget } = await import("../compiler/syntax");
  return renderSyntaxTarget(target as Parameters<typeof renderSyntaxTarget>[0]);
}

export async function startMcpServer(options: unknown): Promise<void> {
  const { runMcpServer } = await import("./mcpServer");
  await runMcpServer(options as Parameters<typeof runMcpServer>[0]);
}

export async function startServe(options: unknown): Promise<number> {
  const { startServeSession } = await import("./cliServe");
  const session = await startServeSession(options as Parameters<typeof startServeSession>[0]);
  return session.port;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: StdioOptions } = {}
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: command.toLowerCase().endsWith(".cmd"),
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

export async function runCommandCapture(
  command: string,
  args: string[],
  options: CommandCaptureOptions = {}
): Promise<CommandOutput> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: command.toLowerCase().endsWith(".cmd"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function spawnDetached(command: string, args: string[], spawnImpl: typeof spawn = spawn): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

export async function openUrlInDefaultBrowser(
  url: string,
  options: {
    browserCommand?: string;
    platform?: NodeJS.Platform;
    spawnImpl?: typeof spawn;
  } = {}
): Promise<void> {
  const browserCommand = options.browserCommand ?? process.env["BROWSER"];
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;

  if (browserCommand) {
    await spawnDetached(browserCommand, [url], spawnImpl);
    return;
  }

  if (platform === "darwin") {
    await spawnDetached("open", [url], spawnImpl);
    return;
  }

  if (platform === "win32") {
    await spawnDetached("cmd", ["/c", "start", "", url], spawnImpl);
    return;
  }

  await spawnDetached("xdg-open", [url], spawnImpl);
}
