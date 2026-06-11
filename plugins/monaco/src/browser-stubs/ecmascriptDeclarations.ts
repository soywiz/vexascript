import { patchRuntimeDeclarationsHost } from "compiler/runtime/declarationHost";
import {
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode
} from "compiler/runtime/ecmascriptDeclarations.shared";

patchRuntimeDeclarationsHost({
  async loadEcmaScriptDeclarations() {
    const response = await fetch(new URL("../../../../compiler/runtime/es2025.d.ts", import.meta.url));
    if (!response.ok) {
      throw new Error(`Failed to load bundled ECMAScript runtime declarations from ${response.url}`);
    }
    return {
      filePath: TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
      source: await response.text()
    };
  }
});

export {
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode
};
