import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Program } from "compiler/ast/ast";

const PROGRAM_CACHE_VERSION = 1;
const CACHE_DIR = join(tmpdir(), "mylang-runtime-program-cache");

interface CachedProgramFile {
  version: number;
  mtimeMs: number;
  program: Program;
}

function cacheFilePath(sourceFilePath: string, cacheSalt: string): string {
  const key = createHash("sha1").update(`${sourceFilePath}\0${cacheSalt}`).digest("hex");
  return join(CACHE_DIR, `${key}.json`);
}

export async function loadCachedProgram(
  sourceFilePath: string,
  mtimeMs: number,
  cacheSalt: string
): Promise<Program | null> {
  try {
    const raw = await readFile(cacheFilePath(sourceFilePath, cacheSalt), "utf8");
    const parsed = JSON.parse(raw) as CachedProgramFile;
    if (parsed.version !== PROGRAM_CACHE_VERSION || parsed.mtimeMs !== mtimeMs) {
      return null;
    }
    return parsed.program;
  } catch {
    return null;
  }
}

export async function storeCachedProgram(
  sourceFilePath: string,
  mtimeMs: number,
  cacheSalt: string,
  program: Program
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const payload: CachedProgramFile = {
    version: PROGRAM_CACHE_VERSION,
    mtimeMs,
    program
  };
  await writeFile(cacheFilePath(sourceFilePath, cacheSalt), JSON.stringify(payload), "utf8");
}
