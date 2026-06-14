import type { NamespaceStatement, Statement } from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { localVfs } from "compiler/localVfs";
import { dirname, resolve } from "compiler/utils/path";
import type { Vfs } from "compiler/vfs";

export interface AmbientTypesResult {
  globalDeclarations: Statement[];
  moduleDeclarations: Map<string, Statement[]>;
}

interface CacheEntry {
  entryPath: string;
  mtimeMs: number;
  result: AmbientTypesResult;
}

const cache = new Map<string, CacheEntry>();

function extractReferencePaths(source: string): string[] {
  const paths: string[] = [];
  const regex = /^\/\/\/\s*<reference\s+path="([^"]+)"/gm;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match[1]) paths.push(match[1]);
  }
  return paths;
}

async function parseAndCollect(
  filePath: string,
  visited: Set<string>,
  globalDeclarations: Statement[],
  moduleDeclarations: Map<string, Statement[]>,
  vfs: Vfs
): Promise<void> {
  if (visited.has(filePath)) {
    return;
  }
  visited.add(filePath);

  const source = await vfs.readFile(filePath);
  if (source === null) {
    return;
  }

  // Follow /// <reference path="..."> directives before adding statements from this file
  const dir = dirname(filePath);
  for (const refPath of extractReferencePaths(source)) {
    await parseAndCollect(resolve(dir, refPath), visited, globalDeclarations, moduleDeclarations, vfs);
  }

  const parsed = parseSource(source, { language: "typescript" });
  if (!parsed.ast) {
    return;
  }

  for (const stmt of parsed.ast.body) {
    if (stmt.kind === "NamespaceStatement") {
      const ns = stmt as NamespaceStatement;
      if (ns.externalModuleName) {
        const name = ns.externalModuleName.value;
        const existing = moduleDeclarations.get(name);
        if (existing) {
          existing.push(...ns.body.body);
        } else {
          moduleDeclarations.set(name, [...ns.body.body]);
        }
        continue;
      }
    }
    globalDeclarations.push(stmt);
  }
}

async function loadFromEntry(entryPath: string, vfs: Vfs): Promise<AmbientTypesResult> {
  const globalDeclarations: Statement[] = [];
  const moduleDeclarations = new Map<string, Statement[]>();
  await parseAndCollect(entryPath, new Set(), globalDeclarations, moduleDeclarations, vfs);
  return { globalDeclarations, moduleDeclarations };
}

/**
 * Loads ambient type declarations for the packages listed in tsconfig.json
 * `compilerOptions.types` (e.g. `["node"]`). For each entry:
 *  - Resolves the corresponding @types package from node_modules up the tree.
 *  - Recursively follows `/// <reference path>` directives.
 *  - Splits statements into global declarations and per-module declarations
 *    (from `declare module "name" { ... }` blocks).
 *
 * Results are cached by entry .d.ts path + mtime.
 */
export async function loadAmbientTypesForProject(
  importerFilePath: string | null,
  types: string[],
  options: { vfs?: Vfs } = {}
): Promise<AmbientTypesResult> {
  const vfs = options.vfs ?? localVfs;
  const globalDeclarations: Statement[] = [];
  const moduleDeclarations = new Map<string, Statement[]>();

  if (!importerFilePath || types.length === 0) {
    return { globalDeclarations, moduleDeclarations };
  }

  for (const typePkg of types) {
    const entryPath = await resolveNodeModulesTypingsPath(importerFilePath, typePkg, { vfs });
    if (!entryPath) {
      continue;
    }

    const mtimeMs = (await vfs.stat(entryPath))?.mtimeMs ?? -1;
    const cached = cache.get(entryPath);
    const result = cached && cached.mtimeMs === mtimeMs
      ? cached.result
      : await (async () => {
          const r = await loadFromEntry(entryPath, vfs);
          cache.set(entryPath, { entryPath, mtimeMs, result: r });
          return r;
        })();

    for (const stmt of result.globalDeclarations) {
      globalDeclarations.push(stmt);
    }
    for (const [name, stmts] of result.moduleDeclarations) {
      const existing = moduleDeclarations.get(name);
      if (existing) {
        existing.push(...stmts);
      } else {
        moduleDeclarations.set(name, [...stmts]);
      }
    }
  }

  return { globalDeclarations, moduleDeclarations };
}
