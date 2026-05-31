import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type { Analysis } from "compiler/analysis/Analysis";
import type {
  ClassStatement,
  FunctionStatement,
  ImportStatement,
  Program,
  Statement,
  VarStatement
} from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import type { Location, WorkspaceEdit } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";

interface SessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

interface ResolveContext {
  uri: string;
  line: number;
  character: number;
  session: SessionLike;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => SessionLike | null;
}

interface CanonicalSymbol {
  name: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function nodeToRange(node: { firstToken?: { range: { start: { line: number; column: number } } }; lastToken?: { range: { end: { line: number; column: number } } } }) {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
}

function scanMyFiles(sourceRoots: string[]): string[] {
  const files: string[] = [];
  const stack = [...sourceRoots];
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
      } else if (entry.isFile() && extname(entry.name) === ".my") {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function resolveImportTargetFilePath(importerFilePath: string, importPath: string): string | null {
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  if (existsSync(direct)) {
    return direct;
  }
  if (!extname(direct)) {
    const withMyExt = `${direct}.my`;
    if (existsSync(withMyExt)) {
      return withMyExt;
    }
  }
  return null;
}

function findImportForSymbolNode(ast: Program, symbolNode: unknown): { from: string; name: string } | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported === symbolNode) {
        return { from: importStatement.from.value, name: specifier.imported.name };
      }
    }
  }
  return null;
}

function findTopLevelDeclarationByName(ast: Program, name: string): Statement | null {
  for (const statement of ast.body) {
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      if (classStatement.name.name === name) {
        return classStatement;
      }
    }
    if (statement.kind === "FunctionStatement") {
      const functionStatement = statement as FunctionStatement;
      if (functionStatement.name.name === name) {
        return functionStatement;
      }
    }
    if (statement.kind === "VarStatement") {
      const variableStatement = statement as VarStatement;
      if (
        variableStatement.declarations &&
        variableStatement.declarations.some((declaration) => declaration.name.name === name)
      ) {
        return variableStatement;
      }
      if (variableStatement.name.name === name) {
        return variableStatement;
      }
    }
  }
  return null;
}

function declarationRangeForName(statement: Statement, name: string) {
  if (statement.kind === "VarStatement") {
    const variableStatement = statement as VarStatement;
    if (variableStatement.declarations && variableStatement.declarations.length > 0) {
      const declaration = variableStatement.declarations.find((item) => item.name.name === name);
      if (declaration) {
        return nodeToRange(declaration.name);
      }
    }
    return nodeToRange(variableStatement.name);
  }
  if (statement.kind === "ClassStatement") {
    return nodeToRange((statement as ClassStatement).name);
  }
  if (statement.kind === "FunctionStatement") {
    return nodeToRange((statement as FunctionStatement).name);
  }
  return nodeToRange(statement);
}

function getSessionForFilePath(filePath: string, context: ResolveContext): SessionLike | null {
  if (context.getSessionForFilePath) {
    const provided = context.getSessionForFilePath(filePath);
    if (provided) {
      return provided;
    }
  }
  if (!existsSync(filePath)) {
    return null;
  }
  const source = readFileSync(filePath, "utf8");
  const artifacts = compileSource(source);
  return {
    ast: artifacts.ast,
    analysis: artifacts.analysis
  };
}

function resolveCanonicalSymbol(context: ResolveContext): CanonicalSymbol | null {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.analysis || !context.session.ast) {
    return null;
  }

  const definition = context.session.analysis.getDefinitionAt(context.line, context.character);
  const symbolAt = context.session.analysis.getSymbolAt(context.line, context.character);
  if (!definition || !symbolAt) {
    return null;
  }

  const importBinding = findImportForSymbolNode(context.session.ast, symbolAt.symbol.node);
  if (!importBinding) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const targetFilePath = resolveImportTargetFilePath(currentFilePath, importBinding.from);
  if (!targetFilePath) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const targetSession = getSessionForFilePath(targetFilePath, context);
  if (!targetSession?.ast) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const declaration = findTopLevelDeclarationByName(targetSession.ast, importBinding.name);
  const targetRange = declaration ? declarationRangeForName(declaration, importBinding.name) : null;
  if (!targetRange) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  return {
    name: importBinding.name,
    filePath: targetFilePath,
    range: targetRange
  };
}

function rangesEqual(
  a: { start: { line: number; character: number }; end: { line: number; character: number } },
  b: { start: { line: number; character: number }; end: { line: number; character: number } }
): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function findMatchingImportSpecifierPositions(
  importerAst: Program,
  importerFilePath: string,
  symbol: CanonicalSymbol
): Array<{ line: number; character: number }> {
  const positions: Array<{ line: number; character: number }> = [];
  for (const statement of importerAst.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = resolveImportTargetFilePath(importerFilePath, importStatement.from.value);
    if (!targetFilePath || resolve(targetFilePath) !== resolve(symbol.filePath)) {
      continue;
    }
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported.name !== symbol.name || !specifier.imported.firstToken) {
        continue;
      }
      positions.push({
        line: specifier.imported.firstToken.range.start.line,
        character: specifier.imported.firstToken.range.start.column
      });
    }
  }
  return positions;
}

export function resolveDefinitionAcrossFiles(context: ResolveContext): Location | null {
  const symbol = resolveCanonicalSymbol(context);
  if (!symbol) {
    return null;
  }
  return {
    uri: pathToUri(symbol.filePath),
    range: symbol.range
  };
}

export function resolveReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Location[] {
  const symbol = resolveCanonicalSymbol(context);
  if (!symbol) {
    return [];
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(symbol.filePath)];
  const files = scanMyFiles(roots);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  for (const filePath of files) {
    const session = getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }
    const uri = pathToUri(filePath);

    if (resolve(filePath) === resolve(symbol.filePath)) {
      const declaration = findTopLevelDeclarationByName(session.ast, symbol.name);
      const declarationRange = declaration ? declarationRangeForName(declaration, symbol.name) : null;
      if (!declarationRange) {
        continue;
      }

      const references = session.analysis.getReferenceRangesAt(
        declarationRange.start.line,
        declarationRange.start.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
      continue;
    }

    const importPositions = findMatchingImportSpecifierPositions(session.ast, filePath, symbol);
    for (const position of importPositions) {
      const references = session.analysis.getReferenceRangesAt(
        position.line,
        position.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
    }
  }

  if (!includeDeclaration) {
    return locations.filter((location) => !(
      location.uri === pathToUri(symbol.filePath) && rangesEqual(location.range, symbol.range)
    ));
  }

  return locations;
}

export function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): WorkspaceEdit | null {
  const locations = resolveReferencesAcrossFiles(context, true);
  if (locations.length === 0) {
    return null;
  }

  const changes: Record<string, Array<{ range: Location["range"]; newText: string }>> = {};
  for (const location of locations) {
    if (!changes[location.uri]) {
      changes[location.uri] = [];
    }
    changes[location.uri]?.push({
      range: location.range,
      newText: newName
    });
  }

  return { changes };
}
