import { ImportStatement, Program, type Statement } from "compiler/ast/ast";
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
  vfs: Vfs,
  ambientGlobalDeclarations: readonly Statement[] = []
): Promise<ResolvedNodeModuleImports> {
  const [{ loadAmbientTypesForProject }, { collectAllImportedDeclarations }] = await Promise.all([
    import("compiler/ambientModules"),
    import("compiler/lsp/importedDeclarations")
  ]);
  const nodeAmbientTypes = await loadAmbientTypesForProject(importerFilePath, ["node"], { vfs });
  // Local modules are visited and typed by the module graph itself. Feeding
  // them into the npm declaration collector recursively re-walked the whole
  // project once per module (quadratic on real applications) and mixed local
  // context into a cache intended for package declarations.
  const nodeModuleAst = new Program(ast.body.filter((statement): statement is ImportStatement =>
    statement instanceof ImportStatement &&
      !statement.from.value.startsWith(".") &&
      !statement.from.value.startsWith("/")
  ));
  const imported = await collectAllImportedDeclarations(nodeModuleAst, {
    uri: pathToFileURL(importerFilePath).toString(),
    sourceRoots: [],
    vfs,
    ambientModuleDeclarations: nodeAmbientTypes.moduleDeclarations,
    ambientGlobalDeclarations: [
      ...ambientGlobalDeclarations,
      ...nodeAmbientTypes.globalDeclarations
    ]
  });
  return {
    externalDeclarations: imported.externalDeclarations,
    externalDeclarationLocations: imported.externalDeclarationLocations,
    importedSymbols: imported.importedSymbols
  };
}
