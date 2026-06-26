import bundledRuntimeUrl from "../../../../../compiler/runtime/es2025.d.ts?url";
import bundledVexaRuntimeUrl from "../../../../../compiler/runtime/vexascript.d.vx?url";
import { patchRuntimeDeclarationsHost } from "compiler/runtime/declarationHost";
import {
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode
} from "compiler/runtime/ecmascriptDeclarations.shared";
import {
  VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureVexaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeProgram,
  isVexaScriptRuntimeNode
} from "compiler/runtime/vexascriptDeclarations.shared";

patchRuntimeDeclarationsHost({
  async loadEcmaScriptDeclarations() {
    const response = await fetch(bundledRuntimeUrl);
    if (!response.ok) {
      throw new Error(`Failed to load bundled ECMAScript runtime declarations from ${bundledRuntimeUrl}`);
    }
    return {
      filePath: TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
      source: await response.text()
    };
  },
  async loadVexaScriptDeclarations() {
    const response = await fetch(bundledVexaRuntimeUrl);
    if (!response.ok) {
      throw new Error(`Failed to load bundled VexaScript runtime declarations from ${bundledVexaRuntimeUrl}`);
    }
    return {
      filePath: VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME,
      source: await response.text()
    };
  }
});

export {
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureEcmaScriptRuntimeProgram,
  ensureVexaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode,
  isVexaScriptRuntimeNode
};
