import { setRuntimeDeclarationsHost } from "./declarationHost";
import { nodeRuntimeDeclarationsHost } from "./nodeDeclarationHost";

setRuntimeDeclarationsHost(nodeRuntimeDeclarationsHost);

export {
  ensureDomProgram,
  getDomDeclarationFilePath,
  isDomRuntimeNode,
  TYPESCRIPT_DOM_DECLARATION_FILE_NAME
} from "./domDeclarations.shared";
