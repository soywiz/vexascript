import { setRuntimeDeclarationsHost } from "./declarationHost";
import { dirname, fileURLToPath, resolve } from "compiler/utils/path";
import { nodeRuntimeDeclarationsHost } from "./nodeDeclarationHost";
import {
  setEcmaScriptRuntimeDeclarationFilePath,
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME
} from "./ecmascriptDeclarations.shared";
import {
  setVexaScriptRuntimeDeclarationFilePath,
  VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME
} from "./vexascriptDeclarations.shared";

setRuntimeDeclarationsHost(nodeRuntimeDeclarationsHost);

const runtimeDeclarationBaseDir = dirname(fileURLToPath(import.meta.url));
setEcmaScriptRuntimeDeclarationFilePath(resolve(runtimeDeclarationBaseDir, TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME));
setVexaScriptRuntimeDeclarationFilePath(resolve(runtimeDeclarationBaseDir, VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME));

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
// programs at import time. The ECMAScript and VexaScript declaration sources are
// embedded as module constants and parsed lazily by their synchronous getters,
// so no top-level await or entry-point preload is needed.
