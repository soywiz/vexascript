import { extname } from "node:path";
import type { ParserOptions } from "compiler/parser/parser";
import type {
  FunctionStatement,
  Identifier,
  ImportStatement,
  Program,
  Statement
} from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { compileParsedSource, compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import {
  builtinType,
  functionType,
  intersectionType,
  namedType,
  objectTypeWithProperties,
  UNKNOWN_TYPE,
  type AnalysisType
} from "compiler/analysis/types";
import { resolveImportTargetFilePath, resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { localVfs, type Vfs } from "compiler/vfs";
import { ensureEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

interface CachedTypingsData {
  declarations: Statement[];
  analysis: Analysis | null;
  defaultExportName: string;
  hasFunctionNamespaceDualExport: boolean;
}

const typingsCacheByPath = new Map<string, CachedTypingsData>();

/**
 * Resolves a project's local module graph and bundles it into a single
 * executable JavaScript module.
 *
 * VexaScript local files (`./foo`, `../bar`) do not produce real ES module exports,
 * so cross-file references cannot be resolved at runtime through the normal
 * module loader. For `run`, the entry file and every local `.vx` or `.ts` module it
 * imports (transitively) are transpiled and concatenated in dependency order
 * into one module, with the now-internal local `import` statements removed.
 *
 * Each module is transpiled with the declarations imported from its local
 * dependencies provided as `externalDeclarations`, so the analyzer and emitter
 * resolve cross-file classes, operator overloads and extension properties.
 */

function isBundledLocalModulePath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".vx" || extension === ".ts" || extension === ".tsx";
}

function isInlineAssetModulePath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".json" || extension === ".txt";
}

function parserOptionsForModulePath(filePath: string): ParserOptions {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts") {
    return { language: "typescript" };
  }
  if (extension === ".tsx") {
    return { language: "typescript", jsx: true };
  }
  return {};
}

async function resolveLocalModulePath(importerFilePath: string, importPath: string, vfs: Vfs): Promise<string | null> {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const targetPath = await resolveImportTargetFilePath(importerFilePath, importPath, { vfs });
  return targetPath && isBundledLocalModulePath(targetPath) ? targetPath : null;
}

async function resolveInlineAssetModulePath(importerFilePath: string, importPath: string, vfs: Vfs): Promise<string | null> {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const targetPath = await resolveImportTargetFilePath(importerFilePath, importPath, { vfs });
  return targetPath && isInlineAssetModulePath(targetPath) ? targetPath : null;
}

function declarationName(statement: Statement): string | null {
  const candidate = unwrapExportedDeclaration(statement);
  if (!candidate) {
    return null;
  }
  const named = candidate as { name?: { kind?: string; name?: string } };
  if (named.name && named.name.kind === "Identifier") {
    return (named.name as Identifier).name;
  }
  return null;
}

function callableTypeFromDefaultExportedFunction(declarations: readonly Statement[], name: string): AnalysisType | null {
  for (const statement of declarations) {
    if (statement.kind !== "ExportStatement" || (statement as { default?: boolean }).default !== true) {
      continue;
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration?.kind !== "FunctionStatement") {
      continue;
    }
    const fn = declaration as FunctionStatement;
    if (fn.name.name !== name) {
      continue;
    }
    return functionType(
      fn.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
        name: parameter.name.kind === "Identifier" ? parameter.name.name : "arg",
        type: UNKNOWN_TYPE,
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })),
      UNKNOWN_TYPE
    );
  }
  return null;
}

function jsonValueType(value: unknown): AnalysisType {
  if (typeof value === "string") {
    return builtinType("string");
  }
  if (typeof value === "number") {
    return builtinType("number");
  }
  if (typeof value === "boolean") {
    return builtinType("boolean");
  }
  if (value === null) {
    return builtinType("null");
  }
  if (Array.isArray(value)) {
    return namedType("Array", [value.length > 0 ? jsonValueType(value[0]) : UNKNOWN_TYPE]);
  }
  if (typeof value === "object") {
    const properties: Record<string, AnalysisType> = {};
    for (const [key, propertyValue] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = jsonValueType(propertyValue);
    }
    return objectTypeWithProperties(properties);
  }
  return UNKNOWN_TYPE;
}

function assetImportBindingNames(statement: ImportStatement): string[] {
  const names: string[] = [];
  if (statement.defaultImport) {
    names.push(statement.defaultImport.name);
  }
  if (statement.namespaceImport) {
    names.push(statement.namespaceImport.name);
  }
  for (const specifier of statement.specifiers) {
    names.push((specifier.local ?? specifier.imported).name);
  }
  return names;
}

function emitAssetImportBindings(
  statement: ImportStatement,
  assetPath: string,
  source: string
): { code: string; importedType: AnalysisType } {
  const extension = extname(assetPath).toLowerCase();
  const value = extension === ".json" ? JSON.parse(source) : source;
  const literal = JSON.stringify(value);
  const importedType = extension === ".json" ? jsonValueType(value) : builtinType("string");
  const lines: string[] = [];

  if (statement.defaultImport) {
    lines.push(`const ${statement.defaultImport.name} = ${literal};`);
  }
  if (statement.namespaceImport) {
    lines.push(`const ${statement.namespaceImport.name} = ${literal};`);
  }
  for (const specifier of statement.specifiers) {
    const localName = (specifier.local ?? specifier.imported).name;
    lines.push(`const ${localName} = ${literal}[${JSON.stringify(specifier.imported.name)}];`);
  }

  return { code: lines.join("\n"), importedType };
}

/**
 * Collects the top-level declarations of `dependencyAst` whose name matches one
 * of `importedNames`. Returned declarations are intended to be passed to
 * `transpile` as `externalDeclarations` for the importing module.
 */
function collectImportedDeclarations(dependencyAst: Program, importedNames: Set<string>): Statement[] {
  const result: Statement[] = [];
  for (const statement of dependencyAst.body) {
    const name = declarationName(statement);
    if (!name || !importedNames.has(name)) {
      continue;
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration) {
      result.push(declaration);
    }
  }
  return result;
}

/**
 * Detects `export = X` in a .d.ts AST (represented as a bare ExprStatement
 * with an Identifier) and returns the exported name, mirroring the LSP logic.
 */
function detectDtsDefaultExportName(ast: Program): string | null {
  for (const stmt of ast.body) {
    if (stmt.kind === "ExportStatement" && (stmt as { default?: boolean }).default) {
      const declaration = unwrapExportedDeclaration(stmt);
      const name = declarationName(declaration as Statement);
      if (name) return name;
    }
    if (stmt.kind === "ExprStatement") {
      const expr = (stmt as { expression?: { kind?: string; name?: string } }).expression;
      if (expr?.kind === "Identifier" && expr.name) return expr.name;
    }
  }
  // Fall back to first top-level namespace that shares a name with a top-level
  // function — the common dual function+namespace pattern (e.g. moment).
  const functionNames = new Set<string>();
  for (const stmt of ast.body) {
    if (stmt.kind === "FunctionStatement") {
      const name = (stmt as { name?: { name?: string } }).name?.name;
      if (name) functionNames.add(name);
    }
  }
  for (const stmt of ast.body) {
    if (stmt.kind === "NamespaceStatement") {
      const name = (stmt as { names?: { name: string }[] }).names?.[0]?.name;
      if (name && functionNames.has(name)) return name;
    }
  }
  return null;
}

function hasFunctionNamespaceDualExport(ast: Program, exportedName: string): boolean {
  let hasFunction = false;
  let hasNamespace = false;
  for (const stmt of ast.body) {
    if (stmt.kind === "FunctionStatement") {
      const name = (stmt as { name?: { name?: string } }).name?.name;
      if (name === exportedName) {
        hasFunction = true;
      }
    }
    if (stmt.kind === "NamespaceStatement") {
      const name = (stmt as { names?: { name: string }[] }).names?.[0]?.name;
      if (name === exportedName) {
        hasNamespace = true;
      }
    }
  }
  return hasFunction && hasNamespace;
}

/**
 * Loads the .d.ts typings for every bare-specifier import in `ast` and merges
 * their declarations into `externalDeclarations` and their default-export types
 * into `importedSymbolTypes`. This gives the CLI type-checker the same npm
 * package information the LSP already has.
 */
async function collectNodeModulesTypings(
  ast: Program,
  importerFilePath: string,
  externalDeclarations: Statement[],
  importedSymbolTypes: Map<string, AnalysisType>,
  vfs: Vfs
): Promise<void> {
  const loadTypings = async (typingsPath: string): Promise<CachedTypingsData | null> => {
    const cached = typingsCacheByPath.get(typingsPath);
    if (cached) {
      return cached;
    }

    const source = await vfs.readFile(typingsPath);
    if (source === null) {
      return null;
    }
    const parsed = parseSource(source, { language: "typescript" });
    if (!parsed.ast) {
      return null;
    }

    const defaultExportName = detectDtsDefaultExportName(parsed.ast) ?? "";
    const loaded: CachedTypingsData = {
      declarations: [...parsed.ast.body],
      analysis: compileParsedSource(parsed, {}).analysis,
      defaultExportName,
      hasFunctionNamespaceDualExport: defaultExportName.length > 0
        ? hasFunctionNamespaceDualExport(parsed.ast, defaultExportName)
        : false
    };
    typingsCacheByPath.set(typingsPath, loaded);
    return loaded;
  };

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") continue;
    const importStatement = statement as ImportStatement;
    const specifier = importStatement.from.value;
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;

    const typingsPath = await resolveNodeModulesTypingsPath(importerFilePath, specifier, { vfs });
    if (!typingsPath) continue;

    const typings = await loadTypings(typingsPath);
    if (!typings) continue;

    // All top-level declarations become externalDeclarations so the type
    // checker can resolve named types (interfaces, namespaces, etc.).
    for (const decl of typings.declarations) {
      externalDeclarations.push(decl);
    }

    // Resolve imported values to their declaration types when possible. This
    // keeps default-exported functions callable while retaining the named-type
    // fallback used for namespace-shaped packages such as moment.
    const declarationAnalysis = typings.analysis;
    const defaultExportName = typings.defaultExportName || specifier;
    const exportType = namedType(defaultExportName);
    if (importStatement.defaultImport) {
      const declaredDefaultType = declarationAnalysis?.getTopLevelSymbolType(defaultExportName);
      const defaultImportType = typings.hasFunctionNamespaceDualExport
        ? declaredDefaultType ? intersectionType([declaredDefaultType, exportType]) : exportType
        : declaredDefaultType?.kind === "function"
        ? declaredDefaultType
        : callableTypeFromDefaultExportedFunction(typings.declarations, defaultExportName) ?? exportType;
      importedSymbolTypes.set(
        importStatement.defaultImport.name,
        defaultImportType
      );
    }
    if (importStatement.namespaceImport) {
      importedSymbolTypes.set(importStatement.namespaceImport.name, exportType);
    }
    for (const s of importStatement.specifiers) {
      const localName = (s.local ?? s.imported).name;
      importedSymbolTypes.set(localName, declarationAnalysis?.getTopLevelSymbolType(s.imported.name) ?? exportType);
    }
  }
}

async function localImportSpecifiers(ast: Program, importerFilePath: string, vfs: Vfs): Promise<{ statement: ImportStatement; targetPath: string }[]> {
  const imports: { statement: ImportStatement; targetPath: string }[] = [];
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetPath = await resolveLocalModulePath(importerFilePath, importStatement.from.value, vfs);
    if (targetPath) {
      imports.push({ statement: importStatement, targetPath });
    }
  }
  return imports;
}

async function localAssetImportSpecifiers(
  ast: Program,
  importerFilePath: string,
  vfs: Vfs
): Promise<{ statement: ImportStatement; targetPath: string }[]> {
  const imports: { statement: ImportStatement; targetPath: string }[] = [];
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetPath = await resolveInlineAssetModulePath(importerFilePath, importStatement.from.value, vfs);
    if (targetPath) {
      imports.push({ statement: importStatement, targetPath });
    }
  }
  return imports;
}

/**
 * Removes the emitted `import ... from "<local>"` / `import "<local>"`
 * statements that reference bundled local `.vx`/`.ts` modules. Relative imports that
 * resolve to JavaScript stay in the output for downstream bundlers
 * or Node.js to load normally.
 */
function stripBundledImports(code: string, bundledSpecifiers: ReadonlySet<string>): string {
  return code
    .split("\n")
    .filter((line) => {
      const match = /^\s*import\b.*?["']([^"']+)["']\s*;?\s*$/.exec(line);
      if (!match) {
        return true;
      }
      return !bundledSpecifiers.has(match[1] ?? "");
    })
    .join("\n");
}

function stripBundledModuleSyntax(code: string, bundledSpecifiers: ReadonlySet<string>): string {
  return stripBundledImports(code, bundledSpecifiers)
    .split("\n")
    .map((line) => {
      if (/^\s*export\s+\{.*\}\s*;?\s*$/.test(line)) {
        return "";
      }
      if (/^\s*export\s*=\s*.+;?\s*$/.test(line)) {
        return "";
      }
      return line.replace(/^(\s*)export\s+(default\s+)?/, "$1");
    })
    .join("\n");
}

export async function bundleModuleGraph(
  entryFilePath: string,
  target: TranspileTarget,
  options: { vfs?: Vfs; jsxFactory?: string; jsxFragmentFactory?: string; ambientDeclarations?: Statement[] } = {}
): Promise<TranspileResult> {
  const vfs = options.vfs ?? localVfs;
  const ambientDeclarations = options.ambientDeclarations ?? [];
  await ensureEcmaScriptRuntimeProgram();

  const emittedByPath = new Map<string, string>();
  const analysisByPath = new Map<string, Analysis | null>();
  const sourceByPath = new Map<string, string>();
  const parsedByPath = new Map<string, ParseArtifacts | null>();
  const order: string[] = [];
  const inProgress = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  const diagnostics: TranspileResult["diagnostics"] = [];

  const loadSource = async (filePath: string): Promise<string | null> => {
    if (sourceByPath.has(filePath)) {
      return sourceByPath.get(filePath) ?? null;
    }
    const source = await vfs.readFile(filePath);
    if (source !== null) {
      sourceByPath.set(filePath, source);
    }
    return source;
  };

  const loadParsed = async (filePath: string, parserOptions: ParserOptions): Promise<ParseArtifacts | null> => {
    if (parsedByPath.has(filePath)) {
      return parsedByPath.get(filePath) ?? null;
    }
    const source = await loadSource(filePath);
    if (source === null) {
      return null;
    }
    const parsed = parseSource(source, parserOptions);
    parsedByPath.set(filePath, parsed);
    return parsed;
  };

  const visit = async (filePath: string): Promise<void> => {
    if (emittedByPath.has(filePath) || inProgress.has(filePath)) {
      return;
    }
    inProgress.add(filePath);

    const source = await loadSource(filePath);
    if (source === null) {
      errors.push(`Unable to read module '${filePath}'`);
      inProgress.delete(filePath);
      return;
    }
    const parserOptions = parserOptionsForModulePath(filePath);
    const parsed = await loadParsed(filePath, parserOptions);
    const ast = parsed?.ast ?? null;

    const externalDeclarations: Statement[] = [];
    const importedSymbolTypes = new Map<string, AnalysisType>();
    const bundledSpecifiers = new Set<string>();
    if (ast) {
      await collectNodeModulesTypings(ast, filePath, externalDeclarations, importedSymbolTypes, vfs);
      for (const { statement, targetPath } of await localAssetImportSpecifiers(ast, filePath, vfs)) {
        bundledSpecifiers.add(statement.from.value);
        const assetSource = await loadSource(targetPath);
        if (assetSource === null) {
          errors.push(`Unable to read asset module '${targetPath}'`);
          continue;
        }
        try {
          const { importedType } = emitAssetImportBindings(statement, targetPath, assetSource);
          for (const bindingName of assetImportBindingNames(statement)) {
            importedSymbolTypes.set(bindingName, importedType);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`Unable to load asset module '${targetPath}': ${message}`);
        }
      }
      for (const { statement, targetPath } of await localImportSpecifiers(ast, filePath, vfs)) {
        bundledSpecifiers.add(statement.from.value);
        await visit(targetPath);
        const dependencyAst = (await loadParsed(targetPath, parserOptionsForModulePath(targetPath)))?.ast ?? null;
        if (dependencyAst) {
          const importedNames = new Set(
            statement.specifiers.map((specifier) => specifier.imported.name)
          );
          externalDeclarations.push(...collectImportedDeclarations(dependencyAst, importedNames));
        }
        // Resolve imported value types (e.g. functions returning a Promise) from
        // the dependency's analysis so cross-file calls participate in auto-await.
        const dependencyAnalysis = analysisByPath.get(targetPath);
        if (dependencyAnalysis) {
          for (const specifier of statement.specifiers) {
            const importedType = dependencyAnalysis.getTopLevelSymbolType(specifier.imported.name);
            if (importedType) {
              importedSymbolTypes.set((specifier.local ?? specifier.imported).name, importedType);
            }
          }
        }
      }
    }

    // Store this module's analysis (resolved with its own cross-file types) so
    // modules that import from it can read their imported value types.
    const compilationArtifacts = parsed
      ? compileParsedSource(parsed, {
          externalDeclarations,
          ambientDeclarations,
          importedSymbolTypes
        })
      : compileSource(source, parserOptions, {
          externalDeclarations,
          ambientDeclarations,
          importedSymbolTypes
        });
    analysisByPath.set(filePath, compilationArtifacts.analysis);

    const result = transpile(source, {
      compilationArtifacts,
      sourceFilePath: filePath,
      target,
      emitSourceMap: false,
      parserOptions,
      externalDeclarations,
      importedSymbolTypes,
      ambientDeclarations,
      ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
      ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {})
    });
    errors.push(...result.errors);
    diagnostics.push(...result.diagnostics);
    warnings.push(...result.warnings);

    const assetBindingChunks: string[] = [];
    if (ast) {
      for (const { statement, targetPath } of await localAssetImportSpecifiers(ast, filePath, vfs)) {
        const assetSource = await loadSource(targetPath);
        if (assetSource === null) {
          continue;
        }
        try {
          const { code } = emitAssetImportBindings(statement, targetPath, assetSource);
          if (code) {
            assetBindingChunks.push(code);
          }
        } catch {
          // The earlier type-collection pass already recorded the load error.
        }
      }
    }

    const emittedCode = stripBundledModuleSyntax(result.code, bundledSpecifiers);
    emittedByPath.set(
      filePath,
      [...assetBindingChunks, emittedCode].filter((chunk) => chunk.trim().length > 0).join("\n")
    );

    inProgress.delete(filePath);
    order.push(filePath);
  };

  await visit(entryFilePath);

  const code = order
    .map((filePath) => emittedByPath.get(filePath) ?? "")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");

  return { code, warnings, errors, diagnostics };
}
