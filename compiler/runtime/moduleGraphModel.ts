import type { Statement } from "compiler/ast/ast";
import type { Vfs } from "compiler/vfs";

export interface GlobalSymbolSourceOptions {
  paths?: string[];
  emit?: "globalThis" | "assume";
}

export interface ModuleGraphProfileEvent {
  phase: string;
  elapsedMs: number;
  moduleCount: number;
  analyzedModuleCount: number;
  emittedModuleCount: number;
  reusedModuleCount: number;
  ambientDeclarationVisitCount: number;
  nodeModuleImportResolutionCount: number;
  nodeModuleImportCacheHitCount: number;
  selectiveTypingsBuilds: number;
  selectiveTypingsExactCacheHits: number;
  selectiveTypingsSupersetCacheHits: number;
  typingsFileIndexBuilds: number;
  typingsFileIndexCacheHits: number;
  typingsFileIndexEdgeResolutions: number;
}

/** Opaque state retained by long-running module graph consumers such as `vexa serve`. */
export interface ModuleGraphIncrementalCache {}

export interface ModuleGraphOptions {
  vfs?: Vfs;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  /** Import classic `h`/`Fragment` bindings for automatic-runtime compatibility. */
  jsxImportSource?: string;
  ambientDeclarations?: Statement[];
  importMappings?: Readonly<Record<string, string>>;
  globalSymbols?: GlobalSymbolSourceOptions;
  /** Forwarded to transpilation; false keeps semantic metadata but does not fail emission. */
  typeCheck?: boolean;
  /** Populate type-driven emitter metadata; false selects conservative dynamic lowering. */
  inferTypes?: boolean;
  /** Root used to resolve TypeScript-style non-relative source imports. */
  baseUrl?: string;
  /** Optional phase timing sink used by benchmarks and Node-only CLI profiling. */
  profile?: (event: ModuleGraphProfileEvent) => void;
  /** Reuse stable import/type contexts between explicitly invalidated rebuilds. */
  incrementalCache?: ModuleGraphIncrementalCache;
  /** Files known to have changed since the previous incremental build. */
  changedFiles?: readonly string[];
}
