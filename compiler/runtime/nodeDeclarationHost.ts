import "compiler/localVfs";
import { realpath } from "node:fs/promises";
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

async function currentDirectory(): Promise<string> {
  const filePath = fileURLToPath(import.meta.url);
  try {
    return dirname(await realpath(filePath));
  } catch {
    return dirname(filePath);
  }
}

async function readBundledDeclarationSource(fileName: string): Promise<RuntimeDeclarationSource> {
  const bundledPath = resolve(await currentDirectory(), fileName);
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
