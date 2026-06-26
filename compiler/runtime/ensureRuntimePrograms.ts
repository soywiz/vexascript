import { ensureEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations.shared";
import { ensureVexaScriptRuntimeProgram } from "./vexascriptDeclarations.shared";

/**
 * Loads both embedded runtime declaration programs (ECMAScript + VexaScript) so
 * the synchronous getters used by the Binder / TypeChecker / transpiler are
 * ready. Call this once from each async entry point before any synchronous
 * runtime-program access. This module is browser-safe: the caller's environment
 * must already have configured the declarations host (Node entry points import
 * `compiler/runtime/ecmascriptDeclarations`; the browser embed installs its own
 * host).
 *
 * This replaces the former import-time preload, which relied on a top-level
 * await and broke the packaged LSP bundle (see AGENTS.md: "Do not use top-level
 * awaits as they are problematic.").
 */
export async function ensureCompilerRuntimePrograms(): Promise<void> {
  await Promise.all([
    ensureEcmaScriptRuntimeProgram(),
    ensureVexaScriptRuntimeProgram()
  ]);
}
