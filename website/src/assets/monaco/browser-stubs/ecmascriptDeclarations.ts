import {
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  isEcmaScriptRuntimeNode,
  setEcmaScriptRuntimeDeclarationFilePath
} from "compiler/runtime/ecmascriptDeclarations.shared";
import {
  VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  ensureVexaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeProgram,
  isVexaScriptRuntimeNode,
  setVexaScriptRuntimeDeclarationFilePath
} from "compiler/runtime/vexascriptDeclarations.shared";

setEcmaScriptRuntimeDeclarationFilePath("/runtime/es2025.d.ts");
setVexaScriptRuntimeDeclarationFilePath("/runtime/vexascript.d.vx");

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
