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
}

export interface ModuleGraphOptions {
  vfs?: Vfs;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  ambientDeclarations?: Statement[];
  importMappings?: Readonly<Record<string, string>>;
  globalSymbols?: GlobalSymbolSourceOptions;
  /** Forwarded to transpilation; false keeps semantic metadata but does not fail emission. */
  typeCheck?: boolean;
  /** Root used to resolve TypeScript-style non-relative source imports. */
  baseUrl?: string;
  /** Optional phase timing sink used by benchmarks and Node-only CLI profiling. */
  profile?: (event: ModuleGraphProfileEvent) => void;
}
