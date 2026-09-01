import "./localVfs";
import type { Statement } from "../compiler/ast/ast";
import { loadProject } from "../compiler/project";
import { transpile } from "../compiler/runtime/transpile";
import { parseSource } from "../compiler/pipeline/parse";
import {
  collectAllImportedDeclarations,
  type CollectedImportedDeclarations
} from "../compiler/lsp/importedDeclarations";
import { dirname, pathToFileURL } from "../compiler/utils/path";
import {
  ambientDeclarationsForProject,
  globalDeclarationsForProject
} from "./cliShared";
import type {
  VexaScriptPluginFactory,
  VexaScriptPluginOptions,
  VexaScriptSourceMap,
  VexaScriptTransformContext,
  VexaScriptTransformResult,
  VexaScriptVitePlugin
} from "./vitePlugin.public";

const VITE_ASSET_QUERIES = new Set(["raw", "url", "worker", "sharedworker"]);

function splitModuleId(id: string): { sourcePath: string; query: URLSearchParams } {
  const queryStart = id.indexOf("?");
  if (queryStart < 0) {
    return { sourcePath: id, query: new URLSearchParams() };
  }
  return {
    sourcePath: id.slice(0, queryStart),
    query: new URLSearchParams(id.slice(queryStart + 1))
  };
}

function isVexaScriptModule(id: string): { sourcePath: string } | null {
  const { sourcePath, query } = splitModuleId(id);
  if (!sourcePath.toLowerCase().endsWith(".vx")) {
    return null;
  }
  for (const assetQuery of VITE_ASSET_QUERIES) {
    if (query.has(assetQuery)) {
      return null;
    }
  }
  return { sourcePath };
}

function outputPathFor(sourcePath: string): string {
  return `${sourcePath.slice(0, -3)}.js`;
}

function sourceMapFrom(rawSourceMap: string | undefined): VexaScriptSourceMap {
  if (!rawSourceMap) {
    throw new Error("VexaScript did not generate the source map requested by the Vite plugin");
  }
  return JSON.parse(rawSourceMap) as VexaScriptSourceMap;
}

async function transformVexaScript(
  context: VexaScriptTransformContext,
  code: string,
  sourcePath: string,
  options: VexaScriptPluginOptions,
  importedDeclarationsCache: Map<string, Promise<CollectedImportedDeclarations>>,
  semanticDeclarationsCache: Map<string, Promise<Statement[]>>
): Promise<VexaScriptTransformResult> {
  const project = await loadProject(dirname(sourcePath));
  const jsxFactory = options.jsxFactory ?? project?.jsxFactory;
  const jsxFragmentFactory = options.jsxFragmentFactory ?? project?.jsxFragmentFactory;
  const jsxImportSource = project?.jsxImportSource;
  const semanticCacheKey = project?.projectDir ?? dirname(sourcePath);
  let semanticDeclarations = semanticDeclarationsCache.get(semanticCacheKey);
  if (!semanticDeclarations) {
    semanticDeclarations = Promise.all([
      ambientDeclarationsForProject(sourcePath, project),
      globalDeclarationsForProject(project)
    ]).then(([ambientDeclarations, globalDeclarations]) => [
      ...ambientDeclarations,
      ...globalDeclarations
    ]);
    semanticDeclarationsCache.set(semanticCacheKey, semanticDeclarations);
  }
  const resolvedSemanticDeclarations = await semanticDeclarations;
  const parsed = parseSource(code, {});
  const imported = parsed.ast
    ? await collectAllImportedDeclarations(parsed.ast, {
      uri: pathToFileURL(sourcePath).toString(),
      sourceRoots: project ? [project.projectDir] : [dirname(sourcePath)],
      importMappings: project?.importMappings ?? {},
      ambientDeclarations: resolvedSemanticDeclarations,
      ambientGlobalDeclarations: resolvedSemanticDeclarations,
      importedDeclarationsCache
    })
    : null;
  const result = transpile(code, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPathFor(sourcePath),
    target: options.target ?? "optimized",
    typeCheck: false,
    emitSourceMap: true,
    moduleFormat: "esm",
    ambientDeclarations: resolvedSemanticDeclarations,
    externalDeclarations: imported?.externalDeclarations ?? [],
    importedSymbols: imported?.importedSymbols ?? new Map(),
    ...(jsxFactory ? { jsxFactory } : {}),
    ...(jsxFragmentFactory ? { jsxFragmentFactory } : {}),
    ...(jsxImportSource ? { jsxImportSource } : {})
  });

  if (result.errors.length > 0) {
    const firstDiagnostic = result.diagnostics[0];
    context.error({
      message: result.errors.join("\n"),
      id: sourcePath,
      ...(firstDiagnostic
        ? {
            loc: {
              file: sourcePath,
              line: firstDiagnostic.line,
              column: Math.max(0, firstDiagnostic.column - 1)
            }
          }
        : {})
    });
  }

  for (const warning of result.warnings) {
    context.warn?.(warning);
  }

  return {
    code: result.code,
    map: sourceMapFrom(result.sourceMap)
  };
}

export const vexascript: VexaScriptPluginFactory = (
  options: VexaScriptPluginOptions = {}
): VexaScriptVitePlugin => {
  const importedDeclarationsCache = new Map<string, Promise<CollectedImportedDeclarations>>();
  const semanticDeclarationsCache = new Map<string, Promise<Statement[]>>();
  const transformedSources = new Map<string, string>();
  let transformQueue: Promise<void> = Promise.resolve();
  return {
    name: "vexascript",
    enforce: "pre",
    async transform(this: VexaScriptTransformContext, code: string, id: string) {
      const module = isVexaScriptModule(id);
      if (!module) {
        return null;
      }
      const pending = transformQueue.then(() => {
        const previousSource = transformedSources.get(module.sourcePath);
        if (previousSource !== undefined && previousSource !== code) {
          importedDeclarationsCache.clear();
        }
        transformedSources.set(module.sourcePath, code);
        return transformVexaScript(
          this,
          code,
          module.sourcePath,
          options,
          importedDeclarationsCache,
          semanticDeclarationsCache
        );
      });
      transformQueue = pending.then(
        () => undefined,
        () => undefined
      );
      return await pending;
    }
  };
};

export default vexascript;
