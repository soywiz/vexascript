import type { TranspileDiagnostic } from "../compiler/runtime/transpile";

export interface BundledModuleArtifacts {
  code: string;
  warnings: string[];
  errors: string[];
  diagnostics: TranspileDiagnostic[];
  watchedFiles: string[];
}
