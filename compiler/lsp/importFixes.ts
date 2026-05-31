import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ClassStatement,
  FunctionStatement,
  ImportStatement,
  Program,
  Statement,
  VarStatement
} from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "vscode-languageserver/node.js";

const UNDEFINED_VARIABLE_PATTERN = /^Undefined variable '([A-Za-z_][A-Za-z0-9_]*)'$/;

export interface SymbolExport {
  name: string;
  filePath: string;
  kind: "class" | "function" | "variable";
}

function scanMyFiles(root: string): string[] {
  const stack = [root];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && extname(entry.name) === ".my") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function topLevelDeclaredNames(program: Program): Array<{
  name: string;
  kind: "class" | "function" | "variable";
}> {
  const names: Array<{ name: string; kind: "class" | "function" | "variable" }> = [];
  for (const statement of program.body) {
    if (statement.kind === "ClassStatement") {
      names.push({ name: (statement as ClassStatement).name.name, kind: "class" });
      continue;
    }
    if (statement.kind === "FunctionStatement") {
      names.push({ name: (statement as FunctionStatement).name.name, kind: "function" });
      continue;
    }
    if (statement.kind === "VarStatement") {
      const variableStatement = statement as VarStatement;
      if (variableStatement.declarations && variableStatement.declarations.length > 0) {
        for (const declaration of variableStatement.declarations) {
          names.push({ name: declaration.name.name, kind: "variable" });
        }
      } else {
        names.push({ name: variableStatement.name.name, kind: "variable" });
      }
    }
  }
  return names;
}

export function buildSymbolExports(sourceRoots: string[]): SymbolExport[] {
  const exports: SymbolExport[] = [];

  for (const root of sourceRoots) {
    for (const filePath of scanMyFiles(root)) {
      try {
        const source = readFileSync(filePath, "utf8");
        const session = createAnalysisSession(source);
        if (!session.ast) {
          continue;
        }
        for (const symbol of topLevelDeclaredNames(session.ast)) {
          exports.push({ ...symbol, filePath });
        }
      } catch {
        // Ignore unreadable files for quick-fix discovery.
      }
    }
  }

  return exports;
}

function extractUndefinedSymbols(diagnostics: Diagnostic[]): string[] {
  const names = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.source !== "mylang-sema") {
      continue;
    }
    const match = UNDEFINED_VARIABLE_PATTERN.exec(diagnostic.message);
    if (!match) {
      continue;
    }
    names.add(match[1]);
  }
  return Array.from(names.values());
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

export function createAutoImportCodeActions(params: {
  uri: string;
  ast: Program | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
}): CodeAction[] {
  const { uri, ast, diagnostics, sourceRoots } = params;
  if (!ast || sourceRoots.length === 0) {
    return [];
  }

  const currentFilePath = uriToFilePath(uri);
  if (!currentFilePath) {
    return [];
  }

  const undefinedSymbols = extractUndefinedSymbols(diagnostics);
  if (undefinedSymbols.length === 0) {
    return [];
  }

  const exportedSymbols = buildSymbolExports(sourceRoots);
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
    const best = chooseBestExport(candidates, currentFilePath);
    if (!best) {
      continue;
    }

    const importPath = toImportPath(currentFilePath, best.filePath);
    actions.push({
      title: `Import '${symbolName}' from '${importPath}'`,
      kind: CodeActionKind.QuickFix,
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
    });
  }

  return actions;
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).toString();
}

export interface AutoImportSuggestion {
  symbol: SymbolExport;
  importPath: string;
  range: Range;
}

export function buildAutoImportSuggestions(params: {
  uri: string;
  ast: Program | null;
  sourceRoots: string[];
  prefix?: string;
  excludeSymbols?: Set<string>;
}): AutoImportSuggestion[] {
  const { uri, ast, sourceRoots, prefix, excludeSymbols } = params;
  if (!ast || sourceRoots.length === 0) {
    return [];
  }

  const currentFilePath = uriToFilePath(uri);
  if (!currentFilePath) {
    return [];
  }

  const exportedSymbols = buildSymbolExports(sourceRoots);
  if (exportedSymbols.length === 0) {
    return [];
  }

  const normalizedPrefix = prefix?.trim() ?? "";
  if (normalizedPrefix.length === 0) {
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
