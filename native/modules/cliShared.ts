import type { VexaProject } from "../../compiler/project";
import type { BundledModuleArtifacts } from "../../cli/model";
import { resolve } from "../../compiler/utils/path";
import { vfs } from "../../compiler/vfs";
import { environmentVariable, runCommandCapture } from "./cliIo";

function typeScriptBuildInfoPath(sourcePath: string): string {
  const temporaryDirectory = environmentVariable("TMPDIR") ?? environmentVariable("TEMP") ?? "/tmp";
  const cacheName = sourcePath.replace(/[^A-Za-z0-9_-]+/g, "_");
  return resolve(temporaryDirectory, `vexa-typescript-${cacheName}.tsbuildinfo`);
}

export async function ambientDeclarationsForProject(_sourcePath: string, _project: unknown): Promise<any[]> {
  return [];
}

export async function globalDeclarationsForProject(_project: unknown): Promise<any[]> {
  return [];
}

export async function ensureRuntimeDependencies(_sourcePath: string, _project: unknown): Promise<void> {
}

export function isTypeScriptSource(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx");
}

export function usesExternalTypeScriptCheck(sourcePath: string, semanticCheck: boolean): boolean {
  return semanticCheck && isTypeScriptSource(sourcePath);
}

export async function vexaTypeCheckForSource(
  sourcePath: string,
  project: VexaProject | null,
  semanticCheck: boolean
): Promise<boolean> {
  if (!usesExternalTypeScriptCheck(sourcePath, semanticCheck)) return semanticCheck;

  const tsconfigPath = project ? resolve(project.projectDir, "tsconfig.json") : "";
  const hasTsconfig = tsconfigPath.length > 0 && await vfs().fileExists(tsconfigPath);
  const typeScriptArgs = [
    "--noEmit",
    "--pretty",
    "false",
    "--incremental",
    "--tsBuildInfoFile",
    typeScriptBuildInfoPath(sourcePath)
  ];
  if (hasTsconfig) typeScriptArgs.push("--project", tsconfigPath);
  else typeScriptArgs.push(sourcePath);
  const workingDirectory = project?.projectDir ?? process.cwd();
  const localTypeScriptCli = resolve(workingDirectory, "node_modules/typescript/bin/tsc");
  const hasLocalTypeScript = await vfs().fileExists(localTypeScriptCli);
  const result = await runCommandCapture(hasLocalTypeScript ? "node" : "pnpm", hasLocalTypeScript
    ? [localTypeScriptCli, ...typeScriptArgs]
    : ["exec", "tsc", ...typeScriptArgs], {
    cwd: workingDirectory
  });
  if (result.code !== 0) {
    const diagnostics = result.stdout.length > 0 ? result.stdout : result.stderr;
    throw new Error(diagnostics.length > 0
      ? `TypeScript semantic analysis failed:\n${diagnostics}`
      : "TypeScript semantic analysis failed");
  }
  return false;
}

export async function createBundledModuleArtifacts(
  _sourcePath: string,
  _target: unknown,
  _project: unknown,
  _jsxOptions: unknown,
  _options?: unknown
): Promise<BundledModuleArtifacts> {
  throw new Error("JavaScript bundling is not available in the native VexaScript CLI yet");
}

export async function resolveServeBundleInput(_rootDir: string, _explicitBundleInput?: string): Promise<string> {
  throw new Error("The development server is not available in the native VexaScript CLI yet");
}
