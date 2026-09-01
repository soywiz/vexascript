import type { Program, Statement } from "compiler/ast/ast";
import type { ImportedSymbolResolution } from "compiler/importedSymbols";
import type { Vfs } from "compiler/vfs";
import { pathToFileURL } from "compiler/utils/path";

export interface ResolvedNodeModuleImports {
  externalDeclarations: Statement[];
  externalDeclarationLocations: Map<Statement, {
    filePath: string;
    line: number;
    character: number;
  }>;
  importedSymbols: Map<string, ImportedSymbolResolution>;
}

export async function resolveNodeModuleImportsForRuntime(
  ast: Program,
  importerFilePath: string,
  vfs: Vfs
): Promise<ResolvedNodeModuleImports> {
  const [{ loadAmbientTypesForProject }, { collectAllImportedDeclarations }] = await Promise.all([
    import("compiler/ambientModules"),
    import("compiler/lsp/importedDeclarations")
  ]);
  const nodeAmbientTypes = await loadAmbientTypesForProject(importerFilePath, ["node"], { vfs });
  const imported = await collectAllImportedDeclarations(ast, {
    uri: pathToFileURL(importerFilePath).toString(),
    sourceRoots: [],
    vfs,
    ambientModuleDeclarations: nodeAmbientTypes.moduleDeclarations,
    ambientGlobalDeclarations: nodeAmbientTypes.globalDeclarations
  });
  return {
    externalDeclarations: imported.externalDeclarations,
    externalDeclarationLocations: imported.externalDeclarationLocations,
    importedSymbols: imported.importedSymbols
  };
}
