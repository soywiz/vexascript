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

await import("./ecmascriptDeclarations.shared").then(({ ensureEcmaScriptRuntimeProgram }) =>
  ensureEcmaScriptRuntimeProgram()
);
