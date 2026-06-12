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

await import("./ecmascriptDeclarations.shared").then(({ ensureEcmaScriptRuntimeProgram }) =>
  ensureEcmaScriptRuntimeProgram()
);
await import("./vexascriptDeclarations.shared").then(({ ensureVexaScriptRuntimeProgram }) =>
  ensureVexaScriptRuntimeProgram()
);
