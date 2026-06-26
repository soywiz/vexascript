import { setRuntimeDeclarationsHost } from "./declarationHost";
import { nodeRuntimeDeclarationsHost } from "./nodeDeclarationHost";

setRuntimeDeclarationsHost(nodeRuntimeDeclarationsHost);

export {
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode,
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME
} from "./ecmascriptDeclarations.shared";
export {
  ensureVexaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeProgram,
  isVexaScriptRuntimeNode,
  VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME
} from "./vexascriptDeclarations.shared";

// NOTE: This module intentionally does NOT preload the runtime declaration
// programs at import time. A top-level `await` here makes every transitive
// importer an async (top-level-await) module, which esbuild propagates through
// the whole bundle as `await init_<module>()` calls. In the packaged LSP server
// bundle (`dist/vexa.mjs`) Node then reports "Detected unsettled top-level
// await" and the process exits with code 13. See AGENTS.md: "Do not use
// top-level awaits as they are problematic."
//
// Instead, each async entry point loads the declarations explicitly before any
// synchronous getter (getEcmaScriptRuntimeProgram / getVexaScriptRuntimeProgram)
// can be reached: the CLI via `ensureCompilerRuntimePrograms()`, the LSP server
// by awaiting the ensure functions in its `initialize` handler, the MCP server
// at startup, and the test suite in `compiler/test/expect.ts`.
