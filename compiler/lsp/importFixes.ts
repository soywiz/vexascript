import { dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ImportStatement,
  Program,
  Statement
} from "compiler/ast/ast";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { getProjectIndex, type ProjectTopLevelDeclarationKind } from "./projectAnalysis";
import {
  isUndefinedVariableDiagnostic,
  isMissingMemberDiagnostic,
  isUnknownTypeDiagnostic,
  isOperatorNotDefinedDiagnostic,
  UNDEFINED_VARIABLE_PATTERN,
  MISSING_MEMBER_PATTERN,
  UNKNOWN_TYPE_PATTERN,
  OPERATOR_NOT_DEFINED_PATTERN
} from "./diagnosticCodes";

export interface SymbolExport {
  name: string;
  filePath: string;
  kind: ProjectTopLevelDeclarationKind;
  receiverType?: string;
  memberKind?: "property" | "method";
}

export interface SymbolExportProvider {
  (): Promise<SymbolExport[]> | SymbolExport[];
}

const CODE_ACTION_KIND_QUICK_FIX = "quickfix";

export async function buildSymbolExports(sourceRoots: string[]): Promise<SymbolExport[]> {
  const exports: SymbolExport[] = [];
  const projectIndex = getProjectIndex(sourceRoots);

  try {
    for (const entry of await projectIndex.collectWorkspaceTopLevelDeclarations("")) {
      exports.push({
        name: entry.declaration.name,
        kind: entry.declaration.kind,
        ...(entry.declaration.receiverType !== undefined ? { receiverType: entry.declaration.receiverType } : {}),
        ...(entry.declaration.memberKind !== undefined ? { memberKind: entry.declaration.memberKind } : {}),
        filePath: entry.filePath
      });
    }
  } catch {
    // Ignore unreadable files for quick-fix discovery.
  }

  return exports;
}

async function resolveAvailableSymbolExports(params: {
  sourceRoots: string[];
  getExportedSymbols?: SymbolExportProvider;
}): Promise<SymbolExport[]> {
  if (params.getExportedSymbols) {
    return await params.getExportedSymbols();
  }
  if (params.sourceRoots.length === 0) {
    return [];
  }
  return buildSymbolExports(params.sourceRoots);
}

/**
 * Reduces a type-name string (which may include generic arguments, array
 * suffixes, or member access) to the leading identifier that could be imported,
 * e.g. `TimeSpan<int>[]` -> `TimeSpan`.
 */
function baseTypeIdentifier(typeName: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(typeName.trim());
  return match?.[1] ?? null;
}

function extractImportableSymbols(diagnostics: Diagnostic[]): string[] {
  const names = new Set<string>();
  for (const diagnostic of diagnostics) {
    const pattern = isUndefinedVariableDiagnostic(diagnostic)
      ? UNDEFINED_VARIABLE_PATTERN
      : isMissingMemberDiagnostic(diagnostic)
        ? MISSING_MEMBER_PATTERN
        : isUnknownTypeDiagnostic(diagnostic)
          ? UNKNOWN_TYPE_PATTERN
          : null;
    if (!pattern) continue;
    const match = pattern.exec(diagnostic.message);
    if (!match) {
      continue;
    }
    const captured = match[1];
    if (!captured) {
      continue;
    }
    const symbolName = pattern === UNKNOWN_TYPE_PATTERN ? baseTypeIdentifier(captured) : captured;
    if (symbolName) {
      names.add(symbolName);
    }
  }
  return Array.from(names.values());
}

interface OperatorImportRequest {
  /** The synthesized symbol name to import, e.g. "operator+". */
  symbolName: string;
  /** The receiver type the operator is defined on, e.g. "Point". */
  receiverType: string;
}

function extractOperatorImports(diagnostics: Diagnostic[]): OperatorImportRequest[] {
  const requests: OperatorImportRequest[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!isOperatorNotDefinedDiagnostic(diagnostic)) {
      continue;
    }
    const match = OPERATOR_NOT_DEFINED_PATTERN.exec(diagnostic.message);
    if (!match) {
      continue;
    }
    const operator = match[1];
    const leftType = match[2];
    if (!operator || !leftType) {
      continue;
    }
    // The receiver of a binary operator overload is the left-hand operand type.
    const key = `${leftType}::operator${operator}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    requests.push({ symbolName: `operator${operator}`, receiverType: leftType });
  }
  return requests;
}

export function hasImportedSymbol(ast: Program, symbolName: string): boolean {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    if (importStatement.specifiers.some((specifier) => specifier.imported.name === symbolName)) {
      return true;
    }
  }
  return false;
}

export function toImportPath(fromFilePath: string, targetFilePath: string): string {
  const fromDir = dirname(fromFilePath);
  const relativePath = relative(fromDir, targetFilePath).replace(/\\/g, "/");
  const withoutExt = relativePath.endsWith(".my")
    ? relativePath.slice(0, -3)
    : relativePath;
  if (withoutExt.startsWith(".")) {
    return withoutExt;
  }
  return `./${withoutExt}`;
}

function chooseBestExport(
  candidates: SymbolExport[],
  currentFilePath: string
): SymbolExport | null {
  if (candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    const aRel = relative(dirname(currentFilePath), a.filePath);
    const bRel = relative(dirname(currentFilePath), b.filePath);
    return aRel.length - bRel.length;
  });
  return sorted[0] ?? null;
}

function findExistingImportFromPath(ast: Program, importPath: string): ImportStatement | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") break;
    const importStmt = statement as ImportStatement;
    if (importStmt.from.value === importPath) {
      return importStmt;
    }
  }
  return null;
}

export function importInsertionRange(ast: Program): Range {
  let lastImport: Statement | null = null;
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      break;
    }
    lastImport = statement;
  }

  if (!lastImport?.lastToken) {
    return {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 }
    };
  }

  const line = lastImport.lastToken.range.end.line + 1;
  return {
    start: { line, character: 0 },
    end: { line, character: 0 }
  };
}

export function uriToFilePath(uri: string): string | null {
  if (!uri.startsWith("file://")) {
    return null;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export async function createAutoImportCodeActions(params: {
  uri: string;
  ast: Program | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getExportedSymbols?: SymbolExportProvider;
}): Promise<CodeAction[]> {
  const { uri, ast, diagnostics, sourceRoots } = params;
  if (!ast) {
    return [];
  }

  const currentFilePath = uriToFilePath(uri);
  if (!currentFilePath) {
    return [];
  }

  const undefinedSymbols = extractImportableSymbols(diagnostics);
  const operatorImports = extractOperatorImports(diagnostics);
  if (undefinedSymbols.length === 0 && operatorImports.length === 0) {
    return [];
  }

  const exportedSymbols = await resolveAvailableSymbolExports({
    sourceRoots,
    ...(params.getExportedSymbols ? { getExportedSymbols: params.getExportedSymbols } : {}),
  });
  if (exportedSymbols.length === 0) {
    return [];
  }

  const actions: CodeAction[] = [];
  const range = importInsertionRange(ast);

  for (const symbolName of undefinedSymbols) {
    if (hasImportedSymbol(ast, symbolName)) {
      continue;
    }

    const candidates = exportedSymbols.filter(
      (symbolExport) =>
        symbolExport.name === symbolName &&
        symbolExport.filePath !== currentFilePath
    );
    const action = buildImportCodeAction({ uri, ast, range, symbolName, candidates, currentFilePath });
    if (action) {
      actions.push(action);
    }
  }

  for (const { symbolName, receiverType } of operatorImports) {
    if (hasImportedSymbol(ast, symbolName)) {
      continue;
    }

    const candidates = exportedSymbols.filter(
      (symbolExport) =>
        symbolExport.name === symbolName &&
        symbolExport.receiverType === receiverType &&
        symbolExport.filePath !== currentFilePath
    );
    const action = buildImportCodeAction({ uri, ast, range, symbolName, candidates, currentFilePath });
    if (action) {
      actions.push(action);
    }
  }

  return actions;
}

function buildImportCodeAction(params: {
  uri: string;
  ast: Program;
  range: Range;
  symbolName: string;
  candidates: SymbolExport[];
  currentFilePath: string;
}): CodeAction | null {
  const { uri, ast, range, symbolName, candidates, currentFilePath } = params;
  const best = chooseBestExport(candidates, currentFilePath);
  if (!best) {
    return null;
  }

  const importPath = toImportPath(currentFilePath, best.filePath);
  const existingImport = findExistingImportFromPath(ast, importPath);

  if (existingImport?.firstToken && existingImport?.lastToken) {
    const existingNames = existingImport.specifiers.map((s) => s.imported.name);
    const allNames = [...existingNames, symbolName];
    const clauses: string[] = [];
    if (existingImport.defaultImport) clauses.push(existingImport.defaultImport.name);
    if (existingImport.namespaceImport) clauses.push(`* as ${existingImport.namespaceImport.name}`);
    if (allNames.length > 0) clauses.push(`{ ${allNames.join(", ")} }`);
    const start = existingImport.firstToken.range.start;
    const end = existingImport.lastToken.range.end;
    return {
      title: `Import '${symbolName}' from '${importPath}'`,
      kind: CODE_ACTION_KIND_QUICK_FIX,
      edit: {
        changes: {
          [uri]: [
            {
              range: {
                start: { line: start.line, character: start.column },
                end: { line: end.line, character: end.column }
              },
              newText: `import ${clauses.join(", ")} from "${importPath}"`
            }
          ]
        }
      }
    };
  }

  return {
    title: `Import '${symbolName}' from '${importPath}'`,
    kind: CODE_ACTION_KIND_QUICK_FIX,
    edit: {
      changes: {
        [uri]: [
          {
            range,
            newText: `import { ${symbolName} } from "${importPath}"\n`
          }
        ]
      }
    }
  };
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).toString();
}

export interface AutoImportSuggestion {
  symbol: SymbolExport;
  importPath: string;
  range: Range;
}

export async function buildExtensionAutoImportSuggestions(params: {
  uri: string;
  ast: Program | null;
  sourceRoots: string[];
  getExportedSymbols?: SymbolExportProvider;
  receiverType: string;
  prefix?: string;
  memberKind?: "property" | "method";
  excludeSymbols?: Set<string>;
}): Promise<AutoImportSuggestion[]> {
  const { receiverType, memberKind } = params;
  return (await buildAutoImportSuggestions({
    ...params,
    allowEmptyPrefix: true
  })).filter(({ symbol }) => {
    if (!symbol.receiverType) {
      return false;
    }
    const receiverMatches =
      symbol.receiverType === receiverType ||
      (receiverType === "int" && symbol.receiverType === "number");
    if (!receiverMatches) {
      return false;
    }
    if (memberKind && symbol.memberKind !== memberKind) {
      return false;
    }
    return true;
  });
}

export async function buildAutoImportSuggestions(params: {
  uri: string;
  ast: Program | null;
  sourceRoots: string[];
  getExportedSymbols?: SymbolExportProvider;
  prefix?: string;
  allowEmptyPrefix?: boolean;
  excludeSymbols?: Set<string>;
}): Promise<AutoImportSuggestion[]> {
  const { uri, ast, sourceRoots, prefix, allowEmptyPrefix, excludeSymbols } = params;
  if (!ast) {
    return [];
  }

  const currentFilePath = uriToFilePath(uri);
  if (!currentFilePath) {
    return [];
  }

  const exportedSymbols = await resolveAvailableSymbolExports({
    sourceRoots,
    ...(params.getExportedSymbols ? { getExportedSymbols: params.getExportedSymbols } : {}),
  });
  if (exportedSymbols.length === 0) {
    return [];
  }

  const normalizedPrefix = prefix?.trim() ?? "";
  if (normalizedPrefix.length === 0 && allowEmptyPrefix !== true) {
    return [];
  }
  const results: AutoImportSuggestion[] = [];
  const seen = new Set<string>();
  const range = importInsertionRange(ast);

  for (const symbolExport of exportedSymbols) {
    if (symbolExport.filePath === currentFilePath) {
      continue;
    }
    if (excludeSymbols?.has(symbolExport.name)) {
      continue;
    }
    if (hasImportedSymbol(ast, symbolExport.name)) {
      continue;
    }
    if (normalizedPrefix.length > 0 && !symbolExport.name.startsWith(normalizedPrefix)) {
      continue;
    }
    if (seen.has(symbolExport.name)) {
      continue;
    }

    const candidates = exportedSymbols.filter(
      (candidate) =>
        candidate.name === symbolExport.name &&
        candidate.filePath !== currentFilePath
    );
    const best = chooseBestExport(candidates, currentFilePath);
    if (!best) {
      continue;
    }

    const importPath = toImportPath(currentFilePath, best.filePath);
    seen.add(best.name);
    results.push({
      symbol: best,
      importPath,
      range
    });
  }

  return results.sort((a, b) => a.symbol.name.localeCompare(b.symbol.name));
}
