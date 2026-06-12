import "compiler/localVfs";
import { fileExists } from "compiler/utils/fs";
import { dirname, fileURLToPath, resolve } from "compiler/utils/path";
import {
  TYPESCRIPT_DOM_DECLARATION_FILE_NAME,
  type CachedDomSourceMetadata
} from "./domDeclarations.shared";
import {
  TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME,
  type CachedRuntimeSourceMetadata
} from "./ecmascriptDeclarations.shared";
import { VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME } from "./vexascriptDeclarations.shared";
import type { RuntimeDeclarationsHost, RuntimeDeclarationSource } from "./declarationHost";
import { vfs } from "compiler/vfs";

function currentDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

async function readBundledDeclarationSource(fileName: string): Promise<RuntimeDeclarationSource> {
  const bundledPath = resolve(currentDirectory(), fileName);
  if (await fileExists(bundledPath)) {
    return {
      filePath: bundledPath,
      source: await vfs().readFile(bundledPath)
    };
  }

  const sourcePath = resolve(process.cwd(), "compiler", "runtime", fileName);
  return {
    filePath: sourcePath,
    source: await vfs().readFile(sourcePath)
  };
}

export const nodeRuntimeDeclarationsHost: RuntimeDeclarationsHost = {
  async loadEcmaScriptDeclarations(): Promise<RuntimeDeclarationSource & CachedRuntimeSourceMetadata> {
    const declaration = await readBundledDeclarationSource(TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME);
    const { mtimeMs } = await vfs().stat(declaration.filePath);
    return { ...declaration, mtimeMs };
  },
  async loadVexaScriptDeclarations(): Promise<RuntimeDeclarationSource> {
    return readBundledDeclarationSource(VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME);
  },
  async loadDomDeclarations(): Promise<RuntimeDeclarationSource & CachedDomSourceMetadata> {
    return readBundledDeclarationSource(TYPESCRIPT_DOM_DECLARATION_FILE_NAME);
  }
};
