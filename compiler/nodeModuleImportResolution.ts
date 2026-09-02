import { ImportStatement, Program, type Statement } from "compiler/ast/ast";
import type { ImportedSymbolResolution } from "compiler/importedSymbols";
import type { Vfs } from "compiler/vfs";
import { pathToFileURL } from "compiler/utils/path";
import { resolveNodeModulesTypingsPath } from "compiler/moduleResolution";

export interface ResolvedNodeModuleImports {
  externalDeclarations: Statement[];
  externalDeclarationLocations: Map<Statement, {
    filePath: string;
    line: number;
    character: number;
  }>;
  importedSymbols: Map<string, ImportedSymbolResolution>;
}

export interface NodeModuleImportResolutionCache {
  entries: Map<string, Promise<ResolvedNodeModuleImports>>;
}

export interface NodeModuleImportResolutionWorkCounters {
  nodeModuleImportResolutionCount: number;
  nodeModuleImportCacheHitCount: number;
  selectiveTypingsBuilds: number;
  selectiveTypingsExactCacheHits: number;
  selectiveTypingsSupersetCacheHits: number;
  typingsFileIndexBuilds: number;
  typingsFileIndexCacheHits: number;
  typingsFileIndexEdgeResolutions: number;
}

export function createNodeModuleImportResolutionCache(): NodeModuleImportResolutionCache {
  return { entries: new Map() };
}

async function resolveNodeModuleImportsForRuntimeUncached(
  ast: Program,
  importerFilePath: string,
  vfs: Vfs,
  ambientGlobalDeclarations: readonly Statement[] = [],
  workCounters?: NodeModuleImportResolutionWorkCounters
): Promise<ResolvedNodeModuleImports> {
  // Local modules are visited and typed by the module graph itself. Feeding
  // them into the npm declaration collector recursively re-walked the whole
  // project once per module (quadratic on real applications) and mixed local
  // context into a cache intended for package declarations.
  const nodeModuleAst = new Program(ast.body.filter((statement): statement is ImportStatement =>
    statement instanceof ImportStatement &&
      !statement.from.value.startsWith(".") &&
      !statement.from.value.startsWith("/")
  ));
  let needsNodeAmbientTypes = nodeModuleAst.body.some((statement) =>
    (statement as ImportStatement).from.value.startsWith("node:")
  );
  const { collectAllImportedDeclarations } = await import("compiler/lsp/importedDeclarations");
  const collect = async (loadNodeAmbientTypes: boolean) => {
    const nodeAmbientTypes = loadNodeAmbientTypes
      ? await import("compiler/ambientModules").then(({ loadAmbientTypesForProject }) =>
          loadAmbientTypesForProject(importerFilePath, ["node"], { vfs })
        )
      : {
          globalDeclarations: [] as Statement[],
          moduleDeclarations: new Map<string, Statement[]>()
        };
    return collectAllImportedDeclarations(nodeModuleAst, {
      uri: pathToFileURL(importerFilePath).toString(),
      sourceRoots: [],
      vfs,
      ambientModuleDeclarations: nodeAmbientTypes.moduleDeclarations,
      ambientGlobalDeclarations: [
        ...ambientGlobalDeclarations,
        ...nodeAmbientTypes.globalDeclarations
      ],
      ...(workCounters ? { workCounters } : {})
    });
  };
  let imported = await collect(needsNodeAmbientTypes);
  if (!needsNodeAmbientTypes && imported.invalidImportedBindings.size > 0) {
    needsNodeAmbientTypes = true;
    imported = await collect(true);
  }
  return {
    externalDeclarations: imported.externalDeclarations,
    externalDeclarationLocations: imported.externalDeclarationLocations,
    importedSymbols: imported.importedSymbols
  };
}

async function nodeModuleImportResolutionKey(
  ast: Program,
  importerFilePath: string,
  vfs: Vfs
): Promise<string> {
  const imports = ast.body.filter((statement): statement is ImportStatement =>
    statement instanceof ImportStatement &&
      !statement.from.value.startsWith(".") &&
      !statement.from.value.startsWith("/")
  );
  const typingsPaths = await Promise.all(imports.map((statement) =>
    resolveNodeModulesTypingsPath(importerFilePath, statement.from.value, { vfs })
  ));
  return JSON.stringify(imports.map((statement, index) => [
    typingsPaths[index] ?? `${importerFilePath}\0${statement.from.value}`,
    statement.defaultImport?.name ?? "",
    statement.namespaceImport?.name ?? "",
    statement.typeOnly === true,
    statement.specifiers.map((specifier) => [
      specifier.imported.name,
      specifier.local?.name ?? "",
      specifier.typeOnly === true
    ])
  ]));
}

export async function resolveNodeModuleImportsForRuntime(
  ast: Program,
  importerFilePath: string,
  vfs: Vfs,
  ambientGlobalDeclarations: readonly Statement[] = [],
  cache?: NodeModuleImportResolutionCache,
  workCounters?: NodeModuleImportResolutionWorkCounters
): Promise<ResolvedNodeModuleImports> {
  if (!cache) {
    if (workCounters) workCounters.nodeModuleImportResolutionCount += 1;
    return resolveNodeModuleImportsForRuntimeUncached(
      ast,
      importerFilePath,
      vfs,
      ambientGlobalDeclarations,
      workCounters
    );
  }
  const key = await nodeModuleImportResolutionKey(ast, importerFilePath, vfs);
  const cached = cache.entries.get(key);
  if (cached) {
    if (workCounters) workCounters.nodeModuleImportCacheHitCount += 1;
    return cached;
  }
  if (workCounters) workCounters.nodeModuleImportResolutionCount += 1;
  const pending = resolveNodeModuleImportsForRuntimeUncached(
    ast,
    importerFilePath,
    vfs,
    ambientGlobalDeclarations,
    workCounters
  );
  cache.entries.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    cache.entries.delete(key);
    throw error;
  }
}
