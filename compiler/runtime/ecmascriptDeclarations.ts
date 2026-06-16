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

function shouldPreloadRuntimeDeclarationsAtImportTime(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) {
    return true;
  }
  const normalizedArgv1 = argv1.replace(/\\/g, "/");
  return !normalizedArgv1.endsWith("/dist/vexa.js");
}

if (shouldPreloadRuntimeDeclarationsAtImportTime()) {
  await import("./ecmascriptDeclarations.shared").then(({ ensureEcmaScriptRuntimeProgram }) =>
    ensureEcmaScriptRuntimeProgram()
  );
  await import("./vexascriptDeclarations.shared").then(({ ensureVexaScriptRuntimeProgram }) =>
    ensureVexaScriptRuntimeProgram()
  );
}
