import type { VexaProject } from "../../compiler/project";
import type { BundledModuleArtifacts } from "../../cli/model";
import type { Statement } from "../../compiler/ast/ast";
import { ensureDomProgram } from "./domDeclarations";
import { bundleModuleGraphAsModules } from "./moduleGraph";
import { bundleNodeModuleGraph, type BundleNodeModulesOptions } from "../../cli/nodeModuleBundle";

export async function ambientDeclarationsForProject(
  _sourcePath: string,
  project: VexaProject | null
): Promise<Statement[]> {
  const declarations: Statement[] = [];
  const requested = new Set((project?.libs ?? []).map((lib) => lib.toLowerCase()));
  if (requested.has("dom")) {
    const program = await ensureDomProgram();
    declarations.push(...program.body);
  }
  return declarations;
}

export async function globalDeclarationsForProject(_project: unknown): Promise<Statement[]> {
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
  _project: VexaProject | null,
  semanticCheck: boolean
): Promise<boolean> {
  if (usesExternalTypeScriptCheck(sourcePath, semanticCheck)) {
    return false;
  }
  return semanticCheck;
}

export async function createBundledModuleArtifacts(
  sourcePath: string,
  target: string,
  project: VexaProject | null,
  _jsxOptions: unknown,
  options: { externalDependencyStrategy?: "runtime-error" | "node-require"; typeCheck?: boolean } = {}
): Promise<BundledModuleArtifacts> {
  const jsxOptions = _jsxOptions as { jsxFactory?: string; jsxFragmentFactory?: string } | undefined;
  const typeCheck = await vexaTypeCheckForSource(sourcePath, project, options.typeCheck ?? true);
  const ambientDeclarations = await ambientDeclarationsForProject(sourcePath, project);
  const result = await bundleModuleGraphAsModules(sourcePath, target === "conservative" ? "conservative" : "optimized", {
    ambientDeclarations,
    importMappings: project?.importMappings ?? {},
    moduleFormat: "commonjs",
    typeCheck,
    ...(project?.baseUrl ? { baseUrl: project.baseUrl } : {}),
    ...(project?.globalSymbols ? { globalSymbols: project.globalSymbols } : {}),
    ...(project?.jsxFactory ? { jsxFactory: project.jsxFactory } : {}),
    ...(project?.jsxFragmentFactory ? { jsxFragmentFactory: project.jsxFragmentFactory } : {}),
    ...(jsxOptions?.jsxFactory ? { jsxFactory: jsxOptions.jsxFactory } : {}),
    ...(jsxOptions?.jsxFragmentFactory ? { jsxFragmentFactory: jsxOptions.jsxFragmentFactory } : {}),
  });
  if (result.errors.length > 0) {
    return {
      code: "",
      warnings: result.warnings,
      errors: result.errors,
      diagnostics: result.diagnostics,
      watchedFiles: result.watchedFiles,
    };
  }

  const bundleOptions: BundleNodeModulesOptions = {
    virtualSources: result.moduleSources,
    importMappings: project?.importMappings ?? {},
    externalDependencyStrategy: options.externalDependencyStrategy ?? "runtime-error",
  };
  if (project?.baseUrl) {
    bundleOptions.baseUrl = project.baseUrl;
  }
  const bundled = await bundleNodeModuleGraph(result.entrySource, sourcePath, bundleOptions);
  return {
    code: bundled.code,
    warnings: result.warnings,
    errors: result.errors,
    diagnostics: result.diagnostics,
    watchedFiles: [...new Set([...result.watchedFiles, ...bundled.watchedFiles])],
  };
}

export async function resolveServeBundleInput(_rootDir: string, _explicitBundleInput?: string): Promise<string> {
  throw new Error("The development server is not available in the native VexaScript CLI yet");
}
