import type { Program } from "compiler/ast/ast";

const PROGRAM_CACHE_VERSION = 1;
const STORAGE_KEY_PREFIX = `vexa.runtime.program-cache.v${PROGRAM_CACHE_VERSION}.`;

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function cacheFilePath(sourceFilePath: string): string {
  return `${STORAGE_KEY_PREFIX}${sourceFilePath}`;
}

function cacheHashPath(sourceFilePath: string): string {
  return `${cacheFilePath(sourceFilePath)}_hash`;
}

export async function cacheProgram(
  sourceFilePath: string,
  hash: string,
  generate: () => Promise<Program>
): Promise<Program> {
  const storage = getStorage();
  if (!storage) {
    return await generate();
  }
  const programKey = cacheFilePath(sourceFilePath);
  const hashKey = cacheHashPath(sourceFilePath);

  if (storage.getItem(hashKey) !== hash || storage.getItem(programKey) === null) {
    const program = await generate();
    try {
      storage.setItem(programKey, JSON.stringify(program));
      storage.setItem(hashKey, hash);
    } catch {
      // Ignore storage quota and serialization failures in the browser cache.
    }
    return program;
  }

  try {
    return JSON.parse(storage.getItem(programKey)!) as Program;
  } catch {
    const program = await generate();
    try {
      storage.setItem(programKey, JSON.stringify(program));
      storage.setItem(hashKey, hash);
    } catch {
      // Ignore storage quota and serialization failures in the browser cache.
    }
    return program;
  }
}
