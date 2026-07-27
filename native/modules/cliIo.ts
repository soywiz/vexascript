import {
  compileNativeExecutable,
  resolveNativeProgramPaths as resolveNativeProgramPathsImpl,
  type NativeOptimization,
  type NativeProgramPaths,
} from "./nativeBuild";

export type { NativeProgramPaths } from "./nativeBuild";

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runtimePlatform(): string {
  return "native";
}

export function environmentVariable(_name: string): string | undefined {
  return nativeEnvironmentVariable(_name);
}

export function runtimePid(): number {
  return 0;
}

export function runAsyncMain(task: Promise<void>): void {
  nativeRunTask(task);
}

export function isBootstrappedCliExecution(): boolean {
  return false;
}

export async function isDirectModuleExecution(): Promise<boolean> {
  return true;
}

export async function executeJavaScriptModule(_code: string, _sourceMap: string | undefined, _sourcePath: string): Promise<void> {
  throw new Error("Executing JavaScript modules is not available in the native VexaScript CLI");
}

export async function startLanguageServer(): Promise<void> {
  throw new Error("The language server is not available in the native VexaScript CLI");
}

export async function resolveNativeProgramPaths(sourcePath: string, outputPath?: string, buildDir?: string): Promise<NativeProgramPaths> {
  return resolveNativeProgramPathsImpl(sourcePath, outputPath, buildDir);
}

export async function linkNativeExecutable(
  cppPath: string,
  executablePath: string,
  extraFlags: string[] = [],
  optimization?: NativeOptimization
): Promise<void> {
  await compileNativeExecutable(cppPath, executablePath, extraFlags, optimization ?? "-O2");
}

export async function runTestFiles(
  _paths: string[],
  _nodeArgs: string[],
  _compile: (source: string, testFile: string, outputFile: string) => Promise<void>
): Promise<string[]> {
  throw new Error("The test runner is not available in the native VexaScript CLI");
}

export async function tokenizeForCli(_source: string): Promise<unknown> {
  throw new Error("Token inspection is not available in the native VexaScript CLI");
}

export async function astForCli(_source: string): Promise<unknown> {
  throw new Error("AST inspection is not available in the native VexaScript CLI");
}

export async function formatForCli(_source: string): Promise<string> {
  throw new Error("Formatting is not available in the native VexaScript CLI");
}

export async function renderSyntaxForCli(_target: string): Promise<string> {
  throw new Error("Syntax generation is not available in the native VexaScript CLI");
}

export async function startMcpServer(_options: unknown): Promise<void> {
  throw new Error("The MCP server is not available in the native VexaScript CLI");
}

export async function startServe(_options: unknown): Promise<number> {
  throw new Error("The development server is not available in the native VexaScript CLI");
}

export async function runCommand(command: string, args: string[], options?: any): Promise<void> {
  const result = await runCommandCapture(command, args, options);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed with exit code ${result.code}`);
  }
}

export async function runCommandCapture(command: string, args: string[], options?: any): Promise<CommandOutput> {
  const result = await nativeRunCommandCapture(command, args, options?.cwd ?? process.cwd());
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function openUrlInDefaultBrowser(_url: string, _options?: unknown): Promise<void> {
  throw new Error("Opening a browser is not available in the native VexaScript CLI yet");
}
