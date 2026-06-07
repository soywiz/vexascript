import { existsSync, readFileSync, statSync } from "node:fs";
import type { ExprStatement, FunctionStatement, Identifier, Program, Statement } from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";

export interface NodeModuleTypings {
  /** All top-level declarations from the .d.ts (for externalDeclarations). */
  declarations: Statement[];
  /**
   * The name that the module's default/namespace export resolves to, i.e. the
   * right-hand side of `export = X` or the name of the sole top-level
   * namespace/class. Used to assign a named type to default and namespace
   * imports so members resolve in hover/completion.
   */
  defaultExportName: string | null;
}

interface CacheEntry {
  typingsPath: string;
  mtimeMs: number;
  result: NodeModuleTypings;
}

const cache = new Map<string, CacheEntry>();

function parseTypingsProgram(typingsPath: string): Program | null {
  const source = readFileSync(typingsPath, "utf8");
  const parsed = parseSource(source, { language: "typescript" });
  return parsed.ast ?? null;
}

/**
 * Detect the `export = X` name from a TypeScript declaration file. The
 * mylang parser represents `export = moment` as a top-level `ExprStatement`
 * whose expression is the exported `Identifier`.
 */
function detectExportEqualsName(ast: Program): string | null {
  for (const stmt of ast.body) {
    if (stmt.kind === "ExprStatement") {
      const expr = (stmt as ExprStatement).expression;
      if (expr && expr.kind === "Identifier") {
        return (expr as Identifier).name;
      }
    }
  }
  return null;
}

/**
 * Find the name of the first top-level namespace whose name matches a
 * top-level function, which is the common pattern for dual function+namespace
 * exports (like moment).
 */
function detectNamespaceName(ast: Program): string | null {
  const functionNames = new Set<string>();
  for (const stmt of ast.body) {
    if (stmt.kind === "FunctionStatement") {
      const name = (stmt as FunctionStatement).name?.name;
      if (name) functionNames.add(name);
    }
  }
  for (const stmt of ast.body) {
    if (stmt.kind === "NamespaceStatement") {
      const ns = stmt as { names?: { name: string }[] };
      const name = ns.names?.[0]?.name;
      if (name && functionNames.has(name)) return name;
    }
  }
  return null;
}

/**
 * Return the parsed typings for a node_modules package, cached by file path
 * and mtime. Returns `null` when the package or its declaration file cannot be
 * located.
 */
export function getNodeModuleTypings(
  importerFilePath: string,
  packageName: string
): NodeModuleTypings | null {
  const typingsPath = resolveNodeModulesTypingsPath(importerFilePath, packageName);
  if (!typingsPath || !existsSync(typingsPath)) {
    return null;
  }

  let mtimeMs: number;
  try {
    mtimeMs = statSync(typingsPath).mtimeMs;
  } catch {
    return null;
  }

  const cached = cache.get(typingsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  const ast = parseTypingsProgram(typingsPath);
  if (!ast) {
    return null;
  }

  const defaultExportName =
    detectExportEqualsName(ast) ??
    detectNamespaceName(ast) ??
    packageName;

  const result: NodeModuleTypings = {
    declarations: ast.body,
    defaultExportName,
  };

  cache.set(typingsPath, { typingsPath, mtimeMs, result });
  return result;
}
