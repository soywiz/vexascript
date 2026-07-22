import "./localVfs";
import type { Statement } from "../compiler/ast/ast";
import type { TranspileTarget } from "../compiler/runtime/transpile";
import type { BundledModuleArtifacts } from "./model";
import { dirname, resolve } from "../compiler/utils/path";
import { loadProject, type VexaProject } from "../compiler/project";
import { vfs } from "../compiler/vfs";
import { ensureDependencies } from "./deps";
import { runCommandCapture } from "./io";

export function isTypeScriptSource(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx");
}

export function usesExternalTypeScriptCheck(sourcePath: string, semanticCheck: boolean): boolean {
  return semanticCheck && isTypeScriptSource(sourcePath);
}

/**
 * Validates TypeScript with its own semantic checker, then tells the shared
 * VexaScript pipeline whether it must also report VexaScript type diagnostics.
 * Type inference always remains enabled for emission in both cases.
 */
export async function vexaTypeCheckForSource(
  sourcePath: string,
  project: VexaProject | null,
  semanticCheck: boolean
): Promise<boolean> {
  if (!usesExternalTypeScriptCheck(sourcePath, semanticCheck)) {
    return semanticCheck;
  }

  const tsconfigPath = project ? resolve(project.projectDir, "tsconfig.json") : "";
  const hasTsconfig = tsconfigPath.length > 0 && await vfs().fileExists(tsconfigPath);
  const args = ["exec", "tsc", "--noEmit", "--pretty", "false"];
  if (hasTsconfig) {
    args.push("--project", tsconfigPath);
  } else {
    args.push(sourcePath);
  }
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

export async function ambientDeclarationsForProject(sourcePath: string, project: VexaProject | null) {
  const declarations: Statement[] = [];
  const requested = new Set((project?.libs ?? []).map((lib) => lib.toLowerCase()));
  if (requested.has("dom")) {
    const { ensureDomProgram } = await import("../compiler/runtime/domDeclarations");
    declarations.push(...(await ensureDomProgram()).body);
  }

  if ((project?.types ?? []).length > 0) {
    const { loadAmbientTypesForProject } = await import("../compiler/lsp/ambientTypesLoader");
    const ambientTypes = await loadAmbientTypesForProject(sourcePath, project?.types ?? []);
    declarations.push(...ambientTypes.globalDeclarations);
  }

  return declarations;
}

export async function globalDeclarationsForProject(project: VexaProject | null): Promise<Statement[]> {
  if (!project?.globalSymbols || project.globalSymbols.paths.length === 0) {
    return [];
  }
  const { loadGlobalSymbolDeclarations } = await import("../compiler/runtime/moduleGraph");
  return loadGlobalSymbolDeclarations(project.globalSymbols.paths);
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

export async function createBundledModuleArtifacts(
  sourcePath: string,
  target: TranspileTarget,
  project: VexaProject | null,
  jsxOptions: { jsxFactory?: string; jsxFragmentFactory?: string } = {},
  options: {
    externalDependencyStrategy?: "runtime-error" | "node-require";
    typeCheck?: boolean;
  } = {}
): Promise<BundledModuleArtifacts> {
  const semanticValidation = vexaTypeCheckForSource(
    sourcePath,
    project,
    options.typeCheck ?? true
  );
  const vexaTypeCheck = usesExternalTypeScriptCheck(sourcePath, options.typeCheck ?? true)
    ? false
    : await semanticValidation;
  const ambientDeclarations = await ambientDeclarationsForProject(sourcePath, project);
  const { bundleModuleGraphAsModules } = await import("../compiler/runtime/moduleGraph");
  const result = await bundleModuleGraphAsModules(sourcePath, target, {
    ambientDeclarations,
    importMappings: project?.importMappings ?? {},
    moduleFormat: "commonjs",
    typeCheck: vexaTypeCheck,
    ...(project?.baseUrl ? { baseUrl: project.baseUrl } : {}),
    ...(project?.globalSymbols ? { globalSymbols: project.globalSymbols } : {}),
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {}),
    ...(jsxOptions.jsxFactory ? { jsxFactory: jsxOptions.jsxFactory } : {}),
    ...(jsxOptions.jsxFragmentFactory ? { jsxFragmentFactory: jsxOptions.jsxFragmentFactory } : {})
  });
  await semanticValidation;
  if (result.errors.length > 0) {
    return {
      code: "",
      warnings: result.warnings,
      errors: result.errors,
      diagnostics: result.diagnostics,
      watchedFiles: result.watchedFiles
    };
  }

  const { bundleNodeModuleGraph } = await import("./nodeModuleBundle");
  const bundled = await bundleNodeModuleGraph(result.entrySource, sourcePath, {
    virtualSources: result.moduleSources,
    importMappings: project?.importMappings ?? {},
    ...(project?.baseUrl ? { baseUrl: project.baseUrl } : {}),
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
