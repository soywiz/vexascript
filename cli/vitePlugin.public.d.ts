export type VexaScriptTranspileTarget = "conservative" | "optimized";

export interface VexaScriptPluginOptions {
  /** JavaScript lowering strategy. Defaults to `optimized`. */
  target?: VexaScriptTranspileTarget;
  /** Overrides `compilerOptions.jsxFactory` from the nearest project configuration. */
  jsxFactory?: string;
  /** Overrides `compilerOptions.jsxFragmentFactory` from the nearest project configuration. */
  jsxFragmentFactory?: string;
}

export interface VexaScriptSourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

export interface VexaScriptTransformResult {
  code: string;
  map: VexaScriptSourceMap;
}

export interface VexaScriptTransformError {
  message: string;
  id?: string;
  loc?: {
    file?: string;
    line: number;
    column: number;
  };
}

export interface VexaScriptTransformContext {
  error(error: VexaScriptTransformError): never;
}

/**
 * The structural subset of Vite's plugin contract used by VexaScript.
 * Keeping this local avoids making Vite a dependency of the compiler package.
 */
export interface VexaScriptVitePlugin {
  name: "vexascript";
  enforce: "pre";
  transform(
    this: VexaScriptTransformContext,
    code: string,
    id: string
  ): Promise<VexaScriptTransformResult | null>;
}

export type VexaScriptPluginFactory = (options?: VexaScriptPluginOptions) => VexaScriptVitePlugin;

export declare const vexascript: VexaScriptPluginFactory;
export default vexascript;
