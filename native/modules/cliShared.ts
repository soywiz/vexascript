export async function ambientDeclarationsForProject(_sourcePath: string, _project: unknown): Promise<any[]> {
  return [];
}

export async function globalDeclarationsForProject(_project: unknown): Promise<any[]> {
  return [];
}

export async function ensureRuntimeDependencies(_sourcePath: string, _project: unknown): Promise<void> {
}

export async function vexaTypeCheckForSource(
  sourcePath: string,
  project: VexaProject | null,
  semanticCheck: boolean
): Promise<boolean> {
  if (!semanticCheck) return false;
  const lowerPath = sourcePath.toLowerCase();
  if (!lowerPath.endsWith(".ts") && !lowerPath.endsWith(".tsx")) return true;

  const tsconfigPath = project ? resolve(project.projectDir, "tsconfig.json") : "";
  const hasTsconfig = tsconfigPath.length > 0 && await vfs().fileExists(tsconfigPath);
  const args = ["exec", "tsc", "--noEmit", "--pretty", "false"];
  if (hasTsconfig) args.push("--project", tsconfigPath);
  else args.push(sourcePath);
  const result = await runCommandCapture("pnpm", args, {
    cwd: project?.projectDir ?? process.cwd()
  });
  if (result.code !== 0) {
    const diagnostics = [result.stdout.trim(), result.stderr.trim()]
      .filter((output) => output.length > 0)
      .join("\n");
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
): Promise<any> {
  throw new Error("JavaScript bundling is not available in the native VexaScript CLI yet");
}

export async function resolveServeBundleInput(_rootDir: string, _explicitBundleInput?: string): Promise<string> {
  throw new Error("The development server is not available in the native VexaScript CLI yet");
}
import type { VexaProject } from "../../compiler/project";
import { resolve } from "../../compiler/utils/path";
import { vfs } from "../../compiler/vfs";
import { runCommandCapture } from "./cliIo";
