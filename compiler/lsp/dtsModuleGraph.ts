/**
 * Shared, package-independent `.d.ts` declaration-graph primitives. These work
 * from any entry file + VFS and are meant to be reused by every loader that
 * follows a `.d.ts` graph — the node_modules typings loader
 * (`nodeModulesTypings.ts`) and the ambient/runtime types loader
 * (`ambientTypesLoader.ts`) — so the loaders do not drift apart.
 *
 * This is the module the `generalize-dts-declaration-loading` task grows the
 * general loader into; see `docs/tasks/generalize-dts-declaration-loading.md`.
 */
import type { Program } from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import type { ModuleResolutionOptions } from "compiler/moduleResolution";
import { dirname, extname, resolve } from "compiler/utils/path";
import { vfs } from "compiler/vfs";

interface SourceCacheEntry {
  mtimeMs: number;
  result: string | null;
}

interface ProgramCacheEntry {
  mtimeMs: number;
  result: Program | null;
}

const sourceCache = new Map<string, SourceCacheEntry>();
const programCache = new Map<string, ProgramCacheEntry>();

/** Clears the shared per-file `.d.ts` source and program caches. */
export function clearDtsModuleGraphCache(): void {
  sourceCache.clear();
  programCache.clear();
}

/** Reads a `.d.ts` source, cached by path + mtime. */
export async function readDtsSource(filePath: string, options: ModuleResolutionOptions = {}): Promise<string | null> {
  const activeVfs = options.vfs ?? vfs();
  const stat = await activeVfs.stat(filePath);
  const mtimeMs = stat?.mtimeMs ?? -1;
  const cached = sourceCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }
  const result = await activeVfs.readFile(filePath);
  sourceCache.set(filePath, { mtimeMs, result });
  return result;
}

/** Parses a `.d.ts` file into a Program, cached by path + mtime. */
export async function parseDtsProgram(filePath: string, options: ModuleResolutionOptions = {}): Promise<Program | null> {
  const activeVfs = options.vfs ?? vfs();
  const stat = await activeVfs.stat(filePath);
  const mtimeMs = stat?.mtimeMs ?? -1;
  const cached = programCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }
  const source = await readDtsSource(filePath, options);
  if (source === null) {
    programCache.set(filePath, { mtimeMs, result: null });
    return null;
  }
  const parsed = parseSource(source, { language: "typescript" });
  const result = parsed.ast ?? null;
  programCache.set(filePath, { mtimeMs, result });
  return result;
}

/**
 * Resolves a relative module specifier against an importing `.d.ts` file to a
 * concrete declaration file, trying declaration siblings of JS files, explicit
 * extensions, and `index.d.ts`/`index.ts` directory entries. Returns null for
 * non-relative specifiers (those are a resolution-policy concern, e.g. the
 * node_modules adapter).
 */
export async function resolveRelativeDtsPath(
  importerFilePath: string,
  specifier: string,
  options: ModuleResolutionOptions = {}
): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const activeVfs = options.vfs ?? vfs();
  const basePath = resolve(dirname(importerFilePath), specifier);
  const baseExt = extname(basePath);
  const declarationSiblingCandidates = [".js", ".mjs", ".cjs", ".jsx"].includes(baseExt)
    ? [
        `${basePath.slice(0, -baseExt.length)}.d.ts`,
        `${basePath.slice(0, -baseExt.length)}.ts`
      ]
    : [];
  const candidates = [
    ...declarationSiblingCandidates,
    basePath,
    extname(basePath) === "" ? `${basePath}.d.ts` : "",
    extname(basePath) === "" ? `${basePath}.ts` : "",
    resolve(basePath, "index.d.ts"),
    resolve(basePath, "index.ts")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const stat = await activeVfs.stat(candidate).catch(() => null);
    if (stat?.isDirectory) {
      continue;
    }
    if (stat?.isFile || await activeVfs.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Extracts the targets of `/// <reference path="..."/>` directives from a
 * `.d.ts` source. Tolerates single or double quotes and leading whitespace and
 * does not require the closing `/>`, so every loader follows references
 * identically. Results are de-duplicated and trimmed, in source order.
 */
export function extractTripleSlashReferencePaths(source: string): string[] {
  const referencePattern = /^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["']/gm;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(referencePattern)) {
    const path = match[1]?.trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
