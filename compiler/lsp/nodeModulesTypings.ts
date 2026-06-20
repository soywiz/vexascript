import type {
  ClassStatement,
  EnumStatement,
  ExprStatement,
  ExportStatement,
  FunctionStatement,
  Identifier,
  ImportStatement,
  InterfaceStatement,
  NamespaceStatement,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { parseSource } from "compiler/pipeline/parse";
import {
  clearNodeModulesTypingsPathCache,
  resolveNodeModulesTypingsPath,
  type ModuleResolutionOptions
} from "compiler/moduleResolution";
import { vfs } from "compiler/vfs";
import { dirname, extname, resolve } from "compiler/utils/path";
import { nodeRange } from "./ranges";
import type { Range } from "vscode-languageserver";
import { splitTopLevelTypeText } from "compiler/analysis/typeNames";

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

interface SourceCacheEntry {
  mtimeMs: number;
  result: string | null;
}

interface ProgramCacheEntry {
  mtimeMs: number;
  result: Program | null;
}

const cache = new Map<string, CacheEntry>();
const sourceCache = new Map<string, SourceCacheEntry>();
const programCache = new Map<string, ProgramCacheEntry>();

export function clearNodeModuleTypingsCache(): void {
  cache.clear();
  sourceCache.clear();
  programCache.clear();
  clearNodeModulesTypingsPathCache();
}

async function parseTypingsProgram(typingsPath: string, options: ModuleResolutionOptions): Promise<Program | null> {
  const activeVfs = options.vfs ?? vfs();
  const stat = await activeVfs.stat(typingsPath);
  const mtimeMs = stat?.mtimeMs ?? -1;
  const cached = programCache.get(typingsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  const source = await activeVfs.readFile(typingsPath);
  if (source === null) return null;
  const parsed = parseSource(source, { language: "typescript" });
  const result = parsed.ast ?? null;
  programCache.set(typingsPath, { mtimeMs, result });
  return result;
}

async function readTypingsSource(typingsPath: string, options: ModuleResolutionOptions): Promise<string | null> {
  const activeVfs = options.vfs ?? vfs();
  const stat = await activeVfs.stat(typingsPath);
  const mtimeMs = stat?.mtimeMs ?? -1;
  const cached = sourceCache.get(typingsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  const result = await activeVfs.readFile(typingsPath);
  sourceCache.set(typingsPath, { mtimeMs, result });
  return result;
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

async function resolveReexportedTypingsPath(
  importerTypingsPath: string,
  specifier: string,
  options: ModuleResolutionOptions
): Promise<string | null> {
  if (specifier.startsWith(".")) {
    return resolveRelativeTypingsPath(importerTypingsPath, specifier, options);
  }
  return resolveNodeModulesTypingsPath(importerTypingsPath, specifier, options);
}

function extractReferencedTypingsSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const referencePathPattern = /^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["'][^>]*\/>\s*$/gm;

  for (const match of source.matchAll(referencePathPattern)) {
    const specifier = match[1]?.trim();
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

function extractImportedTypingsSpecifiers(ast: Program): string[] {
  const specifiers = new Set<string>();

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const specifier = importStatement.from?.value?.trim();
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

function asExportedTypingsEntry(entry: NodeModuleDeclarationEntry): NodeModuleDeclarationEntry {
  return entry.statement.kind === "ExportStatement"
    ? entry
    : {
        statement: { kind: "ExportStatement", declaration: entry.statement } as ExportStatement,
        typingsPath: entry.typingsPath
      };
}

function nodeModuleDeclarationName(entry: NodeModuleDeclarationEntry): string | null {
  const statement = entry.statement.kind === "ExportStatement"
    ? (entry.statement as ExportStatement).declaration ?? entry.statement
    : entry.statement;
  const named = statement as { name?: { kind?: string; name?: string } };
  return named.name?.kind === "Identifier" ? named.name.name ?? null : null;
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
  const source = await readTypingsSource(typingsPath, options);

  const declarations: NodeModuleDeclarationEntry[] = ast.body.map((statement) => ({
    statement,
    typingsPath
  }));
  const supportSpecifiers = new Set<string>([
    ...(source ? extractReferencedTypingsSpecifiers(source) : []),
    ...extractImportedTypingsSpecifiers(ast)
  ]);
  for (const specifier of supportSpecifiers) {
    const targetTypingsPath = await resolveReexportedTypingsPath(typingsPath, specifier, options);
    if (!targetTypingsPath) {
      continue;
    }
    declarations.push(...await collectTypingsDeclarations(targetTypingsPath, options, visited));
  }
  for (const statement of ast.body) {
    if (statement.kind !== "ExportStatement") {
      continue;
    }
    const exportStatement = statement as ExportStatement;
    if (!exportStatement.from?.value || (!exportStatement.exportAll && (!exportStatement.specifiers || exportStatement.specifiers.length === 0))) {
      continue;
    }
    const targetTypingsPath = await resolveReexportedTypingsPath(typingsPath, exportStatement.from.value, options);
    if (!targetTypingsPath) {
      continue;
    }
    const reexportedDeclarations = await collectTypingsDeclarations(targetTypingsPath, options, visited);
    if (exportStatement.exportAll) {
      declarations.push(...reexportedDeclarations.map(asExportedTypingsEntry));
      continue;
    }
    const exportedNames = new Set<string>();
    for (const specifier of exportStatement.specifiers ?? []) {
      exportedNames.add(specifier.exported.name);
      if (specifier.local?.name) {
        exportedNames.add(specifier.local.name);
      }
    }
    for (const entry of reexportedDeclarations) {
      const declarationName = nodeModuleDeclarationName(entry);
      if (declarationName && exportedNames.has(declarationName)) {
        declarations.push(asExportedTypingsEntry(entry));
        continue;
      }
      declarations.push(entry);
    }
  }

  return declarations;
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

  const location = findMemberLocationInDeclarationEntries(typings.declarationEntries, typeName, memberName);
  if (location) {
    return location;
  }

  const range = findMemberRangeInStatements(typings.declarations, typeName, memberName);
  if (!range) return null;

  return { typingsPath, range };
}

function findQualifiedMemberLocationInDeclarationEntries(
  declarationEntries: readonly NodeModuleDeclarationEntry[],
  qualifiedTypeName: string,
  memberName: string,
  visitedQualifiedTypeNames = new Set<string>()
): NodeModuleMemberLocation | null {
  if (visitedQualifiedTypeNames.has(qualifiedTypeName)) {
    return null;
  }
  visitedQualifiedTypeNames.add(qualifiedTypeName);
  const parts = qualifiedTypeName.split(".").filter(Boolean);
  if (parts.length <= 1) {
    return null;
  }

  const search = (
    entries: readonly NodeModuleDeclarationEntry[],
    index: number
  ): NodeModuleMemberLocation | null => {
    const targetPart = parts[index];
    if (!targetPart) {
      return null;
    }

    for (const entry of entries) {
      const candidate =
        entry.statement.kind === "ExportStatement"
          ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
          : entry.statement;

      if (candidate.kind === "NamespaceStatement") {
        const namespace = candidate as NamespaceStatement;
        const name = namespace.names?.[0]?.name;
        const childEntries = namespace.body.body.map((statement) => ({ statement, typingsPath: entry.typingsPath }));

        if (!name) {
          const nested = search(childEntries, index);
          if (nested) {
            return nested;
          }
          continue;
        }

        if (name === targetPart) {
          const nested = search(childEntries, Math.min(index + 1, parts.length - 1));
          if (nested) {
            return nested;
          }
        }

        const nested = search(childEntries, index);
        if (nested) {
          return nested;
        }
        continue;
      }

      if (index !== parts.length - 1) {
        continue;
      }

      if (candidate.kind === "InterfaceStatement") {
        const iface = candidate as InterfaceStatement;
        if (iface.name.name !== targetPart) {
          continue;
        }
        for (const member of iface.members) {
          if (member.name.name === memberName) {
            const range = nodeRange(member.name);
            if (range) {
              return { typingsPath: entry.typingsPath, range };
            }
          }
        }
        for (const parentType of iface.extendsTypes ?? []) {
          const inheritedTypeName = baseTypeName(parentType.name);
          const inherited = inheritedTypeName.includes(".")
            ? findQualifiedMemberLocationInDeclarationEntries(
              declarationEntries,
              inheritedTypeName,
              memberName,
              new Set(visitedQualifiedTypeNames)
            )
            : findMemberLocationInDeclarationEntries(declarationEntries, inheritedTypeName, memberName);
          if (inherited) {
            return inherited;
          }
        }
      }

      if (candidate.kind === "ClassStatement") {
        const klass = candidate as ClassStatement;
        if (klass.name.name !== targetPart) {
          continue;
        }
        for (const member of klass.members) {
          if (member.name.name === memberName) {
            const range = nodeRange(member.name);
            if (range) {
              return { typingsPath: entry.typingsPath, range };
            }
          }
        }
      }

      if (candidate.kind === "TypeAliasStatement") {
        const typeAlias = candidate as TypeAliasStatement;
        if (typeAlias.name.name !== targetPart) {
          continue;
        }
        for (const referencedTypeName of referencedTypeNames(typeAlias.targetType.name)) {
          const inherited = referencedTypeName.includes(".")
            ? findQualifiedMemberLocationInDeclarationEntries(
              declarationEntries,
              referencedTypeName,
              memberName,
              new Set(visitedQualifiedTypeNames)
            )
            : findMemberLocationInDeclarationEntries(
              declarationEntries,
              referencedTypeName,
              memberName,
              new Set(visitedQualifiedTypeNames)
            );
          if (inherited) {
            return inherited;
          }
        }
      }
    }

    return null;
  };

  return search(declarationEntries, 0);
}

function findMemberLocationInDeclarationEntries(
  declarationEntries: readonly NodeModuleDeclarationEntry[],
  typeName: string,
  memberName: string,
  visitedTypeNames = new Set<string>()
): NodeModuleMemberLocation | null {
  if (typeName.includes(".")) {
    const qualified = findQualifiedMemberLocationInDeclarationEntries(
      declarationEntries,
      typeName,
      memberName
    );
    if (qualified) {
      return qualified;
    }
  }

  for (const candidateTypeName of candidateTypeNames(typeName)) {
    for (const entry of declarationEntries) {
      const candidate =
        entry.statement.kind === "ExportStatement"
          ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
          : entry.statement;

      if (candidate.kind === "NamespaceStatement") {
        const namespace = candidate as NamespaceStatement;
        const name = namespace.names?.[0]?.name;
        if (name === candidateTypeName) {
          const memberRange = findMemberInNamespaceBody(namespace.body.body, memberName);
          if (memberRange) {
            return { typingsPath: entry.typingsPath, range: memberRange };
          }
        }
        const nestedTypeName = name ? nestedTypeNameForNamespace(candidateTypeName, name) : candidateTypeName;
        const nested = findMemberLocationInDeclarationEntries(
          namespace.body.body.map((statement) => ({ statement, typingsPath: entry.typingsPath })),
          nestedTypeName,
          memberName,
          visitedTypeNames
        );
        if (nested) {
          return nested;
        }
      }

      if (candidate.kind === "InterfaceStatement") {
        const iface = candidate as InterfaceStatement;
        if (iface.name.name === candidateTypeName) {
          if (visitedTypeNames.has(candidateTypeName)) {
            continue;
          }
          const nextVisitedTypeNames = new Set(visitedTypeNames);
          nextVisitedTypeNames.add(candidateTypeName);
          for (const member of iface.members) {
            if (member.name.name === memberName) {
              const range = nodeRange(member.name);
              if (range) {
                return { typingsPath: entry.typingsPath, range };
              }
            }
          }
          for (const parentType of iface.extendsTypes ?? []) {
            const inherited = findMemberLocationInDeclarationEntries(
              declarationEntries,
              baseTypeName(parentType.name),
              memberName,
              nextVisitedTypeNames
            );
            if (inherited) {
              return inherited;
            }
          }
        }
      }

      if (candidate.kind === "ClassStatement") {
        const klass = candidate as ClassStatement;
        if (klass.name.name === candidateTypeName) {
          if (visitedTypeNames.has(candidateTypeName)) {
            continue;
          }
          const nextVisitedTypeNames = new Set(visitedTypeNames);
          nextVisitedTypeNames.add(candidateTypeName);
          for (const member of klass.members) {
            if (member.name.name !== memberName) {
              continue;
            }
            const range = nodeRange(member.name);
            if (range) {
              return { typingsPath: entry.typingsPath, range };
            }
          }
          if (klass.extendsType) {
            const inherited = findMemberLocationInDeclarationEntries(
              declarationEntries,
              baseTypeName(klass.extendsType.name),
              memberName,
              nextVisitedTypeNames
            );
            if (inherited) {
              return inherited;
            }
          }
          for (const implementedType of klass.implementsTypes ?? []) {
            const inherited = findMemberLocationInDeclarationEntries(
              declarationEntries,
              baseTypeName(implementedType.name),
              memberName,
              nextVisitedTypeNames
            );
            if (inherited) {
              return inherited;
            }
          }
        }
      }

      if (candidate.kind === "TypeAliasStatement") {
        const typeAlias = candidate as TypeAliasStatement;
        if (typeAlias.name.name !== candidateTypeName) {
          continue;
        }
        if (visitedTypeNames.has(candidateTypeName)) {
          continue;
        }
        const nextVisitedTypeNames = new Set(visitedTypeNames);
        nextVisitedTypeNames.add(candidateTypeName);
        for (const referencedTypeName of referencedTypeNames(typeAlias.targetType.name)) {
          const inherited = findMemberLocationInDeclarationEntries(
            declarationEntries,
            referencedTypeName,
            memberName,
            nextVisitedTypeNames
          );
          if (inherited) {
            return inherited;
          }
        }
      }
    }
  }

  return null;
}

function findStructuralMemberLocationInDeclarationEntries(
  declarationEntries: readonly NodeModuleDeclarationEntry[],
  memberName: string,
  declarationKinds: ReadonlySet<"InterfaceStatement" | "ClassStatement">,
  visitedNamespaces = new Set<Statement>()
): NodeModuleMemberLocation | null {
  for (let index = declarationEntries.length - 1; index >= 0; index -= 1) {
    const entry = declarationEntries[index]!;
    const candidate =
      entry.statement.kind === "ExportStatement"
        ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
        : entry.statement;

    if (candidate.kind === "NamespaceStatement") {
      if (visitedNamespaces.has(candidate)) {
        continue;
      }
      const nextVisitedNamespaces = new Set(visitedNamespaces);
      nextVisitedNamespaces.add(candidate);
      const nested = findStructuralMemberLocationInDeclarationEntries(
        (candidate as NamespaceStatement).body.body.map((statement) => ({
          statement,
          typingsPath: entry.typingsPath
        })),
        memberName,
        declarationKinds,
        nextVisitedNamespaces
      );
      if (nested) {
        return nested;
      }
      continue;
    }

    if (!declarationKinds.has(candidate.kind as "InterfaceStatement" | "ClassStatement")) {
      continue;
    }

    const members = candidate.kind === "InterfaceStatement"
      ? (candidate as InterfaceStatement).members
      : candidate.kind === "ClassStatement"
        ? (candidate as ClassStatement).members
        : [];
    for (const member of members) {
      if (member.name.name !== memberName) {
        continue;
      }
      const range = nodeRange(member.name);
      if (range) {
        return { typingsPath: entry.typingsPath, range };
      }
    }
  }

  return null;
}

export async function findNodeModuleStructuralMemberLocation(
  importerFilePath: string,
  packageName: string,
  memberName: string,
  options: ModuleResolutionOptions = {}
): Promise<NodeModuleMemberLocation | null> {
  const activeVfs = options.vfs ?? vfs();
  const typings = await getNodeModuleTypings(importerFilePath, packageName, { vfs: activeVfs });
  if (!typings) return null;

  return findStructuralMemberLocationInDeclarationEntries(
    typings.declarationEntries,
    memberName,
    new Set(["InterfaceStatement"])
  ) ?? findStructuralMemberLocationInDeclarationEntries(
    typings.declarationEntries,
    memberName,
    new Set(["ClassStatement"])
  );
}

/**
 * Searches `statements` (recursing into namespace bodies) for a type named
 * `typeName`, then looks for `memberName` within it. Returns the range of the
 * member declaration, or null if not found.
 */
function findQualifiedMemberRangeInStatements(
  statements: Statement[],
  qualifiedTypeName: string,
  memberName: string,
  visitedQualifiedTypeNames = new Set<string>()
): Range | null {
  if (visitedQualifiedTypeNames.has(qualifiedTypeName)) {
    return null;
  }
  visitedQualifiedTypeNames.add(qualifiedTypeName);
  const parts = qualifiedTypeName.split(".").filter(Boolean);
  if (parts.length <= 1) {
    return null;
  }

  const search = (entries: Statement[], index: number): Range | null => {
    const targetPart = parts[index];
    if (!targetPart) {
      return null;
    }

    for (const statement of entries) {
      const candidate =
        statement.kind === "ExportStatement"
          ? (statement as { declaration?: Statement }).declaration ?? statement
          : statement;

      if (candidate.kind === "NamespaceStatement") {
        const namespace = candidate as NamespaceStatement;
        const name = namespace.names?.[0]?.name;

        if (!name) {
          const nested = search(namespace.body.body, index);
          if (nested) {
            return nested;
          }
          continue;
        }

        if (name === targetPart) {
          const nested = search(namespace.body.body, Math.min(index + 1, parts.length - 1));
          if (nested) {
            return nested;
          }
        }

        const nested = search(namespace.body.body, index);
        if (nested) {
          return nested;
        }
        continue;
      }

      if (index !== parts.length - 1) {
        continue;
      }

      if (candidate.kind === "InterfaceStatement") {
        const iface = candidate as InterfaceStatement;
        if (iface.name.name !== targetPart) {
          continue;
        }
        for (const member of iface.members) {
          if (member.name.name === memberName) {
            const range = nodeRange(member.name);
            if (range) {
              return range;
            }
          }
        }
        for (const parentType of iface.extendsTypes ?? []) {
          const inheritedTypeName = baseTypeName(parentType.name);
          const inherited = inheritedTypeName.includes(".")
            ? findQualifiedMemberRangeInStatements(
              statements,
              inheritedTypeName,
              memberName,
              new Set(visitedQualifiedTypeNames)
            )
            : findMemberRangeInStatements(statements, inheritedTypeName, memberName);
          if (inherited) {
            return inherited;
          }
        }
      }

      if (candidate.kind === "ClassStatement") {
        const klass = candidate as ClassStatement;
        if (klass.name.name !== targetPart) {
          continue;
        }
        for (const member of klass.members) {
          if (member.name.name === memberName) {
            const range = nodeRange(member.name);
            if (range) {
              return range;
            }
          }
        }
      }

      if (candidate.kind === "TypeAliasStatement") {
        const typeAlias = candidate as TypeAliasStatement;
        if (typeAlias.name.name !== targetPart) {
          continue;
        }
        for (const referencedTypeName of referencedTypeNames(typeAlias.targetType.name)) {
          const inherited = referencedTypeName.includes(".")
            ? findQualifiedMemberRangeInStatements(
              statements,
              referencedTypeName,
              memberName,
              new Set(visitedQualifiedTypeNames)
            )
            : findMemberRangeInStatements(statements, referencedTypeName, memberName);
          if (inherited) {
            return inherited;
          }
        }
      }
    }

    return null;
  };

  return search(statements, 0);
}

function findMemberRangeInStatements(
  statements: Statement[],
  typeName: string,
  memberName: string,
  visitedTypeNames = new Set<string>()
): Range | null {
  if (typeName.includes(".")) {
    const qualified = findQualifiedMemberRangeInStatements(statements, typeName, memberName);
    if (qualified) {
      return qualified;
    }
  }

  for (const candidateTypeName of candidateTypeNames(typeName)) {
    for (const stmt of statements) {
      const candidate =
        stmt.kind === "ExportStatement"
          ? (stmt as { declaration?: Statement }).declaration ?? stmt
          : stmt;

      if (candidate.kind === "NamespaceStatement") {
        const ns = candidate as NamespaceStatement;
        const name = ns.names?.[0]?.name;
        if (name === candidateTypeName) {
          const memberRange = findMemberInNamespaceBody(ns.body.body, memberName);
          if (memberRange) {
            return memberRange;
          }
        }
        const nestedTypeName = name ? nestedTypeNameForNamespace(candidateTypeName, name) : candidateTypeName;
        const nested = findMemberRangeInStatements(
          ns.body.body,
          nestedTypeName,
          memberName,
          visitedTypeNames
        );
        if (nested) {
          return nested;
        }
      }

      if (candidate.kind === "InterfaceStatement") {
        const iface = candidate as InterfaceStatement;
        if (iface.name.name === candidateTypeName) {
          if (visitedTypeNames.has(candidateTypeName)) {
            continue;
          }
          const nextVisitedTypeNames = new Set(visitedTypeNames);
          nextVisitedTypeNames.add(candidateTypeName);
          for (const member of iface.members) {
            if (member.name.name === memberName) {
              const range = nodeRange(member.name);
              if (range) {
                return range;
              }
            }
          }
          for (const parentType of iface.extendsTypes ?? []) {
            const inherited = findMemberRangeInStatements(
              statements,
              baseTypeName(parentType.name),
              memberName,
              nextVisitedTypeNames
            );
            if (inherited) {
              return inherited;
            }
          }
        }
      }

      if (candidate.kind === "ClassStatement") {
        const klass = candidate as ClassStatement;
        if (klass.name.name === candidateTypeName) {
          if (visitedTypeNames.has(candidateTypeName)) {
            continue;
          }
          const nextVisitedTypeNames = new Set(visitedTypeNames);
          nextVisitedTypeNames.add(candidateTypeName);
          for (const member of klass.members) {
            if (member.name.name !== memberName) {
              continue;
            }
            const range = nodeRange(member.name);
            if (range) {
              return range;
            }
          }
          if (klass.extendsType) {
            const inherited = findMemberRangeInStatements(
              statements,
              baseTypeName(klass.extendsType.name),
              memberName,
              nextVisitedTypeNames
            );
            if (inherited) {
              return inherited;
            }
          }
          for (const implementedType of klass.implementsTypes ?? []) {
            const inherited = findMemberRangeInStatements(
              statements,
              baseTypeName(implementedType.name),
              memberName,
              nextVisitedTypeNames
            );
            if (inherited) {
              return inherited;
            }
          }
        }
      }

      if (candidate.kind === "TypeAliasStatement") {
        const typeAlias = candidate as TypeAliasStatement;
        if (typeAlias.name.name !== candidateTypeName) {
          continue;
        }
        if (visitedTypeNames.has(candidateTypeName)) {
          continue;
        }
        const nextVisitedTypeNames = new Set(visitedTypeNames);
        nextVisitedTypeNames.add(candidateTypeName);
        for (const referencedTypeName of referencedTypeNames(typeAlias.targetType.name)) {
          const inherited = findMemberRangeInStatements(
            statements,
            referencedTypeName,
            memberName,
            nextVisitedTypeNames
          );
          if (inherited) {
            return inherited;
          }
        }
      }
    }
  }
  return null;
}

function baseTypeName(typeName: string): string {
  return typeName.split("<")[0]?.trim() ?? typeName;
}

function candidateTypeNames(typeName: string): string[] {
  const names = [typeName];
  const lastQualifierIndex = typeName.lastIndexOf(".");
  if (lastQualifierIndex >= 0) {
    names.push(typeName.slice(lastQualifierIndex + 1));
  }
  return names;
}

function referencedTypeNames(typeName: string): string[] {
  const unionParts = splitTopLevelTypeText(typeName, "|");
  if (unionParts.length > 1) {
    return unionParts.flatMap((part) => referencedTypeNames(part.trim()));
  }
  const intersectionParts = splitTopLevelTypeText(typeName, "&");
  if (intersectionParts.length > 1) {
    return intersectionParts.flatMap((part) => referencedTypeNames(part.trim()));
  }
  return candidateTypeNames(baseTypeName(typeName.trim())).filter(Boolean);
}

function nestedTypeNameForNamespace(typeName: string, namespaceName: string): string {
  return typeName.startsWith(`${namespaceName}.`)
    ? typeName.slice(namespaceName.length + 1)
    : typeName;
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
