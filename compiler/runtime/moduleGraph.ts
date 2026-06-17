import type { ParserOptions } from "compiler/parser/parser";
import type {
  BinaryExpression,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  ImportStatement,
  Program,
  Statement,
  VarStatement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { compileParsedSource, compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import {
  arrayType,
  builtinType,
  BUILTIN_TYPE_NAMES,
  functionType,
  intersectionType,
  namedType,
  objectTypeWithProperties,
  UNKNOWN_TYPE,
  unionType,
  tupleType,
  type AnalysisType
} from "compiler/analysis/types";
import { loadAmbientTypesForProject, type AmbientTypesResult, resolveAmbientNamedImportType } from "compiler/ambientModules";
import { resolveImportTargetFilePath, resolveNodeModulesTypingsPath } from "compiler/moduleResolution";
import { vfs, type Vfs } from "compiler/vfs";
import { ensureEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import {
  findMatchingTypeDelimiter,
  parseTypeNameShape,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  stripEnclosingTypeParens
} from "compiler/analysis/typeNames";
import { extname } from "compiler/utils/path";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

interface CachedTypingsData {
  declarations: Statement[];
  analysis: Analysis | null;
  defaultExportName: string;
  hasFunctionNamespaceDualExport: boolean;
}

const typingsCacheByPath = new Map<string, CachedTypingsData>();

function ambientTypePackageNameFromTypingsPath(typingsPath: string): string | null {
  const match = typingsPath.match(/[\\/]+@types[\\/]+([^\\/]+)/);
  return match?.[1] ?? null;
}

function isFallbackModuleNamedType(type: AnalysisType | null | undefined, moduleName: string): boolean {
  return type?.kind === "named" && type.name === moduleName;
}

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

function externalTypeFromAnnotationText(typeName: string | undefined): AnalysisType {
  if (!typeName) {
    return UNKNOWN_TYPE;
  }
  const normalized = stripEnclosingTypeParens(typeName.trim());
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    const members = splitTopLevelDelimitedTypeText(normalized.slice(1, -1), new Set([","]));
    return tupleType(members.map((member) => externalTypeFromAnnotationText(member.trim())).filter((member) => member !== UNKNOWN_TYPE));
  }
  const unionParts = splitTopLevelTypeText(normalized, "|");
  if (unionParts.length > 1) {
    return unionType(unionParts.map((part) => externalTypeFromAnnotationText(part)));
  }
  const intersectionParts = splitTopLevelTypeText(normalized, "&");
  if (intersectionParts.length > 1) {
    return intersectionType(intersectionParts.map((part) => externalTypeFromAnnotationText(part)));
  }
  const arrowIndex = normalized.indexOf("=>");
  const parameterListEnd = normalized.startsWith("(")
    ? findMatchingTypeDelimiter(normalized, 0, "(", ")")
    : -1;
  if (parameterListEnd > 0 && arrowIndex > parameterListEnd) {
    const parameterText = normalized.slice(1, parameterListEnd).trim();
    const returnText = normalized.slice(arrowIndex + 2).trim();
    const parameters = parameterText.length === 0
      ? []
      : splitTopLevelDelimitedTypeText(parameterText, new Set([","])).map((parameter, index) => ({
          name: `arg${index}`,
          type: externalTypeFromAnnotationText(parameter.split(":").slice(1).join(":").trim() || parameter.trim())
        }));
    return functionType(parameters, externalTypeFromAnnotationText(returnText));
  }
  const parsed = parseTypeNameShape(normalized);
  const resolvedTypeArguments = parsed.typeArguments.map((argument) => externalTypeFromAnnotationText(argument));
  let resolvedBase: AnalysisType = BUILTIN_TYPE_NAMES.has(parsed.baseName)
    ? builtinType(parsed.baseName as Parameters<typeof builtinType>[0])
    : namedType(parsed.baseName, resolvedTypeArguments);
  for (let depth = 0; depth < parsed.arrayDepth; depth += 1) {
    resolvedBase = arrayType(resolvedBase);
  }
  return resolvedBase;
}

function callableTypeFromNamedExportedFunction(declarations: readonly Statement[], name: string): AnalysisType | null {
  const overloads: AnalysisType[] = [];
  for (const statement of declarations) {
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration?.kind !== "FunctionStatement") {
      continue;
    }
    const fn = declaration as FunctionStatement;
    if (fn.name.name !== name) {
      continue;
    }
    overloads.push(functionType(
      fn.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
        name: parameter.name.kind === "Identifier" ? parameter.name.name : "arg",
        type: externalTypeFromAnnotationText(parameter.typeAnnotation?.name),
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })),
      externalTypeFromAnnotationText(fn.returnType?.name),
      fn.typeParameters?.map((parameter) => parameter.name.name)
    ));
  }
  if (overloads.length === 0) {
    return null;
  }
  return overloads.length === 1 ? overloads[0]! : unionType(overloads);
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
  const ambientByTypePackage = new Map<string, AmbientTypesResult>();
  const loadAmbientTypePackage = async (typePackage: string): Promise<AmbientTypesResult> => {
    const cached = ambientByTypePackage.get(typePackage);
    if (cached) {
      return cached;
    }
    const loaded = await loadAmbientTypesForProject(importerFilePath, [typePackage], { vfs });
    ambientByTypePackage.set(typePackage, loaded);
    return loaded;
  };
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
    if (!typingsPath) {
      const nodeAmbientTypes = await loadAmbientTypePackage("node");
      for (const s of importStatement.specifiers) {
        const ambientType = resolveAmbientNamedImportType(
          specifier,
          s.imported.name,
          nodeAmbientTypes.moduleDeclarations,
          nodeAmbientTypes.globalDeclarations
        );
        if (ambientType) {
          importedSymbolTypes.set((s.local ?? s.imported).name, ambientType);
        }
      }
      continue;
    }

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
    const ambientTypePackage = ambientTypePackageNameFromTypingsPath(typingsPath);
    const ambientTypes = ambientTypePackage
      ? await loadAmbientTypePackage(ambientTypePackage)
      : null;
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
      const declaredType = declarationAnalysis?.getTopLevelSymbolType(s.imported.name);
      const exportedFunctionType = callableTypeFromNamedExportedFunction(typings.declarations, s.imported.name) ?? declaredType;
      const ambientType = ambientTypes
        ? resolveAmbientNamedImportType(
          specifier,
          s.imported.name,
          ambientTypes.moduleDeclarations,
          ambientTypes.globalDeclarations
        )
        : null;
      importedSymbolTypes.set(
        localName,
        !isFallbackModuleNamedType(exportedFunctionType, defaultExportName)
          ? (exportedFunctionType ?? ambientType ?? exportType)
          : (ambientType ?? exportedFunctionType ?? exportType)
      );
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

function stripBundledModuleSyntax(
  code: string,
  bundledSpecifiers: ReadonlySet<string>,
  options: { preserveExports?: boolean } = {}
): string {
  return stripBundledImports(code, bundledSpecifiers)
    .split("\n")
    .map((line) => {
      if (!options.preserveExports && /^\s*export\s+\{.*\}\s*;?\s*$/.test(line)) {
        return "";
      }
      if (!options.preserveExports && /^\s*export\s*=\s*.+;?\s*$/.test(line)) {
        return "";
      }
      return options.preserveExports ? line : line.replace(/^(\s*)export\s+(default\s+)?/, "$1");
    })
    .join("\n");
}

function stripBundledCommonJsImports(code: string, bundledSpecifiers: ReadonlySet<string>): string {
  if (bundledSpecifiers.size === 0) {
    return code;
  }
  const lines = code.split("\n");
  const stripped: string[] = [];
  const tempBindingsToSkip = new Set<string>();
  for (const line of lines) {
    let skipped = false;
    for (const tempBinding of [...tempBindingsToSkip]) {
      const tempReferencePattern = new RegExp(`^\\s*const\\s+[^=]+?=\\s*${tempBinding}(?:\\b|\\s|[.\\[])`);
      if (tempReferencePattern.test(line)) {
        skipped = true;
        continue;
      }
      tempBindingsToSkip.delete(tempBinding);
    }
    if (skipped) {
      continue;
    }
    const tempRequireMatch = /^\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\((['"])([^"'`]+)\2\);\s*$/.exec(line);
    if (tempRequireMatch && bundledSpecifiers.has(tempRequireMatch[3] ?? "")) {
      tempBindingsToSkip.add(tempRequireMatch[1]!);
      continue;
    }
    const directRequireMatch = /^\s*(?:const\s+[^=]+=\s*)?require\((['"])([^"'`]+)\1\);\s*$/.exec(line);
    if (directRequireMatch && bundledSpecifiers.has(directRequireMatch[2] ?? "")) {
      continue;
    }
    stripped.push(line);
  }
  return stripped.join("\n");
}

function appendImplicitVexaCommonJsExports(code: string, ast: Program | null, filePath: string): string {
  if (extname(filePath).toLowerCase() !== ".vx" || !ast) {
    return code;
  }
  const overloadCounts = new Map<string, number>();
  for (const statement of ast.body) {
    if (statement.kind === "FunctionStatement" && !(statement as FunctionStatement).declared) {
      const fn = statement as FunctionStatement;
      overloadCounts.set(fn.name.name, (overloadCounts.get(fn.name.name) ?? 0) + 1);
    }
  }

  const exportLines: string[] = [];
  for (const statement of ast.body) {
    if (statement.kind === "ExportStatement") {
      continue;
    }
    if (statement.kind === "VarStatement") {
      const variable = statement as VarStatement;
      if (variable.declared) {
        continue;
      }
      if (variable.receiverType && variable.name.kind === "Identifier") {
        const runtimeName = extensionPropertyRuntimeExportName(variable.receiverType.name, variable.name.name);
        exportLines.push(`exports.${runtimeName} = ${runtimeName};`);
        continue;
      }
      const declarations = variable.declarations && variable.declarations.length > 0
        ? variable.declarations
        : [{ name: variable.name, delegate: variable.delegate }];
      for (const declaration of declarations) {
        if (declaration.name.kind !== "Identifier") {
          continue;
        }
        if (declaration.delegate) {
          continue;
        }
        const sourceName = declaration.name.name;
        const runtimeName = declarations.length === 1 ? (variable.jsName ?? sourceName) : sourceName;
        exportLines.push(`exports.${sourceName} = ${runtimeName};`);
      }
      continue;
    }
    if (statement.kind === "FunctionStatement") {
      const fn = statement as FunctionStatement;
      if (fn.declared || fn.missingBody) {
        continue;
      }
      if (fn.receiverType) {
        const baseName = fn.operator ? operatorBaseRuntimeName(fn.operator) : fn.name.name;
        const runtimeName = extensionMethodRuntimeExportName(fn.receiverType.name, baseName, fn.parameters);
        exportLines.push(`exports.${runtimeName} = ${runtimeName};`);
        continue;
      }
      const runtimeName = fn.jsName
        ?? ((overloadCounts.get(fn.name.name) ?? 0) > 1
          ? overloadedRuntimeName(fn.name.name, fn.parameters)
          : fn.name.name);
      const exportName = fn.jsName ? fn.name.name : runtimeName;
      exportLines.push(`exports.${exportName} = ${runtimeName};`);
      continue;
    }
    if (statement.kind === "ClassStatement" || statement.kind === "EnumStatement") {
      if ((statement as { declared?: boolean }).declared) {
        continue;
      }
      const sourceName = (statement as { name?: Identifier }).name?.name;
      if (!sourceName) {
        continue;
      }
      const runtimeName = (statement as { jsName?: string }).jsName ?? sourceName;
      exportLines.push(`exports.${sourceName} = ${runtimeName};`);
      continue;
    }
    if (statement.kind === "NamespaceStatement") {
      if ((statement as { declared?: boolean }).declared) {
        continue;
      }
      const sourceName = (statement as { names?: Identifier[] }).names?.[0]?.name;
      if (sourceName) {
        exportLines.push(`exports.${sourceName} = ${sourceName};`);
      }
      continue;
    }
    for (const name of implicitRuntimeExportNames(statement)) {
      exportLines.push(`exports.${name} = ${name};`);
    }
  }
  if (exportLines.length === 0) {
    return code;
  }
  const uniqueLines = [...new Set(exportLines)];
  return code.trim().length > 0 ? `${code}\n${uniqueLines.join("\n")}` : uniqueLines.join("\n");
}

function sanitizeRuntimeManglePart(text: string): string {
  const normalized = text.replace(/[^A-Za-z0-9]+/g, "$").replace(/^\$+|\$+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function parameterTypeNameForExport(parameter: FunctionParameter): string {
  return parameter.typeAnnotation?.name ?? "unknown";
}

function overloadSuffixForExport(parameters: FunctionParameter[]): string {
  const visibleParameters = parameters.filter((parameter) => parameter.thisParameter !== true);
  return visibleParameters
    .map((parameter) => sanitizeRuntimeManglePart(parameterTypeNameForExport(parameter)))
    .join("$$") || "void";
}

function overloadedRuntimeName(name: string, parameters: FunctionParameter[]): string {
  return `${name}$$${overloadSuffixForExport(parameters)}`;
}

function operatorBaseRuntimeName(operator: BinaryExpression["operator"]): string {
  const map: Record<BinaryExpression["operator"], string> = {
    "+": "operator$plus",
    "-": "operator$minus",
    "*": "operator$multiply",
    "/": "operator$divide",
    "%": "operator$mod",
    "**": "operator$power",
    "<<": "operator$shiftLeft",
    ">>": "operator$shiftRight",
    ">>>": "operator$unsignedShiftRight",
    "<": "operator$lessThan",
    ">": "operator$greaterThan",
    "<=": "operator$lessThanOrEqual",
    ">=": "operator$greaterThanOrEqual",
    "in": "operator$in",
    "is": "operator$is",
    "instanceof": "operator$instanceof",
    "==": "operator$equals",
    "!=": "operator$notEquals",
    "===": "operator$strictEquals",
    "!==": "operator$strictNotEquals",
    "&": "operator$bitAnd",
    "|": "operator$bitOr",
    "^": "operator$bitXor",
    "||": "operator$or",
    "&&": "operator$and",
    "??": "operator$nullishCoalesce"
  };
  return map[operator] ?? `operator$${sanitizeRuntimeManglePart(operator)}`;
}

function extensionMethodRuntimeExportName(receiverType: string, baseName: string, parameters: FunctionParameter[]): string {
  return `${sanitizeRuntimeManglePart(receiverType)}$$${overloadedRuntimeName(baseName, parameters)}`;
}

function extensionPropertyRuntimeExportName(receiverType: string, propertyName: string): string {
  return `${sanitizeRuntimeManglePart(receiverType)}$$${sanitizeRuntimeManglePart(propertyName)}`;
}

function implicitRuntimeExportNames(statement: Statement): string[] {
  switch (statement.kind) {
    case "VarStatement": {
      const variable = statement as VarStatement;
      if (variable.declared) {
        return [];
      }
      if (variable.receiverType && variable.name.kind === "Identifier") {
        return [extensionPropertyRuntimeExportName(variable.receiverType.name, variable.name.name)];
      }
      const names = new Set<string>();
      for (const identifier of bindingIdentifiers(variable.name)) {
        names.add(identifier.name);
      }
      for (const declarator of variable.declarations ?? []) {
        for (const identifier of bindingIdentifiers(declarator.name)) {
          names.add(identifier.name);
        }
      }
      return [...names];
    }
    case "FunctionStatement": {
      const fn = statement as FunctionStatement;
      if (fn.declared || fn.missingBody) {
        return [];
      }
      if (fn.receiverType) {
        const baseName = fn.operator ? operatorBaseRuntimeName(fn.operator) : fn.name.name;
        return [extensionMethodRuntimeExportName(fn.receiverType.name, baseName, fn.parameters)];
      }
      return [fn.name.name];
    }
    case "ClassStatement":
    case "EnumStatement":
    case "NamespaceStatement": {
      if ((statement as { declared?: boolean }).declared) {
        return [];
      }
      if (statement.kind === "NamespaceStatement") {
        const names = (statement as { names?: Identifier[] }).names;
        return names && names.length > 0 ? [names[0]!.name] : [];
      }
      return [((statement as { name?: Identifier }).name?.name ?? "")].filter((name) => name.length > 0);
    }
    default:
      return [];
  }
}

function appendImplicitVexaExports(code: string, ast: Program | null, filePath: string): string {
  if (extname(filePath).toLowerCase() !== ".vx" || !ast) {
    return code;
  }
  const overloadCounts = new Map<string, number>();
  for (const statement of ast.body) {
    if (statement.kind === "FunctionStatement" && !(statement as FunctionStatement).declared) {
      const fn = statement as FunctionStatement;
      overloadCounts.set(fn.name.name, (overloadCounts.get(fn.name.name) ?? 0) + 1);
    }
  }

  const exportSpecifiers = new Set<string>();
  for (const statement of ast.body) {
    if (statement.kind === "ExportStatement") {
      continue;
    }
    if (statement.kind === "VarStatement") {
      const variable = statement as VarStatement;
      if (variable.declared) {
        continue;
      }
      if (variable.receiverType && variable.name.kind === "Identifier") {
        const runtimeName = extensionPropertyRuntimeExportName(variable.receiverType.name, variable.name.name);
        exportSpecifiers.add(runtimeName);
        continue;
      }
      const declarations = variable.declarations && variable.declarations.length > 0
        ? variable.declarations
        : [{ name: variable.name, delegate: variable.delegate }];
      for (const declaration of declarations) {
        if (declaration.name.kind !== "Identifier" || declaration.delegate) {
          continue;
        }
        const sourceName = declaration.name.name;
        const runtimeName = declarations.length === 1 ? (variable.jsName ?? sourceName) : sourceName;
        exportSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
      }
      continue;
    }
    if (statement.kind === "FunctionStatement") {
      const fn = statement as FunctionStatement;
      if (fn.declared || fn.missingBody) {
        continue;
      }
      if (fn.receiverType) {
        const baseName = fn.operator ? operatorBaseRuntimeName(fn.operator) : fn.name.name;
        exportSpecifiers.add(extensionMethodRuntimeExportName(fn.receiverType.name, baseName, fn.parameters));
        continue;
      }
      const runtimeName = fn.jsName
        ?? ((overloadCounts.get(fn.name.name) ?? 0) > 1
          ? overloadedRuntimeName(fn.name.name, fn.parameters)
          : fn.name.name);
      exportSpecifiers.add(fn.jsName ? `${runtimeName} as ${fn.name.name}` : runtimeName);
      continue;
    }
    if (statement.kind === "ClassStatement" || statement.kind === "EnumStatement") {
      if ((statement as { declared?: boolean }).declared) {
        continue;
      }
      const sourceName = (statement as { name?: Identifier }).name?.name;
      if (!sourceName) {
        continue;
      }
      const runtimeName = (statement as { jsName?: string }).jsName ?? sourceName;
      exportSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
      continue;
    }
    if (statement.kind === "NamespaceStatement") {
      if ((statement as { declared?: boolean }).declared) {
        continue;
      }
      const sourceName = (statement as { names?: Identifier[] }).names?.[0]?.name;
      if (sourceName) {
        exportSpecifiers.add(sourceName);
      }
      continue;
    }
    for (const name of implicitRuntimeExportNames(statement)) {
      exportSpecifiers.add(name);
    }
  }
  if (exportSpecifiers.size === 0) {
    return code;
  }
  const exportClause = `export { ${[...exportSpecifiers].join(", ")} };`;
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
