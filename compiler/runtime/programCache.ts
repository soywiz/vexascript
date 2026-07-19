import type { Program } from "compiler/ast/ast";
import { globalVfs, vfs, type Vfs } from "compiler/vfs";

// Numeric NodeKind values replaced the legacy string discriminators in cached ASTs.
const PROGRAM_CACHE_VERSION = 3;
const STORAGE_KEY_PREFIX = `vexa.runtime.program-cache.v${PROGRAM_CACHE_VERSION}.`;
const memoryStorage = new Map<string, string>();

interface CacheStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface NodeFsPromisesLike {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, value: string): Promise<void>;
}

let nodeStorageState:
  | {
    backend: "memory" | "fs" | "vfs";
    storagePromise: Promise<CacheStorageLike>;
    vfsRef?: Vfs;
  }
  | null = null;

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getBrowserStorage(): CacheStorageLike | null {
  if (!isBrowserRuntime()) {
    return null;
  }

  try {
    const storage = globalThis.localStorage;
    if (
      storage &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function"
    ) {
      return {
        async getItem(key: string): Promise<string | null> {
          return storage.getItem(key);
        },
        async setItem(key: string, value: string): Promise<void> {
          storage.setItem(key, value);
        },
      };
    }
  } catch {
    // Accessing localStorage can throw in restricted environments.
  }

  return null;
}

function getMemoryStorage(): CacheStorageLike {
  return {
    async getItem(key: string): Promise<string | null> {
      return memoryStorage.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      memoryStorage.set(key, value);
    },
  };
}

function getNodeFsPromises(): NodeFsPromisesLike | null {
  const builtinLoader = process.getBuiltinModule;
  if (typeof builtinLoader !== "function") {
    return null;
  }
  const builtin = builtinLoader("node:fs/promises");
  if (!builtin || typeof builtin !== "object") {
    return null;
  }

  const fsPromises = builtin as Partial<NodeFsPromisesLike>;
  if (
    typeof fsPromises.readFile !== "function" ||
    typeof fsPromises.writeFile !== "function"
  ) {
    return null;
  }

  return fsPromises as NodeFsPromisesLike;
}

function getNodeCacheDirectory(): string {
  return (
    process.env["TMPDIR"] ||
    process.env["TEMP"] ||
    process.env["TMP"] ||
    "/tmp"
  ).replace(/[\\/]$/, "");
}

function getNodeCacheFilePath(): string {
  return `${getNodeCacheDirectory()}/vexa-runtime-program-cache-v${PROGRAM_CACHE_VERSION}-${process.pid}.json`;
}

async function createNodeVfsStorage(boundVfs: Vfs): Promise<CacheStorageLike> {
  const cacheKey = getNodeCacheFilePath();
  try {
    const content = await boundVfs.readFile(cacheKey);
    const parsed = JSON.parse(content) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      memoryStorage.set(key, value);
    }
  } catch {
    // Cold cache or unavailable backing file: keep the in-memory map empty.
  }

  return {
    async getItem(key: string): Promise<string | null> {
      return memoryStorage.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      memoryStorage.set(key, value);
      await boundVfs.writeFile(cacheKey, JSON.stringify(Object.fromEntries(memoryStorage)));
    },
  };
}

async function createNodeFileStorage(fsPromises: NodeFsPromisesLike): Promise<CacheStorageLike> {
  const cacheFilePath = getNodeCacheFilePath();
  try {
    const content = await fsPromises.readFile(cacheFilePath, "utf8");
    const parsed = JSON.parse(content) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      memoryStorage.set(key, value);
    }
  } catch {
    // Cold cache or unreadable file: keep the in-memory map empty.
  }

  return {
    async getItem(key: string): Promise<string | null> {
      return memoryStorage.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      memoryStorage.set(key, value);
      await fsPromises.writeFile(cacheFilePath, JSON.stringify(Object.fromEntries(memoryStorage)));
    },
  };
}

async function getStorage(): Promise<CacheStorageLike> {
  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    return browserStorage;
  }

  if (!isNodeRuntime()) {
    return getMemoryStorage();
  }

  if (globalVfs.ref) {
    if (!nodeStorageState || nodeStorageState.backend !== "vfs" || nodeStorageState.vfsRef !== globalVfs.ref) {
      nodeStorageState = {
        backend: "vfs",
        vfsRef: globalVfs.ref,
        storagePromise: createNodeVfsStorage(vfs()),
      };
    }
    return await nodeStorageState.storagePromise;
  }

  const fsPromises = getNodeFsPromises();
  if (fsPromises) {
    if (!nodeStorageState || nodeStorageState.backend !== "fs") {
      nodeStorageState = {
        backend: "fs",
        storagePromise: createNodeFileStorage(fsPromises),
      };
    }
    return await nodeStorageState.storagePromise;
  }

  if (!nodeStorageState || nodeStorageState.backend !== "memory") {
    nodeStorageState = {
      backend: "memory",
      storagePromise: Promise.resolve(getMemoryStorage()),
    };
  }

  return await nodeStorageState.storagePromise;
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

async function generateAndPersist(
  storage: CacheStorageLike,
  cachedProgramKey: string,
  cachedHashKey: string,
  expectedHash: string,
  generate: () => Promise<Program>
): Promise<Program> {
  const program = await generate();
  try {
    await storage.setItem(cachedProgramKey, JSON.stringify(program));
    await storage.setItem(cachedHashKey, expectedHash);
  } catch {
    // Ignore storage failures and still return the freshly generated program.
  }
  return program;
}

export async function cacheProgram(
  sourceFilePath: string,
  hash: string,
  generate: () => Promise<Program>
): Promise<Program> {
  const storage = await getStorage();
  const cachedProgramKey = programKey(sourceFilePath);
  const cachedHashKey = hashKey(sourceFilePath);
  const expectedHash = await hashText(`${PROGRAM_CACHE_VERSION}\0${hash}`);
  const cachedHash = await storage.getItem(cachedHashKey);
  const cachedProgram = cachedHash === expectedHash ? await storage.getItem(cachedProgramKey) : null;
  if (cachedProgram === null) {
    return generateAndPersist(storage, cachedProgramKey, cachedHashKey, expectedHash, generate);
  }

  try {
    return JSON.parse(cachedProgram) as Program;
  } catch {
    return generateAndPersist(storage, cachedProgramKey, cachedHashKey, expectedHash, generate);
  }
}
