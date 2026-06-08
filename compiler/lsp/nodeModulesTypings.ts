import type { ExprStatement, FunctionStatement, Identifier, InterfaceStatement, NamespaceStatement, Program, Statement } from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import { resolveNodeModulesTypingsPath, type ModuleResolutionOptions } from "compiler/moduleResolution";
import { localVfs } from "compiler/vfs";
import { nodeRange } from "./ranges";
import type { Range } from "vscode-languageserver";

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

async function parseTypingsProgram(typingsPath: string, options: ModuleResolutionOptions): Promise<Program | null> {
  const source = await (options.vfs ?? localVfs).readFile(typingsPath);
  if (source === null) return null;
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
export async function getNodeModuleTypings(
  importerFilePath: string,
  packageName: string,
  options: ModuleResolutionOptions = {}
): Promise<NodeModuleTypings | null> {
  const vfs = options.vfs ?? localVfs;
  const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, packageName, { vfs });
  if (!typingsPath) {
    return null;
  }
  const typingsStat = await vfs.stat(typingsPath);
  if (!typingsStat || typingsStat.isFile === false) {
    return null;
  }
  const mtimeMs = typingsStat.mtimeMs;

  const cached = cache.get(typingsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  const ast = await parseTypingsProgram(typingsPath, { vfs });
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

export interface NodeModuleMemberLocation {
  typingsPath: string;
  range: Range;
}

/**
 * Searches recursively through `statements` (including inside namespace bodies)
 * for a declaration named `typeName`, then within it finds the member named
 * `memberName`. Returns the file location if found.
 *
 * This enables go-to-definition for members of types declared in node_modules
 * .d.ts files (e.g. `moment.parseZone` or `Moment.format`).
 */
export async function findNodeModuleMemberLocation(
  importerFilePath: string,
  packageName: string,
  typeName: string,
  memberName: string,
  options: ModuleResolutionOptions = {}
): Promise<NodeModuleMemberLocation | null> {
  const vfs = options.vfs ?? localVfs;
  const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, packageName, { vfs });
  if (!typingsPath) return null;

  const typings = await getNodeModuleTypings(importerFilePath, packageName, { vfs });
  if (!typings) return null;

  const range = findMemberRangeInStatements(typings.declarations, typeName, memberName);
  if (!range) return null;

  return { typingsPath, range };
}

/**
 * Searches `statements` (recursing into namespace bodies) for a type named
 * `typeName`, then looks for `memberName` within it. Returns the range of the
 * member declaration, or null if not found.
 */
function findMemberRangeInStatements(
  statements: Statement[],
  typeName: string,
  memberName: string
): Range | null {
  for (const stmt of statements) {
    const candidate =
      stmt.kind === "ExportStatement"
        ? (stmt as { declaration?: Statement }).declaration ?? stmt
        : stmt;

    // Namespace: if name matches, look for member inside it
    if (candidate.kind === "NamespaceStatement") {
      const ns = candidate as NamespaceStatement;
      const name = ns.names?.[0]?.name;
      if (name === typeName) {
        const memberRange = findMemberInNamespaceBody(ns.body.body, memberName);
        if (memberRange) return memberRange;
      }
      // Recurse into nested namespaces regardless of name match
      const nested = findMemberRangeInStatements(ns.body.body, typeName, memberName);
      if (nested) return nested;
    }

    // Interface: if name matches, look for member inside it
    if (candidate.kind === "InterfaceStatement") {
      const iface = candidate as InterfaceStatement;
      if (iface.name.name === typeName) {
        for (const member of iface.members) {
          if (member.name.name === memberName) {
            const range = nodeRange(member.name);
            if (range) return range;
          }
        }
      }
    }
  }
  return null;
}

function findMemberInNamespaceBody(
  body: Statement[],
  memberName: string
): Range | null {
  for (const child of body) {
    const decl =
      child.kind === "ExportStatement"
        ? (child as { declaration?: Statement }).declaration ?? child
        : child;

    if (decl.kind === "FunctionStatement") {
      const fn = decl as FunctionStatement;
      if (fn.name?.name === memberName) {
        const range = nodeRange(fn.name);
        if (range) return range;
      }
    } else if (decl.kind === "InterfaceStatement") {
      const iface = decl as InterfaceStatement;
      if (iface.name.name === memberName) {
        const range = nodeRange(iface.name);
        if (range) return range;
      }
    } else if (decl.kind === "NamespaceStatement") {
      const ns = decl as NamespaceStatement;
      const name = ns.names?.[0]?.name;
      if (name === memberName) {
        const nameNode = ns.names?.[0];
        if (nameNode) {
          const range = nodeRange(nameNode as Parameters<typeof nodeRange>[0]);
          if (range) return range;
        }
      }
    }
  }
  return null;
}
