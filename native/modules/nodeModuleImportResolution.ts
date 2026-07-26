import {
  ExportStatement,
  ImportStatement
} from "../../compiler/ast/ast";
import type { Program, Statement } from "../../compiler/ast/ast";
import { namedType } from "../../compiler/analysis/types";
import type { ImportedSymbolResolution } from "../../compiler/importedSymbols";
import { resolveNodeModulesTypingsPath } from "../../compiler/moduleResolution";
import { parseSource } from "../../compiler/pipeline/parse";
import { dirname, resolve } from "../../compiler/utils/path";
import type { Vfs } from "../../compiler/vfs";

export interface ResolvedNodeModuleImports {
  externalDeclarations: Statement[];
  importedSymbols: Map<string, ImportedSymbolResolution>;
}

async function firstDeclarationFile(
  candidates: readonly string[],
  activeVfs: Vfs
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await activeVfs.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveDeclarationImport(
  importerFilePath: string,
  specifier: string,
  activeVfs: Vfs
): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return resolveNodeModulesTypingsPath(importerFilePath, specifier, {
      vfs: activeVfs,
      pnpmVirtualStore: false
    });
  }
  const direct = resolve(dirname(importerFilePath), specifier);
  const withoutRuntimeExtension = direct
    .replace(/\.mjs$/, "")
    .replace(/\.cjs$/, "")
    .replace(/\.js$/, "");
  const candidates = [
    `${direct}.d.ts`,
    `${withoutRuntimeExtension}.d.ts`,
    resolve(direct, "index.d.ts"),
    resolve(withoutRuntimeExtension, "index.d.ts")
  ];
  if (direct.endsWith(".d.ts")) {
    candidates.unshift(direct);
  }
  return firstDeclarationFile(candidates, activeVfs);
}

function tripleSlashReferencePaths(source: string): string[] {
  const paths: string[] = [];
  for (const line of source.split("\n")) {
    const markerIndex = line.indexOf("reference path=");
    if (markerIndex < 0) {
      continue;
    }
    const quoteIndex = markerIndex + "reference path=".length;
    const quote = line[quoteIndex];
    if (quote !== "\"" && quote !== "'") {
      continue;
    }
    const endQuoteIndex = line.indexOf(quote, quoteIndex + 1);
    if (endQuoteIndex > quoteIndex + 1) {
      paths.push(line.slice(quoteIndex + 1, endQuoteIndex));
    }
  }
  return paths;
}

async function collectDeclarationGraph(
  filePath: string,
  activeVfs: Vfs,
  visited: Set<string>,
  declarations: Statement[]
): Promise<void> {
  if (visited.has(filePath)) {
    return;
  }
  visited.add(filePath);
  const source = await activeVfs.readFile(filePath);
  if (source === null) {
    return;
  }
  const parsed = parseSource(source, { language: "typescript" });
  if (!parsed.ast) {
    return;
  }

  for (const statement of parsed.ast.body) {
    declarations.push(statement);
  }
  for (const referencePath of tripleSlashReferencePaths(source)) {
    const targetPath = await resolveDeclarationImport(filePath, referencePath, activeVfs);
    if (targetPath) {
      await collectDeclarationGraph(targetPath, activeVfs, visited, declarations);
    }
  }
  for (const statement of parsed.ast.body) {
    let specifier = "";
    if (statement instanceof ImportStatement) {
      specifier = statement.from.value;
    } else if (statement instanceof ExportStatement && statement.from) {
      specifier = statement.from.value;
    }
    if (!specifier) {
      continue;
    }
    const targetPath = await resolveDeclarationImport(filePath, specifier, activeVfs);
    if (targetPath) {
      await collectDeclarationGraph(targetPath, activeVfs, visited, declarations);
    }
  }
}

export async function resolveNodeModuleImportsForRuntime(
  ast: Program,
  importerFilePath: string,
  activeVfs: Vfs
): Promise<ResolvedNodeModuleImports> {
  const externalDeclarations: Statement[] = [];
  const importedSymbols = new Map<string, ImportedSymbolResolution>();
  const visited = new Set<string>();
  for (const statement of ast.body) {
    if (!(statement instanceof ImportStatement)) {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const specifier: string = importStatement.from.value;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      continue;
    }
    const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, specifier, {
      vfs: activeVfs,
      pnpmVirtualStore: false
    });
    if (!typingsPath) {
      continue;
    }
    await collectDeclarationGraph(typingsPath, activeVfs, visited, externalDeclarations);
    if (importStatement.defaultImport) {
      importedSymbols.set(importStatement.defaultImport.name, {
        type: namedType(importStatement.defaultImport.name)
      });
    }
    if (importStatement.namespaceImport) {
      importedSymbols.set(importStatement.namespaceImport.name, {
        type: namedType(importStatement.namespaceImport.name)
      });
    }
    for (const imported of importStatement.specifiers) {
      const localName = (imported.local ?? imported.imported).name;
      importedSymbols.set(localName, {
        type: namedType(imported.imported.name)
      });
    }
  }
  return {
    externalDeclarations,
    importedSymbols
  };
}
