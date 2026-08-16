import * as ast from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import type { Vfs } from "compiler/vfs";

// Numeric NodeKind values replaced the legacy string discriminators in cached ASTs.
const PROGRAM_CACHE_VERSION = 4;
const STORAGE_KEY_PREFIX = `vexa.runtime.program-cache.v${PROGRAM_CACHE_VERSION}.`;
const VFS_CACHE_FILE_PATH = `/vexa-runtime-program-cache-v${PROGRAM_CACHE_VERSION}.json`;
const memoryStorage = new Map<string, string>();

interface CacheStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const explicitVfsStorage = new WeakMap<Vfs, Promise<CacheStorageLike>>();

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

async function createVfsStorage(boundVfs: Vfs): Promise<CacheStorageLike> {
  try {
    const content = await boundVfs.readFile(VFS_CACHE_FILE_PATH);
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
      await boundVfs.writeFile(VFS_CACHE_FILE_PATH, JSON.stringify(Object.fromEntries(memoryStorage)));
    },
  };
}

async function getStorage(activeVfs?: Vfs): Promise<CacheStorageLike> {
  // A Node process already keeps this module and its declaration programs alive.
  // Persisting the same AST under a PID only creates stale-schema collisions when
  // the operating system reuses that PID, so Node deliberately stays in memory.
  if (isNodeRuntime() && !isBrowserRuntime()) {
    return getMemoryStorage();
  }

  if (activeVfs) {
    let storage = explicitVfsStorage.get(activeVfs);
    if (!storage) {
      storage = createVfsStorage(activeVfs);
      explicitVfsStorage.set(activeVfs, storage);
    }
    return await storage;
  }

  const browserStorage = getBrowserStorage();
  if (browserStorage) {
    return browserStorage;
  }
  return getMemoryStorage();
}

function programKey(sourceFilePath: string): string {
  return `${STORAGE_KEY_PREFIX}${sourceFilePath}`;
}

function hashKey(sourceFilePath: string): string {
  return `${programKey(sourceFilePath)}_hash`;
}

function reviveProgram(serialized: string): Program {
  const root = JSON.parse(serialized) as unknown;
  const constructors = ast as unknown as Record<string, { prototype: object } | undefined>;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (ast.isNodeKind(record["kind"])) {
      const constructor = constructors[ast.nodeKindName(record["kind"] as ast.NodeKind)];
      if (!constructor) throw new Error(`No AST constructor for kind ${String(record["kind"])}`);
      Object.setPrototypeOf(record, constructor.prototype);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(root);
  return root as Program;
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
  generate: () => Promise<Program>,
  activeVfs?: Vfs
): Promise<Program> {
  const storage = await getStorage(activeVfs);
  const cachedProgramKey = programKey(sourceFilePath);
  const cachedHashKey = hashKey(sourceFilePath);
  const expectedHash = await hashText(`${PROGRAM_CACHE_VERSION}\0${hash}`);
  const cachedHash = await storage.getItem(cachedHashKey);
  const cachedProgram = cachedHash === expectedHash ? await storage.getItem(cachedProgramKey) : null;
  if (cachedProgram === null) {
    return generateAndPersist(storage, cachedProgramKey, cachedHashKey, expectedHash, generate);
  }

  try {
    return reviveProgram(cachedProgram);
  } catch {
    return generateAndPersist(storage, cachedProgramKey, cachedHashKey, expectedHash, generate);
  }
}
