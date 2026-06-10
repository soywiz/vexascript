import type { Program } from "compiler/ast/ast";

const PROGRAM_CACHE_VERSION = 1;
const STORAGE_KEY_PREFIX = `vexa.runtime.program-cache.v${PROGRAM_CACHE_VERSION}.`;
const memoryStorage = new Map<string, string>();

interface CacheStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(): CacheStorageLike {
  try {
    const storage = globalThis.localStorage;
    if (
      storage &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function"
    ) {
      return storage;
    }
  } catch {
    // Accessing localStorage can throw in restricted environments.
  }

  return {
    getItem(key: string): string | null {
      return memoryStorage.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      memoryStorage.set(key, value);
    },
  };
}

function programKey(sourceFilePath: string): string {
  return `${STORAGE_KEY_PREFIX}${sourceFilePath}`;
}

function hashKey(sourceFilePath: string): string {
  return `${programKey(sourceFilePath)}_hash`;
}

async function hashText(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function cacheProgram(
  sourceFilePath: string,
  hash: string,
  generate: () => Promise<Program>
): Promise<Program> {
  const storage = getStorage();
  const cachedProgramKey = programKey(sourceFilePath);
  const cachedHashKey = hashKey(sourceFilePath);
  const expectedHash = await hashText(`${PROGRAM_CACHE_VERSION}\0${hash}`);

  if (
    storage.getItem(cachedHashKey) !== expectedHash ||
    storage.getItem(cachedProgramKey) === null
  ) {
    const program = await generate();
    const serializedProgram = JSON.stringify(program);
    try {
      storage.setItem(cachedProgramKey, serializedProgram);
      storage.setItem(cachedHashKey, expectedHash);
    } catch {
      // Ignore storage failures and still return the freshly generated program.
    }
    return program;
  }

  try {
    return JSON.parse(storage.getItem(cachedProgramKey)!) as Program;
  } catch {
    const program = await generate();
    const serializedProgram = JSON.stringify(program);
    try {
      storage.setItem(cachedProgramKey, serializedProgram);
      storage.setItem(cachedHashKey, expectedHash);
    } catch {
      // Ignore storage failures and still return the freshly generated program.
    }
    return program;
  }
}
