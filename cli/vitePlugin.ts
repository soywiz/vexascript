import "./localVfs";
import { loadProject } from "../compiler/project";
import { transpile } from "../compiler/runtime/transpile";
import { dirname } from "../compiler/utils/path";
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
  options: VexaScriptPluginOptions
): Promise<VexaScriptTransformResult> {
  const project = await loadProject(dirname(sourcePath));
  const jsxFactory = options.jsxFactory ?? project?.jsxFactory;
  const jsxFragmentFactory = options.jsxFragmentFactory ?? project?.jsxFragmentFactory;
  const jsxImportSource = project?.jsxImportSource;
  const result = transpile(code, {
    sourceFilePath: sourcePath,
    outputFilePath: outputPathFor(sourcePath),
    target: options.target ?? "optimized",
    typeCheck: false,
    emitSourceMap: true,
    moduleFormat: "esm",
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

  return {
    code: result.code,
    map: sourceMapFrom(result.sourceMap)
  };
}

export const vexascript: VexaScriptPluginFactory = (
  options: VexaScriptPluginOptions = {}
): VexaScriptVitePlugin => ({
  name: "vexascript",
  enforce: "pre",
  async transform(this: VexaScriptTransformContext, code: string, id: string) {
    const module = isVexaScriptModule(id);
    if (!module) {
      return null;
    }
    return await transformVexaScript(this, code, module.sourcePath, options);
  }
});

export default vexascript;
