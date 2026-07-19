import { NodeKind } from "compiler/ast/ast";
import type { ImportStatement, Program } from "compiler/ast/ast";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import type { ParserOptions } from "compiler/parser/parser";
import { extname, resolve } from "compiler/utils/path";
import type { Vfs } from "compiler/vfs";

export interface LocalImportDependency {
  statement: ImportStatement;
  targetPath: string;
}

export function isBundledLocalModulePath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".vx" || extension === ".ts" || extension === ".tsx";
}

export function parserOptionsForModulePath(filePath: string): ParserOptions {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts") return { language: "typescript" };
  if (extension === ".tsx") return { language: "typescript", jsx: true };
  return {};
}

async function resolveLocalModulePath(
  importerFilePath: string,
  importPath: string,
  vfs: Vfs,
  importMappings: Readonly<Record<string, string>>,
  baseUrl?: string,
  includeAssets = false
): Promise<string | null> {
  const baseUrlTarget: string | undefined = baseUrl !== undefined && !importPath.startsWith(".")
    ? resolve(baseUrl, importPath)
    : undefined;
  if (!importPath.startsWith(".") && !importMappings[importPath] && baseUrlTarget === undefined) {
    return null;
  }
  const effectiveImportMappings = baseUrlTarget !== undefined && !importMappings[importPath]
    ? { ...importMappings, [importPath]: baseUrlTarget }
    : importMappings;
  const targetPath = await resolveImportTargetFilePath(importerFilePath, importPath, {
    vfs,
    importMappings: effectiveImportMappings
  });
  return targetPath && (isBundledLocalModulePath(targetPath) || (includeAssets && extname(targetPath).toLowerCase() === ".json"))
    ? targetPath
    : null;
}

export async function localImportSpecifiers(
  ast: Program,
  importerFilePath: string,
  vfs: Vfs,
  importMappings: Readonly<Record<string, string>>,
  baseUrl?: string,
  includeAssets = false
): Promise<LocalImportDependency[]> {
  const imports: LocalImportDependency[] = [];
  for (const statement of ast.body) {
    if (statement.kind !== NodeKind.ImportStatement) continue;
    const importStatement = statement as ImportStatement;
    const targetPath = await resolveLocalModulePath(
      importerFilePath,
      importStatement.from.value,
      vfs,
      importMappings,
      baseUrl,
      includeAssets
    );
    if (targetPath) imports.push({ statement: importStatement, targetPath });
  }
  return imports;
}
