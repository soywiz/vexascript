import type { TranspileDiagnostic, TranspileTarget } from "./runtime/transpile";
import { dirname, resolve } from "./utils/path";
import { loadProject, type VexaProject } from "./project";
import { ensureDependencies } from "./deps";
import { vfs } from "./vfs";

export async function ambientDeclarationsForProject(project: VexaProject | null) {
  const requested = new Set((project?.libs ?? []).map((lib) => lib.toLowerCase()));
  if (!requested.has("dom")) {
    return [];
  }

  const { ensureDomProgram } = await import("./runtime/domDeclarations");
  return (await ensureDomProgram()).body;
}

export async function ensureCompilerRuntimePrograms(): Promise<void> {
  const {
    ensureEcmaScriptRuntimeProgram,
    ensureVexaScriptRuntimeProgram
  } = await import("./runtime/ecmascriptDeclarations");
  await Promise.all([
    ensureEcmaScriptRuntimeProgram(),
    ensureVexaScriptRuntimeProgram()
  ]);
}

async function loadPackageJsonDeps(dir: string): Promise<Record<string, string> | null> {
  const pkgPath = resolve(dir, "package.json");
  try {
    const raw = (await vfs().readFile(pkgPath))!;
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return parsed.dependencies ?? null;
  } catch {
    return null;
  }
}

export async function ensureRuntimeDependencies(sourcePath: string, project: VexaProject | null): Promise<void> {
  if (project && Object.keys(project.dependencies).length > 0) {
    await ensureDependencies(project.projectDir, project.dependencies);
    return;
  }

  const sourceDir = dirname(sourcePath);
  const pkgDeps = await loadPackageJsonDeps(sourceDir);
  if (pkgDeps && Object.keys(pkgDeps).length > 0) {
    await ensureDependencies(sourceDir, pkgDeps);
  }
}

export interface BundledModuleArtifacts {
  code: string;
  warnings: string[];
  errors: string[];
  diagnostics: TranspileDiagnostic[];
  watchedFiles: string[];
}

export async function createBundledModuleArtifacts(
  sourcePath: string,
  target: TranspileTarget,
  project: VexaProject | null,
  jsxOptions: { jsxFactory?: string; jsxFragmentFactory?: string } = {},
  options: { externalDependencyStrategy?: "runtime-error" | "node-require" } = {}
): Promise<BundledModuleArtifacts> {
  const ambientDeclarations = await ambientDeclarationsForProject(project);
  const { bundleModuleGraphAsModules } = await import("./runtime/moduleGraph");
  const result = await bundleModuleGraphAsModules(sourcePath, target, {
    ambientDeclarations,
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {}),
    ...(jsxOptions.jsxFactory ? { jsxFactory: jsxOptions.jsxFactory } : {}),
    ...(jsxOptions.jsxFragmentFactory ? { jsxFragmentFactory: jsxOptions.jsxFragmentFactory } : {})
  });
  if (result.errors.length > 0) {
    return {
      code: "",
      warnings: result.warnings,
      errors: result.errors,
      diagnostics: result.diagnostics,
      watchedFiles: result.watchedFiles
    };
  }

  const { bundleNodeModuleGraph } = await import("./runtime/nodeModuleBundle");
  const bundled = await bundleNodeModuleGraph(result.entrySource, sourcePath, {
    virtualSources: result.moduleSources,
    externalDependencyStrategy: options.externalDependencyStrategy ?? "runtime-error"
  });
  return {
    code: bundled.code,
    warnings: result.warnings,
    errors: result.errors,
    diagnostics: result.diagnostics,
    watchedFiles: [...new Set([...result.watchedFiles, ...bundled.watchedFiles])]
  };
}

export async function resolveProjectForSource(sourcePath: string): Promise<VexaProject | null> {
  return await loadProject(sourcePath);
}

export async function resolveServeBundleInput(rootDir: string, explicitBundleInput?: string): Promise<string> {
  if (explicitBundleInput) {
    return resolve(process.cwd(), explicitBundleInput);
  }

  const resolvedRootDir = resolve(process.cwd(), rootDir);
  const project = await loadProject(resolvedRootDir);
  if (project?.bundleEntrypoint) {
    return project.bundleEntrypoint;
  }

  throw new Error(`No bundle entrypoint provided. Pass --bundle <input> or add "entrypoint" to ${resolvedRootDir}/vexascript.json`);
}
