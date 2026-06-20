import type { ParserOptions } from "compiler/parser/parser";
import type {
  FunctionStatement,
  Identifier,
  ImportStatement,
  Program,
  Statement,
  VarStatement,
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { compileParsedSource, compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import {
  builtinType,
  namedType,
  objectTypeWithProperties,
  UNKNOWN_TYPE,
  type AnalysisType
} from "compiler/analysis/types";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { resolveNodeModuleImportsForRuntime } from "compiler/nodeModuleImportResolution";
import { vfs, type Vfs } from "compiler/vfs";
import { ensureEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { extname } from "compiler/utils/path";
import { collectImplicitVexaExportPlan } from "./implicitExports";
import { stripBundledCommonJsImports, stripBundledModuleSyntax } from "./bundlingStripping";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

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

const TYPE_DECLARATION_KINDS = new Set<Statement["kind"]>([
  "ClassStatement",
  "InterfaceStatement",
  "EnumStatement",
  "TypeAliasStatement"
]);

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
  if (statement.kind === "VarStatement") {
    const varStatement = statement as VarStatement;
    if (varStatement.receiverType) {
      return bindingIdentifiers(varStatement.name)[0]?.name ?? null;
    }
  }
  if (statement.kind === "FunctionStatement") {
    const functionStatement = statement as FunctionStatement;
    if (functionStatement.receiverType && functionStatement.operator) {
      return functionStatement.name.name;
    }
  }
  const candidate = unwrapExportedDeclaration(statement);
  if (!candidate) {
    return null;
  }
  if (candidate.kind === "VarStatement") {
    const varStatement = candidate as VarStatement;
    if (varStatement.receiverType) {
      return bindingIdentifiers(varStatement.name)[0]?.name ?? null;
    }
  }
  if (candidate.kind === "FunctionStatement") {
    const functionStatement = candidate as FunctionStatement;
    if (functionStatement.receiverType && functionStatement.operator) {
      return functionStatement.name.name;
    }
  }
  const named = candidate as { name?: { kind?: string; name?: string } };
  if (named.name && named.name.kind === "Identifier") {
    return (named.name as Identifier).name;
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
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    const isHelperTypeDeclaration = TYPE_DECLARATION_KINDS.has(declaration.kind);
    const name = declarationName(statement);
    if (!isHelperTypeDeclaration && (!name || !importedNames.has(name))) {
      continue;
    }
    if (declaration) {
      result.push(declaration);
    }
  }
  return result;
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
  const imported = await resolveNodeModuleImportsForRuntime(ast, importerFilePath, vfs);
  externalDeclarations.push(...imported.externalDeclarations);
  for (const [name, type] of imported.importedSymbolTypes) {
    importedSymbolTypes.set(name, type);
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

function appendImplicitVexaCommonJsExports(code: string, ast: Program | null, filePath: string): string {
  const plan = collectImplicitVexaExportPlan(ast, filePath);
  if (plan.commonJsLines.length === 0) {
    return code;
  }
  return code.trim().length > 0 ? `${code}\n${plan.commonJsLines.join("\n")}` : plan.commonJsLines.join("\n");
}

function appendImplicitVexaExports(code: string, ast: Program | null, filePath: string): string {
  const plan = collectImplicitVexaExportPlan(ast, filePath);
  if (plan.esmSpecifiers.length === 0) {
    return code;
  }
  const exportClause = `export { ${plan.esmSpecifiers.join(", ")} };`;
  return code.trim().length > 0 ? `${code}\n${exportClause}` : exportClause;
}

export async function bundleModuleGraph(
  entryFilePath: string,
  target: TranspileTarget,
  options: { vfs?: Vfs; jsxFactory?: string; jsxFragmentFactory?: string; ambientDeclarations?: Statement[] } = {}
): Promise<TranspileResult> {
  const activeVfs = options.vfs ?? vfs();
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
    const source = await activeVfs.readFile(filePath);
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
      await collectNodeModulesTypings(ast, filePath, externalDeclarations, importedSymbolTypes, activeVfs);
      for (const { statement, targetPath } of await localAssetImportSpecifiers(ast, filePath, activeVfs)) {
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
      for (const { statement, targetPath } of await localImportSpecifiers(ast, filePath, activeVfs)) {
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
      for (const { statement, targetPath } of await localAssetImportSpecifiers(ast, filePath, activeVfs)) {
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

    const emittedCode = stripBundledModuleSyntax(result.code, bundledSpecifiers, {
      preserveExports: filePath === entryFilePath
    });
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

export interface ModuleGraphSourcesResult {
  entrySource: string;
  moduleSources: Map<string, string>;
  warnings: string[];
  errors: string[];
  diagnostics: TranspileResult["diagnostics"];
  watchedFiles: string[];
}

export async function bundleModuleGraphAsModules(
  entryFilePath: string,
  target: TranspileTarget,
  options: {
    vfs?: Vfs;
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    ambientDeclarations?: Statement[];
    moduleFormat?: "esm" | "commonjs";
  } = {}
): Promise<ModuleGraphSourcesResult> {
  const activeVfs = options.vfs ?? vfs();
  const ambientDeclarations = options.ambientDeclarations ?? [];
  const moduleFormat = options.moduleFormat ?? "esm";
  await ensureEcmaScriptRuntimeProgram();

  const emittedByPath = new Map<string, string>();
  const analysisByPath = new Map<string, Analysis | null>();
  const sourceByPath = new Map<string, string>();
  const parsedByPath = new Map<string, ParseArtifacts | null>();
  const inProgress = new Set<string>();
  const watchedFiles = new Set<string>([entryFilePath]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const diagnostics: TranspileResult["diagnostics"] = [];

  const loadSource = async (filePath: string): Promise<string | null> => {
    if (sourceByPath.has(filePath)) {
      return sourceByPath.get(filePath) ?? null;
    }
    const source = await activeVfs.readFile(filePath);
    if (source !== null) {
      sourceByPath.set(filePath, source);
      watchedFiles.add(filePath);
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
    const bundledAssetSpecifiers = new Set<string>();
    if (ast) {
      await collectNodeModulesTypings(ast, filePath, externalDeclarations, importedSymbolTypes, activeVfs);
      for (const { statement, targetPath } of await localAssetImportSpecifiers(ast, filePath, activeVfs)) {
        bundledAssetSpecifiers.add(statement.from.value);
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
      for (const { statement, targetPath } of await localImportSpecifiers(ast, filePath, activeVfs)) {
        await visit(targetPath);
        const dependencyAst = (await loadParsed(targetPath, parserOptionsForModulePath(targetPath)))?.ast ?? null;
        if (dependencyAst) {
          const importedNames = new Set(
            statement.specifiers.map((specifier) => specifier.imported.name)
          );
          externalDeclarations.push(...collectImportedDeclarations(dependencyAst, importedNames));
        }
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
      moduleFormat,
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
      for (const { statement, targetPath } of await localAssetImportSpecifiers(ast, filePath, activeVfs)) {
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

    const emittedCode = moduleFormat === "commonjs"
      ? stripBundledCommonJsImports(result.code, bundledAssetSpecifiers)
      : stripBundledModuleSyntax(result.code, bundledAssetSpecifiers, {
          preserveExports: true
        });
    const emittedWithImplicitExports = moduleFormat === "commonjs"
      ? appendImplicitVexaCommonJsExports(emittedCode, ast, filePath)
      : appendImplicitVexaExports(emittedCode, ast, filePath);
    emittedByPath.set(
      filePath,
      [...assetBindingChunks, emittedWithImplicitExports].filter((chunk) => chunk.trim().length > 0).join("\n")
    );

    inProgress.delete(filePath);
  };

  await visit(entryFilePath);

  return {
    entrySource: emittedByPath.get(entryFilePath) ?? "",
    moduleSources: emittedByPath,
    warnings,
    errors,
    diagnostics,
    watchedFiles: [...watchedFiles]
  };
}
