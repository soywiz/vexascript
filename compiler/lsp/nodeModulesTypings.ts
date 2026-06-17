import type {
  ClassStatement,
  EnumStatement,
  ExprStatement,
  ExportStatement,
  FunctionStatement,
  Identifier,
  InterfaceStatement,
  NamespaceStatement,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { parseSource } from "compiler/pipeline/parse";
import { resolveNodeModulesTypingsPath, type ModuleResolutionOptions } from "compiler/moduleResolution";
import { vfs } from "compiler/vfs";
import { dirname, extname, resolve } from "compiler/utils/path";
import { nodeRange } from "./ranges";
import type { Range } from "vscode-languageserver";

export interface NodeModuleTypings {
  /** All top-level declarations from the .d.ts (for externalDeclarations). */
  declarations: Statement[];
  /** Source file for each collected declaration, preserving reexport origins. */
  declarationEntries: NodeModuleDeclarationEntry[];
  /**
   * The name that the module's default/namespace export resolves to, i.e. the
   * right-hand side of `export = X` or the name of the sole top-level
   * namespace/class. Used to assign a named type to default and namespace
   * imports so members resolve in hover/completion.
   */
  defaultExportName: string | null;
}

interface NodeModuleDeclarationEntry {
  statement: Statement;
  typingsPath: string;
}

interface CacheEntry {
  typingsPath: string;
  mtimeMs: number;
  result: NodeModuleTypings;
}

const cache = new Map<string, CacheEntry>();

async function parseTypingsProgram(typingsPath: string, options: ModuleResolutionOptions): Promise<Program | null> {
  const source = await (options.vfs ?? vfs()).readFile(typingsPath);
  if (source === null) return null;
  const parsed = parseSource(source, { language: "typescript" });
  return parsed.ast ?? null;
}

async function resolveRelativeTypingsPath(
  importerTypingsPath: string,
  specifier: string,
  options: ModuleResolutionOptions
): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const activeVfs = options.vfs ?? vfs();
  const basePath = resolve(dirname(importerTypingsPath), specifier);
  const candidates = [
    basePath,
    extname(basePath) === "" ? `${basePath}.d.ts` : "",
    extname(basePath) === "" ? `${basePath}.ts` : "",
    resolve(basePath, "index.d.ts"),
    resolve(basePath, "index.ts")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await activeVfs.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function collectTypingsDeclarations(
  typingsPath: string,
  options: ModuleResolutionOptions,
  visited: Set<string>
): Promise<NodeModuleDeclarationEntry[]> {
  if (visited.has(typingsPath)) {
    return [];
  }
  visited.add(typingsPath);

  const ast = await parseTypingsProgram(typingsPath, options);
  if (!ast) {
    return [];
  }

  const declarations: NodeModuleDeclarationEntry[] = ast.body.map((statement) => ({
    statement,
    typingsPath
  }));
  for (const statement of ast.body) {
    if (statement.kind !== "ExportStatement") {
      continue;
    }
    const exportStatement = statement as ExportStatement;
    if (!exportStatement.from?.value || (!exportStatement.exportAll && (!exportStatement.specifiers || exportStatement.specifiers.length === 0))) {
      continue;
    }
    const targetTypingsPath = await resolveRelativeTypingsPath(typingsPath, exportStatement.from.value, options);
    if (!targetTypingsPath) {
      continue;
    }
    const reexportedDeclarations = await collectTypingsDeclarations(targetTypingsPath, options, visited);
    if (exportStatement.exportAll) {
      declarations.push(...reexportedDeclarations);
      continue;
    }
    const exportedNames = new Set(exportStatement.specifiers?.map((specifier) => specifier.local?.name ?? specifier.exported.name) ?? []);
    for (const declaration of reexportedDeclarations) {
      const name = declarationMemberName(declaration.statement);
      if (name && exportedNames.has(name)) {
        declarations.push(declaration);
      }
    }
  }

  return declarations;
}

function declarationMemberName(statement: Statement): string | null {
  const declaration =
    statement.kind === "ExportStatement"
      ? (statement as { declaration?: Statement }).declaration ?? statement
      : statement;

  if (declaration.kind === "FunctionStatement") {
    return (declaration as FunctionStatement).name?.name ?? null;
  }
  if (declaration.kind === "InterfaceStatement") {
    return (declaration as InterfaceStatement).name.name;
  }
  if (declaration.kind === "ClassStatement") {
    return (declaration as ClassStatement).name.name;
  }
  if (declaration.kind === "EnumStatement") {
    return (declaration as EnumStatement).name.name;
  }
  if (declaration.kind === "TypeAliasStatement") {
    return (declaration as TypeAliasStatement).name.name;
  }
  if (declaration.kind === "VarStatement") {
    const identifiers = bindingIdentifiers((declaration as VarStatement).name);
    return identifiers[0]?.name ?? null;
  }
  if (declaration.kind === "NamespaceStatement") {
    return (declaration as NamespaceStatement).names?.[0]?.name ?? null;
  }
  return null;
}

/**
 * Detect the `export = X` name from a TypeScript declaration file. The
 * vexa parser represents `export = moment` as a top-level `ExprStatement`
 * whose expression is the exported `Identifier`.
 */
function detectExportEqualsName(ast: Program): string | null {
  for (const stmt of ast.body) {
    if (stmt.kind === "ExportStatement") {
      const declaration = (stmt as { default?: boolean; declaration?: Statement }).declaration;
      if ((stmt as { default?: boolean }).default === true && declaration?.kind === "FunctionStatement") {
        return (declaration as FunctionStatement).name.name;
      }
    }
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
  const activeVfs = options.vfs ?? vfs();
  const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, packageName, { vfs: activeVfs });
  if (!typingsPath) {
    return null;
  }
  const typingsStat = await activeVfs.stat(typingsPath);
  if (!typingsStat || typingsStat.isFile === false) {
    return null;
  }
  const mtimeMs = typingsStat.mtimeMs;

  const cached = cache.get(typingsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  const ast = await parseTypingsProgram(typingsPath, { vfs: activeVfs });
  if (!ast) {
    return null;
  }
  const declarationEntries = await collectTypingsDeclarations(typingsPath, { vfs: activeVfs }, new Set<string>());
  const declarations = declarationEntries.map((entry) => entry.statement);

  const defaultExportName =
    detectExportEqualsName(ast) ??
    detectNamespaceName(ast) ??
    packageName;

  const result: NodeModuleTypings = {
    declarations,
    declarationEntries,
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
  const activeVfs = options.vfs ?? vfs();
  const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, packageName, { vfs: activeVfs });
  if (!typingsPath) return null;

  const typings = await getNodeModuleTypings(importerFilePath, packageName, { vfs: activeVfs });
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

function namedExportRangeFromStatement(statement: Statement, exportName: string): Range | null {
  const declaration =
    statement.kind === "ExportStatement"
      ? (statement as { declaration?: Statement }).declaration ?? statement
      : statement;

  switch (declaration.kind) {
    case "FunctionStatement":
    case "InterfaceStatement":
    case "ClassStatement":
    case "EnumStatement":
    case "TypeAliasStatement": {
      const namedDeclaration = declaration as
        | FunctionStatement
        | InterfaceStatement
        | ClassStatement
        | EnumStatement
        | TypeAliasStatement;
      return namedDeclaration.name.name === exportName ? nodeRange(namedDeclaration.name) : null;
    }
    case "NamespaceStatement": {
      const namespace = declaration as NamespaceStatement;
      const nameNode = namespace.names?.[0];
      return nameNode?.name === exportName ? nodeRange(nameNode as Parameters<typeof nodeRange>[0]) : null;
    }
    case "VarStatement": {
      const variable = declaration as VarStatement;
      const identifier = [
        ...bindingIdentifiers(variable.name),
        ...(variable.declarations ?? []).flatMap((item) => bindingIdentifiers(item.name))
      ].find((candidate) => candidate.name === exportName);
      return identifier ? nodeRange(identifier) : null;
    }
    default:
      return null;
  }
}

export async function findNodeModuleExportLocation(
  importerFilePath: string,
  packageName: string,
  exportName: string,
  options: ModuleResolutionOptions = {}
): Promise<NodeModuleMemberLocation | null> {
  const activeVfs = options.vfs ?? vfs();
  const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, packageName, { vfs: activeVfs });
  if (!typingsPath) {
    return null;
  }

  const typings = await getNodeModuleTypings(importerFilePath, packageName, { vfs: activeVfs });
  if (!typings) {
    return null;
  }

  for (const entry of typings.declarationEntries) {
    const range = namedExportRangeFromStatement(entry.statement, exportName);
    if (range) {
      return { typingsPath: entry.typingsPath, range };
    }
  }

  return null;
}
