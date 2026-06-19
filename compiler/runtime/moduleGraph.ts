import type { ParserOptions } from "compiler/parser/parser";
import type {
  ClassStatement,
  EnumStatement,
  ExportStatement,
  FunctionStatement,
  Identifier,
  ImportStatement,
  InterfaceStatement,
  NamespaceStatement,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement,
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { parseSource, type ParseArtifacts } from "compiler/pipeline/parse";
import { compileParsedSource, compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import {
  type FunctionType,
  arrayType,
  builtinType,
  BUILTIN_TYPE_NAMES,
  functionType,
  intersectionType,
  namedType,
  objectTypeWithProperties,
  typeToString,
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
import { dirname, extname, resolve } from "compiler/utils/path";
import { collectImplicitVexaExportPlan } from "./implicitExports";
import { stripBundledCommonJsImports, stripBundledModuleSyntax } from "./bundlingStripping";
import { transpile, type TranspileResult, type TranspileTarget } from "./transpile";

interface CachedTypingsData {
  declarations: Statement[];
  analysis: Analysis | null;
  defaultExportName: string;
  hasFunctionNamespaceDualExport: boolean;
}

const TYPE_DECLARATION_KINDS = new Set<Statement["kind"]>([
  "ClassStatement",
  "InterfaceStatement",
  "EnumStatement",
  "TypeAliasStatement"
]);

function importedTypeParameterConstraintMap(typeParameters: readonly { name: Identifier; constraint?: { name?: string } }[] | undefined): Record<string, AnalysisType> | undefined {
  const entries = (typeParameters ?? [])
    .map((parameter) => {
      const constraintName = parameter.constraint?.name;
      return constraintName ? [parameter.name.name, externalTypeFromAnnotationText(constraintName)] as const : null;
    })
    .filter((entry): entry is readonly [string, AnalysisType] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function importedTypeParameterDefaultMap(typeParameters: readonly { name: Identifier; defaultType?: { name?: string } }[] | undefined): Record<string, AnalysisType> | undefined {
  const entries = (typeParameters ?? [])
    .map((parameter) => {
      const defaultName = parameter.defaultType?.name;
      return defaultName ? [parameter.name.name, externalTypeFromAnnotationText(defaultName)] as const : null;
    })
    .filter((entry): entry is readonly [string, AnalysisType] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function dedupeAnalysisTypes(types: AnalysisType[]): AnalysisType[] {
  const seen = new Set<string>();
  const result: AnalysisType[] = [];
  for (const type of types) {
    const key = typeToString(type);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(type);
  }
  return result;
}

function unionIfNeeded(types: AnalysisType[]): AnalysisType {
  const unique = dedupeAnalysisTypes(types);
  if (unique.length === 0) {
    return UNKNOWN_TYPE;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return unionType(unique);
}

function collapseFunctionOverloads(overloads: FunctionType[]): FunctionType {
  const first = overloads[0]!;
  const maxParameterCount = Math.max(...overloads.map((overload) => overload.parameters.length));
  const parameters = Array.from({ length: maxParameterCount }, (_, index) => {
    const candidates = overloads
      .map((overload) => overload.parameters[index])
      .filter((parameter): parameter is FunctionType["parameters"][number] => parameter != null);
    return {
      name: candidates[0]?.name ?? `arg${index}`,
      type: unionIfNeeded(candidates.map((parameter) => parameter.type)),
      optional: candidates.every((parameter) => parameter.optional === true) || candidates.length < overloads.length,
      rest: candidates.some((parameter) => parameter.rest === true)
    };
  });
  return functionType(
    parameters,
    unionIfNeeded(overloads.map((overload) => overload.returnType)),
    first.typeParameters
  );
}

const typingsCacheByPath = new Map<string, CachedTypingsData>();

async function parseTypingsProgram(typingsPath: string, vfs: Vfs): Promise<Program | null> {
  const source = await vfs.readFile(typingsPath);
  if (source === null) {
    return null;
  }
  const parsed = parseSource(source, { language: "typescript" });
  return parsed.ast ?? null;
}

async function readTypingsSource(typingsPath: string, vfs: Vfs): Promise<string | null> {
  return await vfs.readFile(typingsPath);
}

async function resolveRelativeTypingsPath(importerTypingsPath: string, specifier: string, vfs: Vfs): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const basePath = resolve(dirname(importerTypingsPath), specifier);
  const baseExt = extname(basePath);
  const declarationSiblingCandidates = [".js", ".mjs", ".cjs", ".jsx"].includes(baseExt)
    ? [
        `${basePath.slice(0, -baseExt.length)}.d.ts`,
        `${basePath.slice(0, -baseExt.length)}.ts`
      ]
    : [];
  const candidates = [
    ...declarationSiblingCandidates,
    basePath,
    extname(basePath) === "" ? `${basePath}.d.ts` : "",
    extname(basePath) === "" ? `${basePath}.ts` : "",
    resolve(basePath, "index.d.ts"),
    resolve(basePath, "index.ts")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const stat = await vfs.stat(candidate).catch(() => null);
    if (stat?.isDirectory) {
      continue;
    }
    if (stat?.isFile || await vfs.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveReexportedTypingsPath(importerTypingsPath: string, specifier: string, vfs: Vfs): Promise<string | null> {
  if (specifier.startsWith(".")) {
    return resolveRelativeTypingsPath(importerTypingsPath, specifier, vfs);
  }
  return resolveNodeModulesTypingsPath(importerTypingsPath, specifier, { vfs });
}

function extractReferencedTypingsSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const referencePathPattern = /^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["'][^>]*\/>\s*$/gm;

  for (const match of source.matchAll(referencePathPattern)) {
    const specifier = match[1]?.trim();
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

function extractImportedTypingsSpecifiers(ast: Program): string[] {
  const specifiers = new Set<string>();

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const specifier = importStatement.from?.value?.trim();
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

function asExportedTypingsStatement(statement: Statement): Statement {
  return statement.kind === "ExportStatement"
    ? statement
    : { kind: "ExportStatement", declaration: statement } as ExportStatement;
}


async function collectTypingsDeclarations(
  typingsPath: string,
  vfs: Vfs,
  visited: Set<string>
): Promise<Statement[]> {
  if (visited.has(typingsPath)) {
    return [];
  }
  visited.add(typingsPath);

  const ast = await parseTypingsProgram(typingsPath, vfs);
  if (!ast) {
    return [];
  }
  const source = await readTypingsSource(typingsPath, vfs);

  const declarations: Statement[] = [...ast.body];
  const supportSpecifiers = new Set<string>([
    ...(source ? extractReferencedTypingsSpecifiers(source) : []),
    ...extractImportedTypingsSpecifiers(ast)
  ]);
  for (const specifier of supportSpecifiers) {
    const targetTypingsPath = await resolveReexportedTypingsPath(typingsPath, specifier, vfs);
    if (!targetTypingsPath) {
      continue;
    }
    declarations.push(...await collectTypingsDeclarations(targetTypingsPath, vfs, visited));
  }
  for (const statement of ast.body) {
    if (statement.kind !== "ExportStatement") {
      continue;
    }
    const exportStatement = statement as Statement & ExportStatement;
    if (!exportStatement.from?.value || (!exportStatement.exportAll && (!exportStatement.specifiers || exportStatement.specifiers.length === 0))) {
      continue;
    }
    const targetTypingsPath = await resolveReexportedTypingsPath(typingsPath, exportStatement.from.value, vfs);
    if (!targetTypingsPath) {
      continue;
    }
    const reexportedDeclarations = await collectTypingsDeclarations(targetTypingsPath, vfs, visited);
    if (exportStatement.exportAll) {
      declarations.push(...reexportedDeclarations.map(asExportedTypingsStatement));
      continue;
    }
    const exportedNames = new Set<string>();
    for (const specifier of exportStatement.specifiers ?? []) {
      const exportSpecifier = specifier as { local?: { name: string }; exported: { name: string } };
      exportedNames.add(exportSpecifier.exported.name);
      if (exportSpecifier.local?.name) {
        exportedNames.add(exportSpecifier.local.name);
      }
    }
    for (const declaration of reexportedDeclarations) {
      const name = declarationName(declaration);
      if (name && exportedNames.has(name)) {
        declarations.push(asExportedTypingsStatement(declaration));
        continue;
      }
      declarations.push(declaration);
    }
  }

  return declarations;
}

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

function namedExportedFunctionOverloads(declarations: readonly Statement[], name: string): FunctionType[] {
  const locallyExportedNames = new Set<string>();
  for (const statement of declarations) {
    if (statement.kind !== "ExportStatement") {
      continue;
    }
    const exportStatement = statement as { specifiers?: Array<{ exported: Identifier; local?: Identifier }> };
    for (const specifier of exportStatement.specifiers ?? []) {
      if (specifier.exported.name !== name) {
        continue;
      }
      locallyExportedNames.add(specifier.local?.name ?? specifier.exported.name);
    }
  }
  const overloads: FunctionType[] = [];
  for (const statement of declarations) {
    const declaration = statement.kind === "ExportStatement" ? unwrapExportedDeclaration(statement) : undefined;
    if (declaration?.kind === "FunctionStatement" && (declaration as FunctionStatement).name.name === name) {
      const fn = declaration as FunctionStatement;
      overloads.push(functionType(
        fn.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: parameter.name.kind === "Identifier" ? parameter.name.name : "arg",
          type: externalTypeFromAnnotationText(parameter.typeAnnotation?.name),
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        externalTypeFromAnnotationText(fn.returnType?.name),
        fn.typeParameters?.map((parameter) => parameter.name.name),
        importedTypeParameterConstraintMap(fn.typeParameters),
        importedTypeParameterDefaultMap(fn.typeParameters)
      ));
      continue;
    }

    if (statement.kind !== "FunctionStatement") {
      continue;
    }
    const fn = statement as FunctionStatement;
    if (!locallyExportedNames.has(fn.name.name)) {
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
      fn.typeParameters?.map((parameter) => parameter.name.name),
      importedTypeParameterConstraintMap(fn.typeParameters),
      importedTypeParameterDefaultMap(fn.typeParameters)
    ));
  }
  return overloads;
}

function callableTypeFromNamedExportedFunction(declarations: readonly Statement[], name: string): AnalysisType | null {
  const overloads = namedExportedFunctionOverloads(declarations, name);
  if (overloads.length === 0) {
    return null;
  }
  return overloads.length === 1 ? overloads[0]! : collapseFunctionOverloads(overloads);
}

function externalNamedImportType(declarations: readonly Statement[], importedName: string): AnalysisType | null {
  const callableType = callableTypeFromNamedExportedFunction(declarations, importedName);
  if (callableType) {
    return callableType;
  }

  const locallyExportedNames = new Set<string>();
  for (const statement of declarations) {
    if (statement.kind !== "ExportStatement") {
      continue;
    }
    const exportStatement = statement as { specifiers?: Array<{ exported: Identifier; local?: Identifier }> };
    for (const specifier of exportStatement.specifiers ?? []) {
      if (specifier.exported.name !== importedName) {
        continue;
      }
      locallyExportedNames.add(specifier.local?.name ?? specifier.exported.name);
    }
  }

  for (const statement of declarations) {
    const declaration = statement.kind === "ExportStatement" ? unwrapExportedDeclaration(statement) : undefined;
    if (declaration) {
      const namedDeclaration = declaration as { name?: { name?: string } };
      const declarationName = namedDeclaration.name?.name;
      if (declaration.kind === "ClassStatement" && declarationName === importedName) {
        return namedType(importedName);
      }
      if (declaration.kind === "InterfaceStatement" && declarationName === importedName) {
        return namedType(importedName);
      }
      if (declaration.kind === "EnumStatement" && declarationName === importedName) {
        return namedType(importedName);
      }
      if (declaration.kind === "TypeAliasStatement" && declarationName === importedName) {
        return namedType(importedName);
      }
      if (declaration.kind === "VarStatement") {
        const identifiers = bindingIdentifiers((declaration as VarStatement).name);
        if (identifiers[0]?.name === importedName) {
          return externalTypeFromAnnotationText((declaration as VarStatement).typeAnnotation?.name);
        }
      }
      continue;
    }
    if (statement.kind === "ClassStatement" && locallyExportedNames.has((statement as ClassStatement).name.name)) {
      return namedType(importedName);
    }
    if (statement.kind === "InterfaceStatement" && locallyExportedNames.has((statement as InterfaceStatement).name.name)) {
      return namedType(importedName);
    }
    if (statement.kind === "EnumStatement" && locallyExportedNames.has((statement as EnumStatement).name.name)) {
      return namedType(importedName);
    }
    if (statement.kind === "TypeAliasStatement" && locallyExportedNames.has((statement as TypeAliasStatement).name.name)) {
      return namedType(importedName);
    }
    if (statement.kind === "VarStatement") {
      const identifiers = bindingIdentifiers((statement as VarStatement).name);
      if (identifiers[0]?.name && locallyExportedNames.has(identifiers[0].name)) {
        return externalTypeFromAnnotationText((statement as VarStatement).typeAnnotation?.name);
      }
    }
  }

  return null;
}

function collectNodeModuleNamespaceExportedProperties(
  declarations: readonly Statement[]
): Record<string, AnalysisType> {
  const properties: Record<string, AnalysisType> = {};
  for (const statement of declarations) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    const namedDeclaration = declaration as { name?: { name?: string } };
    const declarationName = namedDeclaration.name?.name;

    if (declaration.kind === "FunctionStatement" && declarationName) {
      properties[declarationName] =
        callableTypeFromNamedExportedFunction([statement], declarationName) ?? UNKNOWN_TYPE;
      continue;
    }
    if (declaration.kind === "VarStatement") {
      const identifiers = bindingIdentifiers((declaration as VarStatement).name);
      for (const identifier of identifiers) {
        properties[identifier.name] = externalTypeFromAnnotationText((declaration as VarStatement).typeAnnotation?.name);
      }
      continue;
    }
    if (
      (declaration.kind === "ClassStatement"
      || declaration.kind === "InterfaceStatement"
      || declaration.kind === "EnumStatement"
      || declaration.kind === "TypeAliasStatement")
      && declarationName
    ) {
      properties[declarationName] = namedType(declarationName);
      continue;
    }
    if (declaration.kind === "NamespaceStatement") {
      const namespaceName = (declaration as NamespaceStatement).names?.[0]?.name;
      if (namespaceName) {
        properties[namespaceName] = namedType(namespaceName);
      }
    }
  }
  return properties;
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

    const declarations = await collectTypingsDeclarations(typingsPath, vfs, new Set<string>());
    const defaultExportName = detectDtsDefaultExportName(parsed.ast) ?? "";
    const loaded: CachedTypingsData = {
      declarations,
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
    const namespaceExportProperties = collectNodeModuleNamespaceExportedProperties(typings.declarations);
    const namespaceImportType = Object.keys(namespaceExportProperties).length > 0
      ? objectTypeWithProperties(namespaceExportProperties)
      : null;
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
      importedSymbolTypes.set(importStatement.namespaceImport.name, namespaceImportType ?? exportType);
    }
    for (const s of importStatement.specifiers) {
      const localName = (s.local ?? s.imported).name;
      const declaredType = externalNamedImportType(typings.declarations, s.imported.name) ?? declarationAnalysis?.getTopLevelSymbolType(s.imported.name);
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
