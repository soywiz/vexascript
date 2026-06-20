import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  ExprStatement,
  NamespaceStatement,
  Statement
} from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { dirname, resolve } from "compiler/utils/path";
import { vfs, type Vfs } from "compiler/vfs";

export interface AmbientModuleLocation {
  filePath: string;
  line: number;
  character: number;
}

export interface AmbientTypesResult {
  globalDeclarations: Statement[];
  globalDeclarationLocations: Map<Statement, AmbientModuleLocation>;
  moduleDeclarations: Map<string, Statement[]>;
  moduleDeclarationLocations: Map<string, AmbientModuleLocation>;
}

interface CacheEntry {
  entryPath: string;
  mtimeMs: number;
  result: AmbientTypesResult;
}

const cache = new Map<string, CacheEntry>();
const projectCache = new Map<string, AmbientTypesResult>();

export function clearAmbientTypesCache(): void {
  cache.clear();
  projectCache.clear();
}

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
  globalDeclarationLocations: Map<Statement, AmbientModuleLocation>,
  moduleDeclarations: Map<string, Statement[]>,
  moduleDeclarationLocations: Map<string, AmbientModuleLocation>,
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
    await parseAndCollect(
      resolve(dir, refPath),
      visited,
      globalDeclarations,
      globalDeclarationLocations,
      moduleDeclarations,
      moduleDeclarationLocations,
      vfs
    );
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
        const moduleBody: Statement[] = [];
        for (const moduleStatement of ns.body.body) {
          const globalBlockStatements = extractGlobalBlockStatements(moduleStatement);
          if (globalBlockStatements) {
            for (const globalStatement of globalBlockStatements) {
              globalDeclarations.push(globalStatement);
              if (!globalDeclarationLocations.has(globalStatement)) {
                globalDeclarationLocations.set(globalStatement, {
                  filePath,
                  line: globalStatement.firstToken?.range.start.line ?? 0,
                  character: globalStatement.firstToken?.range.start.column ?? 0
                });
              }
            }
            continue;
          }
          moduleBody.push(moduleStatement);
        }
        const existing = moduleDeclarations.get(name);
        if (existing) {
          existing.push(...moduleBody);
        } else {
          moduleDeclarations.set(name, [...moduleBody]);
        }
        if (!moduleDeclarationLocations.has(name)) {
          moduleDeclarationLocations.set(name, {
            filePath,
            line: ns.firstToken?.range.start.line ?? 0,
            character: ns.firstToken?.range.start.column ?? 0
          });
        }
        continue;
      }
    }
    const globalBlockStatements = extractGlobalBlockStatements(stmt);
    if (globalBlockStatements) {
      for (const globalStatement of globalBlockStatements) {
        globalDeclarations.push(globalStatement);
        if (!globalDeclarationLocations.has(globalStatement)) {
          globalDeclarationLocations.set(globalStatement, {
            filePath,
            line: globalStatement.firstToken?.range.start.line ?? 0,
            character: globalStatement.firstToken?.range.start.column ?? 0
          });
        }
      }
      continue;
    }
    globalDeclarations.push(stmt);
    if (!globalDeclarationLocations.has(stmt)) {
      globalDeclarationLocations.set(stmt, {
        filePath,
        line: stmt.firstToken?.range.start.line ?? 0,
        character: stmt.firstToken?.range.start.column ?? 0
      });
    }
  }
}

function extractGlobalBlockStatements(statement: Statement): Statement[] | null {
  if (statement.kind !== "ExprStatement") {
    return null;
  }
  const expression = (statement as ExprStatement).expression;
  if (expression?.kind !== "CallExpression") {
    return null;
  }
  const call = expression as CallExpression;
  if (call.callee.kind !== "Identifier") {
    return null;
  }
  const callee = call.callee as unknown as { name: string };
  if (callee.name !== "global") {
    return null;
  }
  const body = call.arguments[0];
  if (body?.kind !== "ArrowFunctionExpression") {
    return null;
  }
  const block = (body as ArrowFunctionExpression).body;
  if (block.kind !== "BlockStatement") {
    return null;
  }
  return [...(block as BlockStatement).body];
}

async function loadFromEntry(entryPath: string, vfs: Vfs): Promise<AmbientTypesResult> {
  const globalDeclarations: Statement[] = [];
  const globalDeclarationLocations = new Map<Statement, AmbientModuleLocation>();
  const moduleDeclarations = new Map<string, Statement[]>();
  const moduleDeclarationLocations = new Map<string, AmbientModuleLocation>();
  await parseAndCollect(
    entryPath,
    new Set(),
    globalDeclarations,
    globalDeclarationLocations,
    moduleDeclarations,
    moduleDeclarationLocations,
    vfs
  );
  return { globalDeclarations, globalDeclarationLocations, moduleDeclarations, moduleDeclarationLocations };
}

async function resolveAmbientTypeEntryPath(
  importerFilePath: string,
  typeEntry: string,
  activeVfs: Vfs
): Promise<string | null> {
  if (
    typeEntry.startsWith("/")
    || typeEntry.startsWith(".")
    || typeEntry.includes("/")
    || typeEntry.includes("\\")
    || typeEntry.endsWith(".d.ts")
  ) {
    const directPath = typeEntry.startsWith("/")
      ? typeEntry
      : resolve(dirname(importerFilePath), typeEntry);
    return await activeVfs.fileExists(directPath) ? directPath : null;
  }

  return await resolveNodeModulesTypingsPath(importerFilePath, typeEntry, { vfs: activeVfs });
}

/**
 * Loads ambient type declarations for the packages listed in project config
 * `compilerOptions.types` (e.g. `["node"]`). For each entry:
 *  - Resolves the runtime package's own declaration entry from node_modules when
 *    the package publishes `types`/`typings`.
 *  - Falls back to the corresponding @types package from node_modules up the tree.
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
  const activeVfs = options.vfs ?? vfs();
  const globalDeclarations: Statement[] = [];
  const globalDeclarationLocations = new Map<Statement, AmbientModuleLocation>();
  const moduleDeclarations = new Map<string, Statement[]>();
  const moduleDeclarationLocations = new Map<string, AmbientModuleLocation>();

  if (!importerFilePath || types.length === 0) {
    return { globalDeclarations, globalDeclarationLocations, moduleDeclarations, moduleDeclarationLocations };
  }

  const resolvedEntries: Array<{ entryPath: string; result: AmbientTypesResult }> = [];
  for (const typePkg of types) {
    const entryPath = await resolveAmbientTypeEntryPath(importerFilePath, typePkg, activeVfs);
    if (!entryPath) {
      continue;
    }

    const mtimeMs = (await activeVfs.stat(entryPath))?.mtimeMs ?? -1;
    const cached = cache.get(entryPath);
    const result = cached && cached.mtimeMs === mtimeMs
      ? cached.result
      : await (async () => {
          const r = await loadFromEntry(entryPath, activeVfs);
          cache.set(entryPath, { entryPath, mtimeMs, result: r });
          return r;
        })();
    resolvedEntries.push({ entryPath, result });
  }

  const projectCacheKey = [
    dirname(importerFilePath),
    ...resolvedEntries.map(({ entryPath }) => entryPath)
  ].join("\0");
  const cachedProject = projectCache.get(projectCacheKey);
  if (cachedProject) {
    return cachedProject;
  }

  for (const { result } of resolvedEntries) {
    for (const stmt of result.globalDeclarations) {
      globalDeclarations.push(stmt);
    }
    for (const [stmt, loc] of result.globalDeclarationLocations) {
      if (!globalDeclarationLocations.has(stmt)) {
        globalDeclarationLocations.set(stmt, loc);
      }
    }
    for (const [name, stmts] of result.moduleDeclarations) {
      const existing = moduleDeclarations.get(name);
      if (existing) {
        existing.push(...stmts);
      } else {
        moduleDeclarations.set(name, [...stmts]);
      }
    }
    for (const [name, loc] of result.moduleDeclarationLocations) {
      if (!moduleDeclarationLocations.has(name)) {
        moduleDeclarationLocations.set(name, loc);
      }
    }
  }

  const projectResult = { globalDeclarations, globalDeclarationLocations, moduleDeclarations, moduleDeclarationLocations };
  projectCache.set(projectCacheKey, projectResult);
  return projectResult;
}
