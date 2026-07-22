import { spawn, type StdioOptions } from "node:child_process";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { basename, dirname, resolve } from "../compiler/utils/path";
import { vfs } from "../compiler/vfs";
export { fileExists, isDirectory } from "../compiler/utils/fs";

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runtimePlatform(): string {
  return process.platform;
}

export function environmentVariable(name: string): string | undefined {
  return process.env[name];
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

export interface NativeProgramPaths {
  sourcePath: string;
  buildRoot: string;
  cppPath: string;
  executablePath: string;
}

export async function resolveNativeProgramPaths(
  sourcePath: string,
  outputPath?: string,
  buildDir?: string
): Promise<NativeProgramPaths> {
  const { nativeProgramPaths } = await import("./nativeBuild");
  return nativeProgramPaths(sourcePath, outputPath, buildDir);
}

export async function linkNativeExecutable(cppPath: string, executablePath: string, extraFlags: string[] = []): Promise<void> {
  const { compileNativeExecutable } = await import("./nativeBuild");
  await compileNativeExecutable(cppPath, executablePath, extraFlags);
}

export async function runTestFiles(
  paths: string[],
  execute: (source: string, testFile: string) => Promise<void>
): Promise<string[]> {
  const { runVexaScriptTests } = await import("./testRunner");
  const result = await runVexaScriptTests(paths, execute);
  return result.testFiles;
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
  options: { cwd?: string } = {}
): Promise<CommandOutput> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
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
