import { BlockStatement, ClassStatement, EnumStatement, ExportSpecifier, ExportStatement, ExprStatement, FunctionStatement, Identifier, ImportStatement, InterfaceStatement, NamespaceStatement, NodeKind, Program, Statement, TypeAliasStatement, VarStatement } from "compiler/ast/ast";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import {
  clearNodeModulesTypingsPathCache,
  resolveNodeModulesTypingsPath,
  type ModuleResolutionOptions
} from "compiler/moduleResolution";
import { vfs } from "compiler/vfs";
import { nodeRange, offsetToPosition, positionToOffset } from "./ranges";
import {
  clearDtsModuleGraphCache,
  extractTripleSlashReferencePaths,
  parseDtsProgram,
  readDtsSource,
  resolveRelativeDtsPath
} from "./dtsModuleGraph";
import type { Range } from "vscode-languageserver";
import { splitTopLevelTypeText } from "compiler/analysis/typeNames";

export interface NodeModuleTypings {
  /** Root declaration file selected for the imported package or subpath. */
  typingsPath: string;
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

export interface NodeModuleDeclarationEntry {
  statement: Statement;
  typingsPath: string;
  namespaceEntries?: readonly NodeModuleDeclarationEntry[];
  reexportedFrom?: readonly string[];
}

export type NodeModulePublicExportKind = "class" | "interface" | "type" | "function" | "variable";

export interface NodeModulePublicExport {
  name: string;
  kind: NodeModulePublicExportKind;
  typeOnly: boolean;
}

export interface NodeModulePublicExportsWorkCounters {
  publicExportFilesVisited: number;
}

export function nestedNodeModuleDeclarationEntries(
  entry: NodeModuleDeclarationEntry,
  namespace: NamespaceStatement
): readonly NodeModuleDeclarationEntry[] {
  return entry.namespaceEntries
    ?? namespace.body.body.map((statement) => ({ statement, typingsPath: entry.typingsPath }));
}

export function findExternalDeclarationMemberLocation(
  declarations: readonly Statement[],
  declarationLocations: ReadonlyMap<Statement, { filePath: string }>,
  typeName: string,
  memberName: string
): NodeModuleMemberLocation | null {
  const entryForStatement = (statement: Statement): NodeModuleDeclarationEntry | null => {
    const declaration = statement instanceof ExportStatement
      ? statement.declaration ?? statement
      : statement;
    const location = declarationLocations.get(statement)
      ?? declarationLocations.get(declaration);
    if (!location) {
      return null;
    }
    const namespaceEntries = declaration instanceof NamespaceStatement
      ? declaration.body.body
        .map(entryForStatement)
        .filter((entry): entry is NodeModuleDeclarationEntry => entry !== null)
      : undefined;
    return {
      statement,
      typingsPath: location.filePath,
      ...(namespaceEntries && namespaceEntries.length > 0 ? { namespaceEntries } : {})
    };
  };
  const entries = declarations
    .map(entryForStatement)
    .filter((entry): entry is NodeModuleDeclarationEntry => entry !== null);
  return findMemberLocationInDeclarationEntries(entries, typeName, memberName);
}

interface CacheEntry {
  typingsPath: string;
  mtimeMs: number;
  result: NodeModuleTypings;
}

interface SelectiveCacheEntry {
  typingsPath: string;
  mtimeMs: number;
  cacheKey: string;
  result: NodeModuleTypings;
}

interface SelectiveSupersetCacheEntry {
  mtimeMs: number;
  wantedNames: Set<string>;
  result: NodeModuleTypings;
}

interface PublicExportsCacheEntry {
  mtimeMs: number;
  result: NodeModulePublicExport[];
}

export interface NodeModuleTypingsWorkCounters {
  selectiveTypingsBuilds?: number;
  selectiveTypingsExactCacheHits?: number;
  selectiveTypingsSupersetCacheHits?: number;
  typingsFileIndexBuilds?: number;
  typingsFileIndexCacheHits?: number;
  typingsFileIndexEdgeResolutions?: number;
}

interface TypingsFileIndex {
  ast: Program;
  directEntries: NodeModuleDeclarationEntry[];
  supportSpecifiers: string[];
  targetPathBySpecifier: Map<string, string | null>;
}

const cache = new Map<string, CacheEntry>();
const selectiveCache = new Map<string, SelectiveCacheEntry>();
const selectiveSupersetCache = new Map<string, SelectiveSupersetCacheEntry>();
const publicExportsCache = new Map<string, PublicExportsCacheEntry>();
const typingsFileIndexCache = new Map<string, Promise<TypingsFileIndex | null>>();

export function clearNodeModuleTypingsCache(): void {
  cache.clear();
  selectiveCache.clear();
  selectiveSupersetCache.clear();
  publicExportsCache.clear();
  typingsFileIndexCache.clear();
  clearDtsModuleGraphCache();
  clearNodeModulesTypingsPathCache();
}

async function resolveReexportedTypingsPath(
  importerTypingsPath: string,
  specifier: string,
  options: ModuleResolutionOptions
): Promise<string | null> {
  if (specifier.startsWith(".")) {
    return resolveRelativeDtsPath(importerTypingsPath, specifier, options);
  }
  return resolveNodeModulesTypingsPath(importerTypingsPath, specifier, options);
}

async function getTypingsFileIndex(
  typingsPath: string,
  options: ModuleResolutionOptions,
  workCounters?: NodeModuleTypingsWorkCounters
): Promise<TypingsFileIndex | null> {
  const cached = typingsFileIndexCache.get(typingsPath);
  if (cached) {
    if (workCounters) {
      workCounters.typingsFileIndexCacheHits = (workCounters.typingsFileIndexCacheHits ?? 0) + 1;
    }
    return cached;
  }
  if (workCounters) {
    workCounters.typingsFileIndexBuilds = (workCounters.typingsFileIndexBuilds ?? 0) + 1;
  }
  const pending = (async (): Promise<TypingsFileIndex | null> => {
    const ast = await parseDtsProgram(typingsPath, options);
    if (!ast) return null;
    const source = await readDtsSource(typingsPath, options);
    const supportSpecifiers = [...new Set<string>([
      ...(source ? extractTripleSlashReferencePaths(source) : []),
      ...extractImportedTypingsSpecifiers(ast)
    ])];
    const edgeSpecifiers = [...new Set<string>([
      ...supportSpecifiers,
      ...ast.body.flatMap((statement) =>
        statement instanceof ExportStatement && (statement as ExportStatement).from?.value
          ? [(statement as ExportStatement).from!.value]
          : []
      )
    ])];
    if (workCounters) {
      workCounters.typingsFileIndexEdgeResolutions =
        (workCounters.typingsFileIndexEdgeResolutions ?? 0) + edgeSpecifiers.length;
    }
    const resolvedTargets = await Promise.all(edgeSpecifiers.map((specifier) =>
      resolveReexportedTypingsPath(typingsPath, specifier, options)
    ));
    return {
      ast,
      directEntries: ast.body.map((statement) => ({ statement, typingsPath })),
      supportSpecifiers,
      targetPathBySpecifier: new Map(edgeSpecifiers.map((specifier, index) => [
        specifier,
        resolvedTargets[index] ?? null
      ]))
    };
  })();
  typingsFileIndexCache.set(typingsPath, pending);
  try {
    return await pending;
  } catch (error) {
    typingsFileIndexCache.delete(typingsPath);
    throw error;
  }
}

function extractImportedTypingsSpecifiers(ast: Program): string[] {
  const specifiers = new Set<string>();

  for (const statement of ast.body) {
    if (!(statement instanceof ImportStatement)) {
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

function asExportedTypingsEntry(
  entry: NodeModuleDeclarationEntry,
  exportingTypingsPath?: string
): NodeModuleDeclarationEntry {
  const reexportedFrom = exportingTypingsPath
    ? [...new Set([...(entry.reexportedFrom ?? []), exportingTypingsPath])]
    : entry.reexportedFrom;
  return {
    ...entry,
    statement: entry.statement instanceof ExportStatement
      ? entry.statement
      : new ExportStatement(entry.statement),
    ...(reexportedFrom ? { reexportedFrom } : {})
  };
}

function reexportedDeclaration(entry: NodeModuleDeclarationEntry): Statement {
  return entry.statement instanceof ExportStatement
    ? (entry.statement as ExportStatement).declaration ?? entry.statement
    : entry.statement;
}

function asAliasedExportedTypingsEntry(
  entry: NodeModuleDeclarationEntry,
  exportedName: string,
  localName: string,
  exportingTypingsPath?: string
): NodeModuleDeclarationEntry {
  if (exportedName === localName) {
    return asExportedTypingsEntry(entry, exportingTypingsPath);
  }
  const specifier: ExportSpecifier = new ExportSpecifier(new Identifier(exportedName), new Identifier(localName));
  return {
    ...entry,
    statement: new ExportStatement(reexportedDeclaration(entry), undefined, [specifier]),
    ...(exportingTypingsPath
      ? { reexportedFrom: [...new Set([...(entry.reexportedFrom ?? []), exportingTypingsPath])] }
      : {})
  };
}

function asNamespaceReexportedTypingsEntry(
  namespaceExport: Identifier,
  targetTypingsPath: string,
  entries: readonly NodeModuleDeclarationEntry[],
  exportingTypingsPath: string
): NodeModuleDeclarationEntry | null {
  const exportedEntries = entries.filter((entry) =>
    (entry.typingsPath === targetTypingsPath && entry.statement instanceof ExportStatement)
    || entry.reexportedFrom?.includes(targetTypingsPath)
  );
  const firstEntry = exportedEntries[0];
  if (!firstEntry) {
    return null;
  }
  const namespaceName: Identifier = new Identifier(namespaceExport.name);
  const namespaceEntries = exportedEntries.map((entry) => asExportedTypingsEntry(entry));
  const namespaceDeclaration: NamespaceStatement = new NamespaceStatement(
    "namespace",
    new BlockStatement(namespaceEntries.map((entry) => entry.statement)),
    undefined,
    undefined,
    [namespaceName]
  );
  return {
    statement: new ExportStatement(namespaceDeclaration),
    typingsPath: firstEntry.typingsPath,
    namespaceEntries,
    reexportedFrom: [exportingTypingsPath]
  };
}

function declarationNameFromStatement(statement: Statement): string | null {
  const declaration = statement instanceof ExportStatement
    ? (statement as ExportStatement).declaration ?? statement
    : statement;
  if (declaration instanceof NamespaceStatement) {
    return (declaration as NamespaceStatement).names?.[0]?.name ?? null;
  }
  const named = declaration as { name?: Identifier };
  return named.name instanceof Identifier ? named.name.name ?? null : null;
}

function nodeModuleDeclarationName(entry: NodeModuleDeclarationEntry): string | null {
  return declarationNameFromStatement(reexportedDeclaration(entry));
}

export function nodeModuleExportedNamesForStatement(statement: Statement): string[] {
  if (!(statement instanceof ExportStatement)) {
    const directName = declarationNameFromStatement(statement);
    return directName ? [directName] : [];
  }
  const exportStatement = statement as ExportStatement;
  if (exportStatement.namespaceExport) {
    return [exportStatement.namespaceExport.name];
  }
  if ((exportStatement.specifiers?.length ?? 0) > 0) {
    return exportStatement.specifiers!.map((specifier) => specifier.exported.name);
  }
  const directName = declarationNameFromStatement(statement);
  return directName ? [directName] : [];
}

function nodeModuleExportedNames(entry: NodeModuleDeclarationEntry): string[] {
  return nodeModuleExportedNamesForStatement(entry.statement);
}

function canBeReexportedFrom(
  entry: NodeModuleDeclarationEntry,
  targetTypingsPath: string
): boolean {
  return entry.typingsPath === targetTypingsPath
    || entry.reexportedFrom?.includes(targetTypingsPath) === true;
}

async function collectTypingsDeclarations(
  typingsPath: string,
  options: ModuleResolutionOptions,
  visited: Set<string>,
  workCounters?: NodeModuleTypingsWorkCounters
): Promise<NodeModuleDeclarationEntry[]> {
  if (visited.has(typingsPath)) {
    return [];
  }
  visited.add(typingsPath);

  const index = await getTypingsFileIndex(typingsPath, options, workCounters);
  if (!index) {
    return [];
  }
  const declarations = [...index.directEntries];
  for (const specifier of index.supportSpecifiers) {
    const targetTypingsPath = index.targetPathBySpecifier.get(specifier) ?? null;
    if (!targetTypingsPath) {
      continue;
    }
    declarations.push(...await collectTypingsDeclarations(targetTypingsPath, options, visited, workCounters));
  }
  for (const statement of index.ast.body) {
    if (!(statement instanceof ExportStatement)) {
      continue;
    }
    const exportStatement = statement as ExportStatement;
    if (!exportStatement.from?.value || (!exportStatement.exportAll && (!exportStatement.specifiers || exportStatement.specifiers.length === 0))) {
      continue;
    }
    const targetTypingsPath = index.targetPathBySpecifier.get(exportStatement.from.value) ?? null;
    if (!targetTypingsPath) {
      continue;
    }
    const newlyCollectedReexports = await collectTypingsDeclarations(targetTypingsPath, options, visited, workCounters);
    const reexportedDeclarations = newlyCollectedReexports.length > 0
      ? newlyCollectedReexports
      : declarations.filter((entry) => canBeReexportedFrom(entry, targetTypingsPath));
    if (exportStatement.exportAll) {
      if (exportStatement.namespaceExport) {
        const namespaceEntry = asNamespaceReexportedTypingsEntry(
          exportStatement.namespaceExport,
          targetTypingsPath,
          reexportedDeclarations,
          typingsPath
        );
        if (namespaceEntry) {
          declarations.push(namespaceEntry);
        }
      } else {
        declarations.push(...reexportedDeclarations.map((entry) =>
          canBeReexportedFrom(entry, targetTypingsPath)
            ? asExportedTypingsEntry(entry, typingsPath)
            : entry
        ));
      }
      continue;
    }
    const exportedNameByLocalName = new Map<string, string>();
    for (const specifier of exportStatement.specifiers ?? []) {
      const localName = specifier.local?.name ?? specifier.exported.name;
      exportedNameByLocalName.set(localName, specifier.exported.name);
      exportedNameByLocalName.set(specifier.exported.name, specifier.exported.name);
    }
    for (const entry of reexportedDeclarations) {
      const declarationName = nodeModuleDeclarationName(entry);
      const exportedName = declarationName && canBeReexportedFrom(entry, targetTypingsPath)
        ? exportedNameByLocalName.get(declarationName)
        : undefined;
      if (declarationName && exportedName) {
        declarations.push(asAliasedExportedTypingsEntry(entry, exportedName, declarationName, typingsPath));
        continue;
      }
      declarations.push(entry);
    }
  }

  return declarations;
}

async function collectSelectiveTypingsDeclarations(
  typingsPath: string,
  exportedNamesWanted: ReadonlySet<string>,
  options: ModuleResolutionOptions,
  visited: Set<string>,
  includeAllTopLevel = false,
  workCounters?: NodeModuleTypingsWorkCounters
): Promise<NodeModuleDeclarationEntry[]> {
  const visitKey = includeAllTopLevel
    ? `${typingsPath}\0support`
    : `${typingsPath}\0wanted:${[...exportedNamesWanted].sort().join(",")}`;
  if (visited.has(visitKey)) {
    return [];
  }
  visited.add(visitKey);

  const index = await getTypingsFileIndex(typingsPath, options, workCounters);
  if (!index) {
    return [];
  }
  const declarations: NodeModuleDeclarationEntry[] = [];
  const directNamedEntries = index.directEntries;
  const fileDirectlyDefinesWantedName = directNamedEntries.some((entry) => {
    const exportedNames = nodeModuleExportedNames(entry);
    return exportedNames.some((name) => exportedNamesWanted.has(name));
  });
  const followAllNamedReexports = includeAllTopLevel || fileDirectlyDefinesWantedName;

  if (includeAllTopLevel || fileDirectlyDefinesWantedName) {
    declarations.push(...directNamedEntries);
  } else {
    for (const entry of directNamedEntries) {
      const exportedNames = nodeModuleExportedNames(entry);
      if (exportedNames.some((name) => exportedNamesWanted.has(name))) {
        declarations.push(entry);
      }
    }
  }

  const forwardedExportNameByLocalName = new Map<string, string>();
  for (const statement of index.ast.body) {
    if (!(statement instanceof ExportStatement) || statement.from?.value) {
      continue;
    }
    for (const specifier of statement.specifiers ?? []) {
      forwardedExportNameByLocalName.set(
        specifier.local?.name ?? specifier.exported.name,
        specifier.exported.name
      );
    }
  }
  for (const specifier of index.supportSpecifiers) {
    const targetTypingsPath = index.targetPathBySpecifier.get(specifier) ?? null;
    if (!targetTypingsPath) {
      continue;
    }
    const forwardedExportNameByImportedName = new Map<string, string>();
    for (const statement of index.ast.body) {
      if (!(statement instanceof ImportStatement) || statement.from?.value !== specifier) {
        continue;
      }
      for (const importedSpecifier of statement.specifiers) {
        const localName = (importedSpecifier.local ?? importedSpecifier.imported).name;
        const forwardedName = forwardedExportNameByLocalName.get(localName);
        if (forwardedName) {
          forwardedExportNameByImportedName.set(importedSpecifier.imported.name, forwardedName);
        }
      }
    }
    const supportDeclarations = await collectSelectiveTypingsDeclarations(
      targetTypingsPath,
      exportedNamesWanted,
      options,
      visited,
      true,
      workCounters
    );
    declarations.push(...supportDeclarations.map((entry) => {
      const declarationName = nodeModuleDeclarationName(entry);
      const forwardedName = declarationName && canBeReexportedFrom(entry, targetTypingsPath)
        ? forwardedExportNameByImportedName.get(declarationName)
        : undefined;
      return declarationName && forwardedName
        ? asAliasedExportedTypingsEntry(entry, forwardedName, declarationName, typingsPath)
        : entry;
    }));
  }

  for (const statement of index.ast.body) {
    if (!(statement instanceof ExportStatement)) {
      continue;
    }
    const exportStatement = statement as ExportStatement;
    if (!exportStatement.from?.value) {
      continue;
    }
    const targetTypingsPath = index.targetPathBySpecifier.get(exportStatement.from.value) ?? null;
    if (!targetTypingsPath) {
      continue;
    }

    if (exportStatement.exportAll) {
      if (exportStatement.namespaceExport && !includeAllTopLevel && !exportedNamesWanted.has(exportStatement.namespaceExport.name)) {
        continue;
      }
      const newlyCollectedReexports = await collectSelectiveTypingsDeclarations(
        targetTypingsPath,
        exportedNamesWanted,
        options,
        visited,
        includeAllTopLevel || Boolean(exportStatement.namespaceExport),
        workCounters
      );
      const reexportedDeclarations = newlyCollectedReexports.length > 0
        ? newlyCollectedReexports
        : declarations.filter((entry) => canBeReexportedFrom(entry, targetTypingsPath));
      if (exportStatement.namespaceExport) {
        const namespaceEntry = asNamespaceReexportedTypingsEntry(
          exportStatement.namespaceExport,
          targetTypingsPath,
          reexportedDeclarations,
          typingsPath
        );
        if (namespaceEntry) {
          declarations.push(namespaceEntry);
        }
      } else {
        declarations.push(...reexportedDeclarations.map((entry) =>
          canBeReexportedFrom(entry, targetTypingsPath)
            ? asExportedTypingsEntry(entry, typingsPath)
            : entry
        ));
      }
      continue;
    }

    const exportedNameByLocalName = new Map<string, string>();
    for (const specifier of exportStatement.specifiers ?? []) {
      if (!followAllNamedReexports && !exportedNamesWanted.has(specifier.exported.name)) {
        continue;
      }
      const localName = specifier.local?.name ?? specifier.exported.name;
      exportedNameByLocalName.set(localName, specifier.exported.name);
      exportedNameByLocalName.set(specifier.exported.name, specifier.exported.name);
    }
    if (exportedNameByLocalName.size === 0) {
      continue;
    }

    const newlyCollectedReexports = await collectSelectiveTypingsDeclarations(
      targetTypingsPath,
      new Set(exportedNameByLocalName.keys()),
      options,
      visited,
      false,
      workCounters
    );
    const reexportedDeclarations = newlyCollectedReexports.length > 0
      ? newlyCollectedReexports
      : declarations.filter((entry) => canBeReexportedFrom(entry, targetTypingsPath));
    for (const entry of reexportedDeclarations) {
      const declarationName = nodeModuleDeclarationName(entry);
      const exportedName = declarationName && canBeReexportedFrom(entry, targetTypingsPath)
        ? exportedNameByLocalName.get(declarationName)
        : undefined;
      if (declarationName && exportedName) {
        declarations.push(asAliasedExportedTypingsEntry(entry, exportedName, declarationName, typingsPath));
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
    if (stmt instanceof ExportStatement) {
      const exportStatement = stmt as ExportStatement;
      const declaration = exportStatement.declaration;
      if (exportStatement.isDefault === true && declaration instanceof FunctionStatement) {
        return (declaration as FunctionStatement).name.name;
      }
    }
    if (stmt instanceof ExprStatement) {
      const expr = (stmt as ExprStatement).expression;
      if (expr && expr instanceof Identifier) {
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
    if (stmt instanceof FunctionStatement) {
      const name = (stmt as FunctionStatement).name?.name;
      if (name) functionNames.add(name);
    }
  }
  for (const stmt of ast.body) {
    if (stmt instanceof NamespaceStatement) {
      const ns = stmt as { names?: { name: string }[] };
      const name = ns.names?.[0]?.name;
      if (name && functionNames.has(name)) return name;
    }
  }
  return null;
}

function publicExportKind(statement: Statement): NodeModulePublicExportKind | null {
  const declaration = statement instanceof ExportStatement
    ? (statement as ExportStatement).declaration
    : statement;
  if (declaration instanceof ClassStatement) return "class";
  if (declaration instanceof InterfaceStatement) return "interface";
  if (declaration instanceof TypeAliasStatement) return "type";
  if (declaration instanceof FunctionStatement) return "function";
  if (declaration instanceof VarStatement) return "variable";
  if (declaration instanceof NamespaceStatement) return "variable";
  return null;
}

function pushPublicExport(
  target: NodeModulePublicExport[],
  seen: Set<string>,
  entry: NodeModulePublicExport
): void {
  const key = `${entry.name}\0${entry.kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(entry);
}

async function collectNodeModulePublicExports(
  typingsPath: string,
  options: ModuleResolutionOptions,
  visiting: Set<string>,
  collectedByPath: Map<string, NodeModulePublicExport[]>,
  workCounters?: NodeModulePublicExportsWorkCounters
): Promise<NodeModulePublicExport[]> {
  const cached = collectedByPath.get(typingsPath);
  if (cached) return cached;
  if (visiting.has(typingsPath)) return [];
  visiting.add(typingsPath);
  if (workCounters) workCounters.publicExportFilesVisited += 1;

  const ast = await parseDtsProgram(typingsPath, options);
  if (!ast) {
    visiting.delete(typingsPath);
    collectedByPath.set(typingsPath, []);
    return [];
  }

  const results: NodeModulePublicExport[] = [];
  const seen = new Set<string>();
  const localKindByName = new Map<string, NodeModulePublicExportKind>();
  const importedBindingByLocalName = new Map<string, {
    importedName: string;
    specifier: string;
    typeOnly: boolean;
  }>();
  for (const statement of ast.body) {
    const name = declarationNameFromStatement(statement);
    const kind = publicExportKind(statement);
    if (name && kind) localKindByName.set(name, kind);
    if (!(statement instanceof ImportStatement)) continue;
    for (const importedSpecifier of statement.specifiers) {
      importedBindingByLocalName.set(
        (importedSpecifier.local ?? importedSpecifier.imported).name,
        {
          importedName: importedSpecifier.imported.name,
          specifier: statement.from.value,
          typeOnly: statement.typeOnly === true || importedSpecifier.typeOnly === true
        }
      );
    }
  }

  for (const statement of ast.body) {
    if (!(statement instanceof ExportStatement)) continue;
    const exportStatement = statement as ExportStatement;
    if (exportStatement.isDefault === true) continue;

    const directName = declarationNameFromStatement(exportStatement);
    const directKind = publicExportKind(exportStatement);
    if (directName && directKind) {
      pushPublicExport(results, seen, {
        name: directName,
        kind: directKind,
        typeOnly: exportStatement.typeOnly === true || directKind === "interface" || directKind === "type"
      });
    }

    if (!exportStatement.from?.value) {
      for (const specifier of exportStatement.specifiers ?? []) {
        const localName = specifier.local?.name ?? specifier.exported.name;
        const importedBinding = importedBindingByLocalName.get(localName);
        const importedTargetPath = importedBinding
          ? await resolveReexportedTypingsPath(typingsPath, importedBinding.specifier, options)
          : null;
        const importedTarget = importedTargetPath
          ? (await collectNodeModulePublicExports(
              importedTargetPath,
              options,
              visiting,
              collectedByPath,
              workCounters
            )).find((entry) => entry.name === importedBinding?.importedName)
          : undefined;
        const kind = localKindByName.get(localName)
          ?? importedTarget?.kind
          ?? (exportStatement.typeOnly === true || specifier.typeOnly === true ? "type" : "variable");
        pushPublicExport(results, seen, {
          name: specifier.exported.name,
          kind,
          typeOnly: exportStatement.typeOnly === true
            || specifier.typeOnly === true
            || importedBinding?.typeOnly === true
            || importedTarget?.typeOnly === true
            || kind === "interface"
            || kind === "type"
        });
      }
      continue;
    }

    const targetPath = await resolveReexportedTypingsPath(
      typingsPath,
      exportStatement.from.value,
      options
    );
    if (!targetPath) continue;
    if (exportStatement.exportAll && exportStatement.namespaceExport) {
      pushPublicExport(results, seen, {
        name: exportStatement.namespaceExport.name,
        kind: "variable",
        typeOnly: false
      });
      continue;
    }

    const targetExports = await collectNodeModulePublicExports(
      targetPath,
      options,
      visiting,
      collectedByPath,
      workCounters
    );
    if (exportStatement.exportAll) {
      for (const entry of targetExports) pushPublicExport(results, seen, entry);
      continue;
    }

    const targetByName = new Map(targetExports.map((entry) => [entry.name, entry]));
    for (const specifier of exportStatement.specifiers ?? []) {
      const localName = specifier.local?.name ?? specifier.exported.name;
      const target = targetByName.get(localName);
      const kind = target?.kind ?? (exportStatement.typeOnly === true ? "type" : "variable");
      pushPublicExport(results, seen, {
        name: specifier.exported.name,
        kind,
        typeOnly: exportStatement.typeOnly === true || target?.typeOnly === true || kind === "interface" || kind === "type"
      });
    }
  }
  visiting.delete(typingsPath);
  collectedByPath.set(typingsPath, results);
  return results;
}

/**
 * Lists only names exposed by a package's public declaration surface. This
 * follows re-export edges but deliberately ignores ordinary support imports
 * and referenced implementation types, which are irrelevant to auto-import
 * discovery and are loaded later if the user actually imports a symbol.
 */
export async function getNodeModulePublicExports(
  importerFilePath: string,
  packageName: string,
  options: ModuleResolutionOptions = {},
  workCounters?: NodeModulePublicExportsWorkCounters
): Promise<NodeModulePublicExport[]> {
  const activeVfs = options.vfs ?? vfs();
  const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, packageName, { vfs: activeVfs });
  if (!typingsPath) return [];
  const typingsStat = await activeVfs.stat(typingsPath);
  if (!typingsStat || typingsStat.isFile === false) return [];
  const cached = publicExportsCache.get(typingsPath);
  if (cached?.mtimeMs === typingsStat.mtimeMs) return cached.result;
  const result = await collectNodeModulePublicExports(
    typingsPath,
    { vfs: activeVfs },
    new Set<string>(),
    new Map<string, NodeModulePublicExport[]>(),
    workCounters
  );
  publicExportsCache.set(typingsPath, { mtimeMs: typingsStat.mtimeMs, result });
  return result;
}

/**
 * Return the parsed typings for a node_modules package, cached by file path
 * and mtime. Returns `null` when the package or its declaration file cannot be
 * located.
 */
export async function getNodeModuleTypings(
  importerFilePath: string,
  packageName: string,
  options: ModuleResolutionOptions = {},
  workCounters?: NodeModuleTypingsWorkCounters
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

  const rootIndex = await getTypingsFileIndex(typingsPath, { vfs: activeVfs }, workCounters);
  if (!rootIndex) {
    return null;
  }
  const declarationEntries = await collectTypingsDeclarations(
    typingsPath,
    { vfs: activeVfs },
    new Set<string>(),
    workCounters
  );
  const declarations = declarationEntries.map((entry) => entry.statement);

  const defaultExportName =
    detectExportEqualsName(rootIndex.ast) ??
    detectNamespaceName(rootIndex.ast) ??
    packageName;

  const result: NodeModuleTypings = {
    typingsPath,
    declarations,
    declarationEntries,
    defaultExportName,
  };

  cache.set(typingsPath, { typingsPath, mtimeMs, result });
  return result;
}

export async function getNodeModuleTypingsForImportNames(
  importerFilePath: string,
  packageName: string,
  wantedNames: ReadonlySet<string>,
  options: ModuleResolutionOptions = {},
  workCounters?: NodeModuleTypingsWorkCounters
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
  const cacheKey = [...wantedNames].sort().join("\0");
  const selectiveKey = `${typingsPath}\0${cacheKey}`;
  const cached = selectiveCache.get(selectiveKey);
  if (cached && cached.mtimeMs === mtimeMs && cached.cacheKey === cacheKey) {
    if (workCounters) {
      workCounters.selectiveTypingsExactCacheHits =
        (workCounters.selectiveTypingsExactCacheHits ?? 0) + 1;
    }
    return cached.result;
  }

  const cachedSuperset = selectiveSupersetCache.get(typingsPath);
  if (
    cachedSuperset?.mtimeMs === mtimeMs &&
    [...wantedNames].every((name) => cachedSuperset.wantedNames.has(name))
  ) {
    if (workCounters) {
      workCounters.selectiveTypingsSupersetCacheHits =
        (workCounters.selectiveTypingsSupersetCacheHits ?? 0) + 1;
    }
    selectiveCache.set(selectiveKey, {
      typingsPath,
      mtimeMs,
      cacheKey,
      result: cachedSuperset.result
    });
    return cachedSuperset.result;
  }
  const accumulatedWantedNames = new Set([
    ...(cachedSuperset?.mtimeMs === mtimeMs ? cachedSuperset.wantedNames : []),
    ...wantedNames
  ]);
  if (workCounters) {
    workCounters.selectiveTypingsBuilds = (workCounters.selectiveTypingsBuilds ?? 0) + 1;
  }

  const rootIndex = await getTypingsFileIndex(typingsPath, { vfs: activeVfs }, workCounters);
  if (!rootIndex) {
    return null;
  }
  const declarationEntries = await collectSelectiveTypingsDeclarations(
    typingsPath,
    accumulatedWantedNames,
    { vfs: activeVfs },
    new Set<string>(),
    false,
    workCounters
  );
  const declarations = declarationEntries.map((entry) => entry.statement);
  const defaultExportName =
    detectExportEqualsName(rootIndex.ast) ??
    detectNamespaceName(rootIndex.ast) ??
    packageName;
  const result: NodeModuleTypings = {
    typingsPath,
    declarations,
    declarationEntries,
    defaultExportName
  };
  selectiveCache.set(selectiveKey, { typingsPath, mtimeMs, cacheKey, result });
  selectiveSupersetCache.set(typingsPath, {
    mtimeMs,
    wantedNames: accumulatedWantedNames,
    result
  });
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
        entry.statement instanceof ExportStatement
          ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
          : entry.statement;

      if (candidate instanceof NamespaceStatement) {
        const namespace = candidate as NamespaceStatement;
        const name = namespace.names?.[0]?.name;
        const childEntries = nestedNodeModuleDeclarationEntries(entry, namespace);

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

      if (candidate instanceof InterfaceStatement) {
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

      if (candidate instanceof ClassStatement) {
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

      if (candidate instanceof TypeAliasStatement) {
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
        entry.statement instanceof ExportStatement
          ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
          : entry.statement;

      if (candidate instanceof NamespaceStatement) {
        const namespace = candidate as NamespaceStatement;
        const name = namespace.names?.[0]?.name;
        if (name === candidateTypeName) {
          const memberLocation = findDeclarationLocationInEntries(
            nestedNodeModuleDeclarationEntries(entry, namespace),
            memberName
          );
          if (memberLocation) {
            return memberLocation;
          }
        }
        const nestedTypeName = name ? nestedTypeNameForNamespace(candidateTypeName, name) : candidateTypeName;
        const nested = findMemberLocationInDeclarationEntries(
          nestedNodeModuleDeclarationEntries(entry, namespace),
          nestedTypeName,
          memberName,
          visitedTypeNames
        );
        if (nested) {
          return nested;
        }
      }

      if (candidate instanceof InterfaceStatement) {
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

      if (candidate instanceof ClassStatement) {
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

      if (candidate instanceof TypeAliasStatement) {
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
  declarationKinds: ReadonlySet<NodeKind.InterfaceStatement | NodeKind.ClassStatement>,
  visitedNamespaces = new Set<Statement>()
): NodeModuleMemberLocation | null {
  for (let index = declarationEntries.length - 1; index >= 0; index -= 1) {
    const entry = declarationEntries[index]!;
    const candidate =
      entry.statement instanceof ExportStatement
        ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
        : entry.statement;

    if (candidate instanceof NamespaceStatement) {
      if (visitedNamespaces.has(candidate)) {
        continue;
      }
      const nextVisitedNamespaces = new Set(visitedNamespaces);
      nextVisitedNamespaces.add(candidate);
      const nested = findStructuralMemberLocationInDeclarationEntries(
        nestedNodeModuleDeclarationEntries(entry, candidate as NamespaceStatement),
        memberName,
        declarationKinds,
        nextVisitedNamespaces
      );
      if (nested) {
        return nested;
      }
      continue;
    }

    if (!declarationKinds.has(candidate.kind as NodeKind.InterfaceStatement | NodeKind.ClassStatement)) {
      continue;
    }

    const members = candidate instanceof InterfaceStatement
      ? (candidate as InterfaceStatement).members
      : candidate instanceof ClassStatement
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

async function findStructuralTypeAliasMemberLocation(
  declarationEntries: readonly NodeModuleDeclarationEntry[],
  memberName: string,
  activeVfs: ReturnType<typeof vfs>,
  sourceCache = new Map<string, string>(),
  visitedNamespaces = new Set<Statement>()
): Promise<NodeModuleMemberLocation | null> {
  const escapedMemberName = memberName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const memberPattern = new RegExp(`\\b${escapedMemberName}\\??\\s*:`, "u");
  for (let index = declarationEntries.length - 1; index >= 0; index -= 1) {
    const entry = declarationEntries[index]!;
    const candidate = entry.statement instanceof ExportStatement
      ? (entry.statement as { declaration?: Statement }).declaration ?? entry.statement
      : entry.statement;
    if (candidate instanceof NamespaceStatement) {
      if (visitedNamespaces.has(candidate)) continue;
      const nestedVisited = new Set(visitedNamespaces);
      nestedVisited.add(candidate);
      const nested = await findStructuralTypeAliasMemberLocation(
        nestedNodeModuleDeclarationEntries(entry, candidate),
        memberName,
        activeVfs,
        sourceCache,
        nestedVisited
      );
      if (nested) return nested;
      continue;
    }
    if (!(candidate instanceof TypeAliasStatement)) continue;
    const targetRange = nodeRange(candidate.targetType);
    if (!targetRange) continue;
    let source = sourceCache.get(entry.typingsPath);
    if (source === undefined) {
      source = await activeVfs.readFile(entry.typingsPath);
      sourceCache.set(entry.typingsPath, source);
    }
    const startOffset = positionToOffset(source, targetRange.start);
    const endOffset = positionToOffset(source, targetRange.end);
    const match = memberPattern.exec(source.slice(startOffset, endOffset));
    if (!match) continue;
    const memberOffset = startOffset + match.index;
    const start = offsetToPosition(source, memberOffset);
    return {
      typingsPath: entry.typingsPath,
      range: {
        start,
        end: { line: start.line, character: start.character + memberName.length }
      }
    };
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
    new Set([NodeKind.InterfaceStatement])
  ) ?? findStructuralMemberLocationInDeclarationEntries(
    typings.declarationEntries,
    memberName,
    new Set([NodeKind.ClassStatement])
  ) ?? await findStructuralTypeAliasMemberLocation(
    typings.declarationEntries,
    memberName,
    activeVfs
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
        statement instanceof ExportStatement
          ? (statement as { declaration?: Statement }).declaration ?? statement
          : statement;

      if (candidate instanceof NamespaceStatement) {
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

      if (candidate instanceof InterfaceStatement) {
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

      if (candidate instanceof ClassStatement) {
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

      if (candidate instanceof TypeAliasStatement) {
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
        stmt instanceof ExportStatement
          ? (stmt as { declaration?: Statement }).declaration ?? stmt
          : stmt;

      if (candidate instanceof NamespaceStatement) {
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

      if (candidate instanceof InterfaceStatement) {
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

      if (candidate instanceof ClassStatement) {
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

      if (candidate instanceof TypeAliasStatement) {
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
      child instanceof ExportStatement
        ? (child as { declaration?: Statement }).declaration ?? child
        : child;

    const nameNode = declarationNameNode(decl);
    if (nameNode?.name === memberName) {
      const range = nodeRange(nameNode);
      if (range) return range;
    }
  }
  return null;
}

function findDeclarationLocationInEntries(
  entries: readonly NodeModuleDeclarationEntry[],
  declarationName: string
): NodeModuleMemberLocation | null {
  for (const entry of entries) {
    const declaration = entry.statement instanceof ExportStatement
      ? entry.statement.declaration ?? entry.statement
      : entry.statement;
    const nameNode = declarationNameNode(declaration);
    if (nameNode?.name !== declarationName) {
      continue;
    }
    const range = nodeRange(nameNode);
    if (range) {
      return { typingsPath: entry.typingsPath, range };
    }
  }
  return null;
}

function declarationNameNode(declaration: Statement): Identifier | null {
  switch (declaration.kind) {
    case NodeKind.FunctionStatement:
    case NodeKind.InterfaceStatement:
    case NodeKind.ClassStatement:
    case NodeKind.EnumStatement:
    case NodeKind.TypeAliasStatement: {
      const namedDeclaration = declaration as
        | FunctionStatement
        | InterfaceStatement
        | ClassStatement
        | EnumStatement
        | TypeAliasStatement;
      return namedDeclaration.name;
    }
    case NodeKind.NamespaceStatement: {
      const namespace = declaration as NamespaceStatement;
      return namespace.names?.[0] ?? null;
    }
    default:
      return null;
  }
}

function declarationNameRange(declaration: Statement): Range | null {
  const nameNode = declarationNameNode(declaration);
  return nameNode ? nodeRange(nameNode) : null;
}

function topLevelBindingRangeFromStatement(statement: Statement, bindingName: string): Range | null {
  const declaration =
    statement instanceof ExportStatement
      ? (statement as { declaration?: Statement }).declaration ?? statement
      : statement;

  switch (declaration.kind) {
    case NodeKind.FunctionStatement:
    case NodeKind.InterfaceStatement:
    case NodeKind.ClassStatement:
    case NodeKind.EnumStatement:
    case NodeKind.TypeAliasStatement: {
      const nameNode = declarationNameNode(declaration);
      return nameNode?.name === bindingName ? nodeRange(nameNode) : null;
    }
    case NodeKind.NamespaceStatement: {
      const nameNode = declarationNameNode(declaration);
      return nameNode?.name === bindingName ? nodeRange(nameNode) : null;
    }
    case NodeKind.VarStatement: {
      const variable = declaration as VarStatement;
      const identifier = [
        ...bindingIdentifiers(variable.name),
        ...(variable.declarations ?? []).flatMap((item) => bindingIdentifiers(item.name))
      ].find((candidate) => candidate.name === bindingName);
      return identifier ? nodeRange(identifier) : null;
    }
    case NodeKind.ImportStatement: {
      const importStatement = declaration as ImportStatement;
      if (importStatement.defaultImport?.name === bindingName) {
        return nodeRange(importStatement.defaultImport);
      }
      if (importStatement.namespaceImport?.name === bindingName) {
        return nodeRange(importStatement.namespaceImport);
      }
      const specifier = importStatement.specifiers?.find((candidate) => (candidate.local ?? candidate.imported).name === bindingName);
      return specifier ? nodeRange(specifier.local ?? specifier.imported) : null;
    }
    default:
      return null;
  }
}

function findTopLevelBindingRangeInEntries(
  declarationEntries: readonly NodeModuleDeclarationEntry[],
  typingsPath: string,
  bindingName: string
): Range | null {
  for (const entry of declarationEntries) {
    if (entry.typingsPath !== typingsPath) {
      continue;
    }
    const range = topLevelBindingRangeFromStatement(entry.statement, bindingName);
    if (range) {
      return range;
    }
  }
  return null;
}

function namedExportRangeFromStatement(
  statement: Statement,
  exportName: string,
  declarationEntries: readonly NodeModuleDeclarationEntry[],
  typingsPath: string
): Range | null {
  if (statement instanceof ExportStatement) {
    const exportStatement = statement as ExportStatement;
    if (exportName === "default" && exportStatement.isDefault && exportStatement.declaration) {
      return declarationNameRange(exportStatement.declaration);
    }
    if (exportStatement.namespaceExport?.name === exportName) {
      return nodeRange(exportStatement.namespaceExport);
    }
    const matchingSpecifier = exportStatement.specifiers?.find((specifier) => specifier.exported.name === exportName);
    if (matchingSpecifier) {
      const localName = matchingSpecifier.local?.name ?? matchingSpecifier.exported.name;
      const localRange = findTopLevelBindingRangeInEntries(declarationEntries, typingsPath, localName);
      if (localRange) {
        return localRange;
      }
      if (exportStatement.from?.value) {
        return null;
      }
      return nodeRange(matchingSpecifier.local ?? matchingSpecifier.exported);
    }
  }
  return topLevelBindingRangeFromStatement(statement, exportName);
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
    const range = namedExportRangeFromStatement(
      entry.statement,
      exportName,
      typings.declarationEntries,
      entry.typingsPath
    );
    if (range) {
      return { typingsPath: entry.typingsPath, range };
    }
  }

  return null;
}
