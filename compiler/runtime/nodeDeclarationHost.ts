import { dirname, fileURLToPath, resolve } from "compiler/utils/path";
import {
  TYPESCRIPT_DOM_DECLARATION_FILE_NAME
} from "./domDeclarations.shared";
import type { RuntimeDeclarationsHost, RuntimeDeclarationSource } from "./declarationHost";

interface NodeStatLike {
  mtimeMs: number;
}

interface NodeFsPromisesLike {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<NodeStatLike>;
}

function getNodeFsPromises(): NodeFsPromisesLike {
  const builtinLoader = process.getBuiltinModule;
  if (typeof builtinLoader !== "function") {
    throw new Error("Node builtins are unavailable in this runtime");
  }

  const builtin = builtinLoader("node:fs/promises");
  if (!builtin || typeof builtin !== "object") {
    throw new Error("node:fs/promises is unavailable in this runtime");
  }

  const fsPromises = builtin as Partial<NodeFsPromisesLike>;
  if (
    typeof fsPromises.readFile !== "function" ||
    typeof fsPromises.realpath !== "function" ||
    typeof fsPromises.stat !== "function"
  ) {
    throw new Error("node:fs/promises does not expose the expected API");
  }

  return fsPromises as NodeFsPromisesLike;
}

async function currentDirectory(fsPromises: NodeFsPromisesLike): Promise<string> {
  const filePath = fileURLToPath(import.meta.url);
  try {
    return dirname(await fsPromises.realpath(filePath));
  } catch {
    return dirname(filePath);
  }
}

async function fileExistsWithNodeFs(
  fsPromises: NodeFsPromisesLike,
  path: string
): Promise<boolean> {
  try {
    await fsPromises.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readBundledDeclarationSource(fileName: string): Promise<RuntimeDeclarationSource> {
  const fsPromises = getNodeFsPromises();
  const declarationBaseDir = await currentDirectory(fsPromises);
  const candidatePaths = [
    resolve(declarationBaseDir, fileName),
    resolve(declarationBaseDir, "..", "compiler", "runtime", fileName),
    resolve(declarationBaseDir, "compiler", "runtime", fileName)
  ];

  for (const candidatePath of candidatePaths) {
    if (await fileExistsWithNodeFs(fsPromises, candidatePath)) {
      return {
        filePath: candidatePath,
        source: await fsPromises.readFile(candidatePath, "utf8")
      };
    }
  }

  const sourcePath = resolve(process.cwd(), "compiler", "runtime", fileName);
  return {
    filePath: sourcePath,
    source: await fsPromises.readFile(sourcePath, "utf8")
  };
}

export const nodeRuntimeDeclarationsHost: RuntimeDeclarationsHost = {
  async loadDomDeclarations(): Promise<RuntimeDeclarationSource> {
    return readBundledDeclarationSource(TYPESCRIPT_DOM_DECLARATION_FILE_NAME);
  }
};
