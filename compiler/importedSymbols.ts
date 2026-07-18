import type { Statement } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";

export interface ImportedSymbolDeclarationOrigin {
  statement: Statement;
  filePath: string;
  exportedName: string;
}

export interface ImportedSymbolResolution {
  type?: AnalysisType;
  displayType?: string;
  declarationOrigin?: ImportedSymbolDeclarationOrigin;
  invalid?: boolean;
}

export interface ImportedSymbolSources {
  importedSymbols?: ReadonlyMap<string, ImportedSymbolResolution> | undefined;
  invalidImportedBindings?: ReadonlySet<string> | undefined;
}

export interface ImportedSymbolViews {
  importedSymbols: Map<string, ImportedSymbolResolution>;
  invalidImportedBindings: Set<string>;
}

export function getImportedSymbolResolution(
  importedSymbols: Map<string, ImportedSymbolResolution>,
  localName: string
): ImportedSymbolResolution {
  const existing = importedSymbols.get(localName);
  if (existing) {
    return existing;
  }
  const created: ImportedSymbolResolution = {};
  importedSymbols.set(localName, created);
  return created;
}

export function collectInvalidImportedBindings(
  importedSymbols: ReadonlyMap<string, ImportedSymbolResolution>
): Set<string> {
  const invalidImportedBindings = new Set<string>();

  for (const [localName, resolution] of importedSymbols) {
    if (resolution.invalid) {
      invalidImportedBindings.add(localName);
    }
  }

  return invalidImportedBindings;
}

export function normalizeImportedSymbolSources(sources: ImportedSymbolSources = {}): ImportedSymbolViews {
  const importedSymbols: Map<string, ImportedSymbolResolution> = sources.importedSymbols
    ? new Map(sources.importedSymbols)
    : new Map<string, ImportedSymbolResolution>();

  for (const localName of sources.invalidImportedBindings ?? new Set()) {
    const resolution = getImportedSymbolResolution(importedSymbols, localName);
    if (!resolution.type && !resolution.displayType && !resolution.declarationOrigin) {
      resolution.invalid = true;
    }
  }

  return {
    importedSymbols,
    invalidImportedBindings: collectInvalidImportedBindings(importedSymbols)
  };
}
