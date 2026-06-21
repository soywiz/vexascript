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
  importedSymbols?: ReadonlyMap<string, ImportedSymbolResolution>;
  importedSymbolTypes?: ReadonlyMap<string, AnalysisType>;
  importedSymbolDisplayTypes?: ReadonlyMap<string, string>;
  invalidImportedBindings?: ReadonlySet<string>;
}

export interface ImportedSymbolViews {
  importedSymbols: Map<string, ImportedSymbolResolution>;
  importedSymbolTypes: Map<string, AnalysisType>;
  importedSymbolDisplayTypes: Map<string, string>;
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

export function collectImportedSymbolViews(
  importedSymbols: ReadonlyMap<string, ImportedSymbolResolution>
): Omit<ImportedSymbolViews, "importedSymbols"> {
  const importedSymbolTypes = new Map<string, AnalysisType>();
  const importedSymbolDisplayTypes = new Map<string, string>();
  const invalidImportedBindings = new Set<string>();

  for (const [localName, resolution] of importedSymbols) {
    if (resolution.type) {
      importedSymbolTypes.set(localName, resolution.type);
    }
    if (resolution.displayType) {
      importedSymbolDisplayTypes.set(localName, resolution.displayType);
    }
    if (resolution.invalid) {
      invalidImportedBindings.add(localName);
    }
  }

  return {
    importedSymbolTypes,
    importedSymbolDisplayTypes,
    invalidImportedBindings
  };
}

export function normalizeImportedSymbolSources(sources: ImportedSymbolSources = {}): ImportedSymbolViews {
  const importedSymbols = sources.importedSymbols
    ? new Map(sources.importedSymbols)
    : new Map<string, ImportedSymbolResolution>();

  for (const [localName, type] of sources.importedSymbolTypes ?? new Map()) {
    getImportedSymbolResolution(importedSymbols, localName).type = type;
  }
  for (const [localName, displayType] of sources.importedSymbolDisplayTypes ?? new Map()) {
    getImportedSymbolResolution(importedSymbols, localName).displayType = displayType;
  }
  for (const localName of sources.invalidImportedBindings ?? new Set()) {
    const resolution = getImportedSymbolResolution(importedSymbols, localName);
    if (!resolution.type && !resolution.displayType && !resolution.declarationOrigin) {
      resolution.invalid = true;
    }
  }

  const views = collectImportedSymbolViews(importedSymbols);
  return {
    importedSymbols,
    ...views
  };
}
