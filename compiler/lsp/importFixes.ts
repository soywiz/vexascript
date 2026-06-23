import type {
  ExportStatement,
  FunctionStatement,
  ImportStatement,
  ClassStatement,
  InterfaceStatement,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { CodeAction, Diagnostic, Range, TextEdit } from "vscode-languageserver/node.js";
import { getProjectIndex, type ProjectTopLevelDeclarationKind } from "./projectAnalysis";
import { dirname, fileURLToPath, pathToFileURL, relative } from "compiler/utils/path";
import {
  parseMissingMemberDiagnostic,
  parseOperatorNotDefinedDiagnostic,
  parseUndefinedVariableDiagnostic,
  parseUnknownTypeDiagnostic
} from "./diagnosticCodes";
import { detectAmbientExportEqualsName, findAmbientNamespaceBody } from "./crossFileContext";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import type { AmbientModuleLocation } from "./ambientTypesLoader";

export interface SymbolExport {
  name: string;
  filePath: string;
  kind: ProjectTopLevelDeclarationKind;
  importPath?: string;
  typeOnly?: boolean;
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

function ambientExportFilePath(
  moduleName: string,
  moduleLocations?: ReadonlyMap<string, { filePath: string }>
): string {
  return moduleLocations?.get(moduleName)?.filePath ?? `/ambient/${moduleName}.d.ts`;
}

function directAmbientDeclaration(statement: Statement): Statement {
  return statement.kind === "ExportStatement"
    ? (statement as ExportStatement).declaration ?? statement
    : statement;
}

function pushAmbientSymbolExport(
  exports: SymbolExport[],
  seen: Set<string>,
  moduleName: string,
  filePath: string,
  name: string,
  kind: ProjectTopLevelDeclarationKind
): void {
  const key = `${moduleName}::${name}::${kind}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  exports.push({ name, kind, filePath, importPath: moduleName });
}

function collectDirectAmbientExports(
  declarations: readonly Statement[],
  moduleName: string,
  filePath: string,
  exports: SymbolExport[],
  seen: Set<string>
): void {
  for (const statement of declarations) {
    const declaration = directAmbientDeclaration(statement);
    if (declaration.kind === "ClassStatement") {
      pushAmbientSymbolExport(exports, seen, moduleName, filePath, (declaration as ClassStatement).name.name, "class");
    } else if (declaration.kind === "InterfaceStatement") {
      pushAmbientSymbolExport(exports, seen, moduleName, filePath, (declaration as InterfaceStatement).name.name, "interface");
    } else if (declaration.kind === "TypeAliasStatement") {
      pushAmbientSymbolExport(exports, seen, moduleName, filePath, (declaration as TypeAliasStatement).name.name, "type");
    } else if (declaration.kind === "FunctionStatement") {
      pushAmbientSymbolExport(exports, seen, moduleName, filePath, (declaration as FunctionStatement).name.name, "function");
    } else if (declaration.kind === "VarStatement") {
      const variable = declaration as VarStatement;
      if (variable.name.kind === "Identifier") {
        pushAmbientSymbolExport(exports, seen, moduleName, filePath, variable.name.name, "variable");
      }
    }
  }
}

function findAmbientInterface(declarations: readonly Statement[], interfaceName: string): InterfaceStatement | null {
  for (const statement of declarations) {
    const declaration = directAmbientDeclaration(statement);
    if (declaration.kind === "InterfaceStatement" && (declaration as InterfaceStatement).name.name === interfaceName) {
      return declaration as InterfaceStatement;
    }
  }
  return null;
}

function collectExportEqualsAmbientExports(
  declarations: readonly Statement[],
  moduleName: string,
  filePath: string,
  exports: SymbolExport[],
  seen: Set<string>
): void {
  const exportEqualsName = detectAmbientExportEqualsName(declarations);
  if (!exportEqualsName) {
    return;
  }

  const exportNamespaceBody = findAmbientNamespaceBody(declarations, exportEqualsName);
  if (exportNamespaceBody) {
    collectDirectAmbientExports(exportNamespaceBody, moduleName, filePath, exports, seen);
  }

  for (const statement of declarations) {
    const declaration = directAmbientDeclaration(statement);
    if (declaration.kind !== "VarStatement") {
      continue;
    }
    const variable = declaration as VarStatement;
    if (variable.name.kind !== "Identifier" || variable.name.name !== exportEqualsName || !variable.typeAnnotation?.name) {
      continue;
    }
    const typeName = variable.typeAnnotation.name;
    const separator = typeName.lastIndexOf(".");
    const namespaceName = separator > 0 ? typeName.slice(0, separator) : null;
    const interfaceName = separator > 0 ? typeName.slice(separator + 1) : typeName;
    const searchDeclarations = namespaceName ? findAmbientNamespaceBody(declarations, namespaceName) : declarations;
    if (!searchDeclarations) {
      continue;
    }
    const interfaceDeclaration = findAmbientInterface(searchDeclarations, interfaceName);
    if (!interfaceDeclaration) {
      continue;
    }
    for (const member of interfaceDeclaration.members) {
      pushAmbientSymbolExport(
        exports,
        seen,
        moduleName,
        filePath,
        member.name.name,
        member.kind === "InterfaceMethodMember" ? "function" : "variable"
      );
    }
  }
}

export function buildAmbientModuleSymbolExports(params: {
  moduleDeclarations: ReadonlyMap<string, Statement[]>;
  moduleLocations?: ReadonlyMap<string, AmbientModuleLocation>;
}): SymbolExport[] {
  const { moduleDeclarations, moduleLocations } = params;
  const exports: SymbolExport[] = [];
  const seen = new Set<string>();

  for (const [moduleName, declarations] of moduleDeclarations) {
    const filePath = ambientExportFilePath(moduleName, moduleLocations);
    const beforeDirect = exports.length;
    collectDirectAmbientExports(declarations, moduleName, filePath, exports, seen);
    collectExportEqualsAmbientExports(declarations, moduleName, filePath, exports, seen);

    if (moduleName.startsWith("node:")) {
      const baseModuleName = moduleName.slice("node:".length);
      const baseDeclarations = moduleDeclarations.get(baseModuleName);
      if (baseDeclarations) {
        const hadDirectExports = exports.length > beforeDirect;
        if (!hadDirectExports) {
          collectDirectAmbientExports(baseDeclarations, moduleName, filePath, exports, seen);
          collectExportEqualsAmbientExports(baseDeclarations, moduleName, filePath, exports, seen);
        }
      }
    }
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
    const undefinedVariable = parseUndefinedVariableDiagnostic(diagnostic);
    if (undefinedVariable) {
      names.add(undefinedVariable.name);
      continue;
    }

    const missingMember = parseMissingMemberDiagnostic(diagnostic);
    if (missingMember) {
      names.add(missingMember.memberName);
      continue;
    }

    const unknownType = parseUnknownTypeDiagnostic(diagnostic);
    const symbolName = unknownType ? baseTypeIdentifier(unknownType.typeName) : null;
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
    const operatorDiagnostic = parseOperatorNotDefinedDiagnostic(diagnostic);
    if (!operatorDiagnostic) {
      continue;
    }
    // The receiver of a binary operator overload is the left-hand operand type.
    const key = `${operatorDiagnostic.leftType}::operator${operatorDiagnostic.operator}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    requests.push({
      symbolName: `operator${operatorDiagnostic.operator}`,
      receiverType: operatorDiagnostic.leftType
    });
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
  if (relativePath.startsWith(".")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

function importPathForSymbolExport(symbolExport: SymbolExport, currentFilePath: string): string {
  return symbolExport.importPath ?? toImportPath(currentFilePath, symbolExport.filePath);
}

function isTypeOnlySymbolExport(symbolExport: SymbolExport): boolean {
  return symbolExport.typeOnly === true || symbolExport.kind === "type" || symbolExport.kind === "interface";
}

function isBareModuleSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

async function collectNodeModuleExportsFromExistingImports(
  ast: Program,
  currentFilePath: string
): Promise<SymbolExport[]> {
  const imports = new Set<string>();
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importPath = (statement as ImportStatement).from.value;
    if (isBareModuleSpecifier(importPath)) {
      imports.add(importPath);
    }
  }

  const exports: SymbolExport[] = [];
  const seen = new Set<string>();
  for (const importPath of imports) {
    const typings = await getNodeModuleTypings(currentFilePath, importPath);
    if (!typings) {
      continue;
    }
    for (const statement of typings.declarations) {
      const declaration = unwrapExportedDeclaration(statement);
      if (!declaration) {
        continue;
      }
      const typeOnly = statement.kind === "ExportStatement" && (statement as ExportStatement).typeOnly === true;
      let name: string | null = null;
      let kind: ProjectTopLevelDeclarationKind | null = null;
      if (declaration.kind === "ClassStatement") {
        name = (declaration as ClassStatement).name.name;
        kind = "class";
      } else if (declaration.kind === "InterfaceStatement") {
        name = (declaration as InterfaceStatement).name.name;
        kind = "interface";
      } else if (declaration.kind === "TypeAliasStatement") {
        name = (declaration as TypeAliasStatement).name.name;
        kind = "type";
      } else if (declaration.kind === "FunctionStatement") {
        name = (declaration as FunctionStatement).name.name;
        kind = "function";
      } else if (declaration.kind === "VarStatement" && (declaration as VarStatement).name.kind === "Identifier") {
        name = ((declaration as VarStatement).name as { name: string }).name;
        kind = "variable";
      }
      if (!name || !kind) {
        continue;
      }
      const key = `${importPath}::${name}::${kind}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      exports.push({
        name,
        kind,
        filePath: `/node_modules/${importPath}`,
        importPath,
        ...(typeOnly || kind === "type" || kind === "interface" ? { typeOnly: true } : {})
      });
    }
  }

  return exports;
}

function findExistingImportsFromPath(ast: Program, importPath: string): ImportStatement[] {
  const matches: ImportStatement[] = [];
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") break;
    const importStmt = statement as ImportStatement;
    if (importStmt.from.value === importPath) {
      matches.push(importStmt);
    }
  }
  return matches;
}

function importedModulePaths(ast: Program): Set<string> {
  const paths = new Set<string>();
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    paths.add((statement as ImportStatement).from.value);
  }
  return paths;
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
  const nodeModuleExports = await collectNodeModuleExportsFromExistingImports(ast, currentFilePath);
  const availableSymbols = [...exportedSymbols, ...nodeModuleExports];
  if (availableSymbols.length === 0) {
    return [];
  }

  const actions: CodeAction[] = [];
  const range = importInsertionRange(ast);

  for (const symbolName of undefinedSymbols) {
    if (hasImportedSymbol(ast, symbolName)) {
      continue;
    }

    const candidates = availableSymbols.filter(
      (symbolExport) =>
        symbolExport.name === symbolName &&
        symbolExport.filePath !== currentFilePath
    );
    actions.push(...buildImportCodeActions({ uri, ast, range, symbolName, candidates, currentFilePath }));
  }

  for (const { symbolName, receiverType } of operatorImports) {
    if (hasImportedSymbol(ast, symbolName)) {
      continue;
    }

    const candidates = availableSymbols.filter(
      (symbolExport) =>
        symbolExport.name === symbolName &&
        symbolExport.receiverType === receiverType &&
        symbolExport.filePath !== currentFilePath
    );
    actions.push(...buildImportCodeActions({ uri, ast, range, symbolName, candidates, currentFilePath }));
  }

  return actions;
}

function buildImportCodeAction(params: {
  uri: string;
  ast: Program;
  range: Range;
  symbolName: string;
  candidate: SymbolExport;
  currentFilePath: string;
}): CodeAction | null {
  const { uri, ast, range, symbolName, candidate, currentFilePath } = params;
  const importPath = importPathForSymbolExport(candidate, currentFilePath);

  return {
    title: `Import '${symbolName}' from '${importPath}'`,
    kind: CODE_ACTION_KIND_QUICK_FIX,
    edit: {
      changes: {
        [uri]: buildAutoImportTextEdits(ast, {
          symbol: candidate,
          importPath,
          range
        })
      }
    }
  };
}

function buildImportCodeActions(params: {
  uri: string;
  ast: Program;
  range: Range;
  symbolName: string;
  candidates: SymbolExport[];
  currentFilePath: string;
}): CodeAction[] {
  const { uri, ast, range, symbolName, candidates, currentFilePath } = params;
  const preferredImportPaths = importedModulePaths(ast);
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = `${symbolName}::${importPathForSymbolExport(candidate, currentFilePath)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return uniqueCandidates
    .sort((a, b) => {
      const aPath = importPathForSymbolExport(a, currentFilePath);
      const bPath = importPathForSymbolExport(b, currentFilePath);
      const aPreferred = preferredImportPaths.has(aPath) ? 0 : 1;
      const bPreferred = preferredImportPaths.has(bPath) ? 0 : 1;
      if (aPreferred !== bPreferred) {
        return aPreferred - bPreferred;
      }
      return aPath.localeCompare(bPath);
    })
    .map((candidate) => buildImportCodeAction({ uri, ast, range, symbolName, candidate, currentFilePath }))
    .filter((action): action is CodeAction => action !== null);
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).toString();
}

export interface AutoImportSuggestion {
  symbol: SymbolExport;
  importPath: string;
  range: Range;
}

export function buildAutoImportTextEdits(
  ast: Program,
  suggestion: AutoImportSuggestion
): TextEdit[] {
  const typeOnly = isTypeOnlySymbolExport(suggestion.symbol);
  const existingImports = findExistingImportsFromPath(ast, suggestion.importPath);
  const existingImport = existingImports.find((statement) => statement.namespaceImport === undefined) ?? existingImports[0] ?? null;
  if (existingImport?.firstToken && existingImport?.lastToken) {
    const hasNamespaceImport = existingImport.namespaceImport !== undefined;
    const canMergeNamedSpecifiersIntoExistingImport = !hasNamespaceImport;

    if (!canMergeNamedSpecifiersIntoExistingImport) {
      const insertionLine = existingImport.lastToken.range.end.line + 1;
      return [{
        range: {
          start: { line: insertionLine, character: 0 },
          end: { line: insertionLine, character: 0 }
        },
        newText: typeOnly
          ? `import type { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
          : `import { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
      }];
    }

    const existingNames = existingImport.specifiers.map((specifier) => ({
      name: specifier.imported.name,
      typeOnly: specifier.typeOnly === true
    }));
    const allNames = existingNames.some((specifier) => specifier.name === suggestion.symbol.name)
      ? existingNames
      : [...existingNames, { name: suggestion.symbol.name, typeOnly }];
    const clauses: string[] = [];
    if (existingImport.defaultImport) {
      clauses.push(existingImport.defaultImport.name);
    }
    if (existingImport.namespaceImport) {
      clauses.push(`* as ${existingImport.namespaceImport.name}`);
    }
    if (allNames.length > 0) {
      clauses.push(`{ ${allNames.map((specifier) => specifier.typeOnly ? `type ${specifier.name}` : specifier.name).join(", ")} }`);
    }
    const start = existingImport.firstToken.range.start;
    const end = existingImport.lastToken.range.end;
    return [{
      range: {
        start: { line: start.line, character: start.column },
        end: { line: end.line, character: end.column }
      },
      newText: `${existingImport.typeOnly ? "import type" : "import"} ${clauses.join(", ")} from "${suggestion.importPath}"`
    }];
  }

  return [{
    range: suggestion.range,
    newText: typeOnly
      ? `import type { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
      : `import { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
  }];
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
  const nodeModuleExports = await collectNodeModuleExportsFromExistingImports(ast, currentFilePath);
  const availableSymbols = [...exportedSymbols, ...nodeModuleExports];
  if (availableSymbols.length === 0) {
    return [];
  }

  const normalizedPrefix = prefix?.trim() ?? "";
  if (normalizedPrefix.length === 0 && allowEmptyPrefix !== true) {
    return [];
  }
  const preferredImportPaths = importedModulePaths(ast);
  const results: AutoImportSuggestion[] = [];
  const seen = new Set<string>();
  const range = importInsertionRange(ast);

  for (const symbolExport of availableSymbols) {
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
    const importPath = importPathForSymbolExport(symbolExport, currentFilePath);
    const key = `${symbolExport.name}::${importPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push({
      symbol: symbolExport,
      importPath,
      range
    });
  }

  return results.sort((a, b) =>
    a.symbol.name.localeCompare(b.symbol.name) ||
    ((preferredImportPaths.has(a.importPath) ? 0 : 1) - (preferredImportPaths.has(b.importPath) ? 0 : 1)) ||
    a.importPath.localeCompare(b.importPath)
  );
}
