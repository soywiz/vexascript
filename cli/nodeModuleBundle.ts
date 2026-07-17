import { builtinModules } from "node:module";
import type { Program, Statement, VarStatement, FunctionStatement, ClassStatement, EnumStatement, ExportStatement } from "../compiler/ast/ast";
import { parseSource } from "../compiler/pipeline/parse";
import { tokenize } from "../compiler/parser/tokenizer";
import { emitProgram } from "../compiler/runtime/emitter";
import { basename, dirname, extname, relative, resolve } from "../compiler/utils/path";
import { hasRecognizedModuleFileExtension } from "../compiler/language";
import { vfs, type Vfs } from "../compiler/vfs";

interface BundleNodeModulesOptions {
  vfs?: Vfs;
  virtualSources?: ReadonlyMap<string, string>;
  importMappings?: Readonly<Record<string, string>>;
  externalDependencyStrategy?: "runtime-error" | "node-require";
  baseUrl?: string;
}

export interface BundleNodeModulesResult {
  code: string;
  watchedFiles: string[];
}

interface BundledModuleRecord {
  id: string;
  filePath: string;
  code: string;
  dependencyMap: Record<string, string | null>;
}

interface CachedBundledModuleArtifact {
  mtimeMs: number;
  code: string;
  resolvedDependencies: Record<string, string | null>;
}

type VfsStatResult = Awaited<ReturnType<Vfs["stat"]>> | null;

type ResolvedDependency =
  | { kind: "bundled"; filePath: string }
  | { kind: "external" };

interface ResolutionContext {
  packageJsonByDir: Map<string, Record<string, unknown> | null>;
  statByPath: Map<string, VfsStatResult>;
  fileExistsByPath: Map<string, boolean>;
  isDirectoryByPath: Map<string, boolean>;
  fileMtimeByPath: Map<string, number | null>;
  readDirByPath: Map<string, Awaited<ReturnType<Vfs["readDir"]>> | null>;
  resolvedPathWithExtensionsByPath: Map<string, string | null>;
  resolvedDirectoryModuleByPath: Map<string, string | null>;
  resolvedAsModulePathByPath: Map<string, string | null>;
  resolvedBareSpecifierInPnpmStoreByKey: Map<string, string | null>;
  resolvedBareSpecifierByKey: Map<string, string | null>;
  resolvedDependencyByKey: Map<string, ResolvedDependency>;
}

const NODE_BUILTIN_SET = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => specifier.startsWith("node:") ? specifier : `node:${specifier}`)
]);

const STATIC_REQUIRE_PATTERN = /\brequire\s*\(\s*(['"])([^"'`]+)\1\s*\)/g;
const STATIC_DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(['"])([^"'`]+)\1\s*\)/g;
const bundledModuleArtifactCache = new Map<string, CachedBundledModuleArtifact>();

interface StaticDynamicImportOccurrence {
  specifier: string;
  startOffset: number;
  endOffset: number;
}

function createResolutionContext(): ResolutionContext {
  return {
    packageJsonByDir: new Map(),
    statByPath: new Map(),
    fileExistsByPath: new Map(),
    isDirectoryByPath: new Map(),
    fileMtimeByPath: new Map(),
    readDirByPath: new Map(),
    resolvedPathWithExtensionsByPath: new Map(),
    resolvedDirectoryModuleByPath: new Map(),
    resolvedAsModulePathByPath: new Map(),
    resolvedBareSpecifierInPnpmStoreByKey: new Map(),
    resolvedBareSpecifierByKey: new Map(),
    resolvedDependencyByKey: new Map()
  };
}

function dependencyCacheKey(importerFilePath: string, specifier: string): string {
  return `${importerFilePath}\n${specifier}`;
}

async function statInVfs(path: string, vfs: Vfs, context: ResolutionContext): Promise<VfsStatResult> {
  if (context.statByPath.has(path)) {
    return context.statByPath.get(path) ?? null;
  }
  const stat = await vfs.stat(path).catch(() => null);
  context.statByPath.set(path, stat);
  return stat;
}

function isBuiltinSpecifier(specifier: string): boolean {
  return NODE_BUILTIN_SET.has(specifier) || NODE_BUILTIN_SET.has(`node:${specifier}`);
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function splitPackageSpecifier(specifier: string): { packageName: string; subpath: string | null } {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    const packageName = parts.slice(0, 2).join("/");
    const subpath = parts.length > 2 ? parts.slice(2).join("/") : null;
    return { packageName, subpath };
  }
  const [packageName, ...rest] = specifier.split("/");
  return {
    packageName: packageName ?? specifier,
    subpath: rest.length > 0 ? rest.join("/") : null
  };
}

async function readPackageJson(packageDir: string, vfs: Vfs, context: ResolutionContext): Promise<Record<string, unknown> | null> {
  if (context.packageJsonByDir.has(packageDir)) {
    return context.packageJsonByDir.get(packageDir) ?? null;
  }
  const packageJsonPath = resolve(packageDir, "package.json");
  if (!(await fileExistsInVfs(packageJsonPath, vfs, context))) {
    context.packageJsonByDir.set(packageDir, null);
    return null;
  }
  try {
    const source = await vfs.readFile(packageJsonPath);
    if (source === null) {
      context.packageJsonByDir.set(packageDir, null);
      return null;
    }
    const parsed = JSON.parse(source);
    const result = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    context.packageJsonByDir.set(packageDir, result);
    return result;
  } catch {
    context.packageJsonByDir.set(packageDir, null);
    return null;
  }
}

async function fileExistsInVfs(path: string, vfs: Vfs, context: ResolutionContext): Promise<boolean> {
  if (context.fileExistsByPath.has(path)) {
    return context.fileExistsByPath.get(path) === true;
  }
  const stat = await statInVfs(path, vfs, context);
  if (stat) {
    context.fileExistsByPath.set(path, true);
    return true;
  }
  const exists = await vfs.fileExists(path).catch(() => false);
  context.fileExistsByPath.set(path, exists);
  return exists;
}

async function isDirectoryInVfs(path: string, vfs: Vfs, context: ResolutionContext): Promise<boolean> {
  if (context.isDirectoryByPath.has(path)) {
    return context.isDirectoryByPath.get(path) === true;
  }
  const isDirectory = (await statInVfs(path, vfs, context))?.isDirectory === true;
  context.isDirectoryByPath.set(path, isDirectory);
  return isDirectory;
}

async function fileMtimeInVfs(path: string, vfs: Vfs, context: ResolutionContext): Promise<number | null> {
  if (context.fileMtimeByPath.has(path)) {
    return context.fileMtimeByPath.get(path) ?? null;
  }
  const mtimeMs = (await statInVfs(path, vfs, context))?.mtimeMs ?? null;
  context.fileMtimeByPath.set(path, mtimeMs);
  return mtimeMs;
}

async function readDirInVfs(path: string, vfs: Vfs, context: ResolutionContext): Promise<Awaited<ReturnType<Vfs["readDir"]>> | null> {
  if (context.readDirByPath.has(path)) {
    return context.readDirByPath.get(path) ?? null;
  }
  const entries = await vfs.readDir(path).catch(() => null);
  context.readDirByPath.set(path, entries);
  return entries;
}

async function resolvePathWithExtensions(
  basePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  context: ResolutionContext
): Promise<string | null> {
  if (context.resolvedPathWithExtensionsByPath.has(basePath)) {
    return context.resolvedPathWithExtensionsByPath.get(basePath) ?? null;
  }
  const candidates = hasRecognizedModuleFileExtension(basePath)
    ? [basePath]
    : [
        basePath,
        `${basePath}.vx`,
        `${basePath}.js`,
        `${basePath}.mjs`,
        `${basePath}.cjs`,
        `${basePath}.json`,
        `${basePath}.ts`,
        `${basePath}.tsx`
      ];
  for (const candidate of candidates) {
    if (virtualSources.has(candidate)) {
      context.resolvedPathWithExtensionsByPath.set(basePath, candidate);
      return candidate;
    }
    if ((await fileExistsInVfs(candidate, vfs, context)) && !(await isDirectoryInVfs(candidate, vfs, context))) {
      context.resolvedPathWithExtensionsByPath.set(basePath, candidate);
      return candidate;
    }
  }
  context.resolvedPathWithExtensionsByPath.set(basePath, null);
  return null;
}

function packageExportTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["import", "default", "require", "node"]) {
    const target = packageExportTarget(record[key]);
    if (target) {
      return target;
    }
  }
  return null;
}

async function resolveDirectoryModule(
  directoryPath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  context: ResolutionContext
): Promise<string | null> {
  if (context.resolvedDirectoryModuleByPath.has(directoryPath)) {
    return context.resolvedDirectoryModuleByPath.get(directoryPath) ?? null;
  }
  const packageJson = await readPackageJson(directoryPath, vfs, context);
  if (packageJson) {
    const exportsField = packageExportTarget(packageJson["exports"]);
    const moduleField = typeof packageJson["module"] === "string" ? packageJson["module"] : null;
    const mainField = typeof packageJson["main"] === "string" ? packageJson["main"] : null;
    for (const candidate of [exportsField, moduleField, mainField]) {
      if (!candidate) {
        continue;
      }
      const resolvedEntry = await resolveAsModulePath(resolve(directoryPath, candidate), vfs, virtualSources, context);
      if (resolvedEntry) {
        context.resolvedDirectoryModuleByPath.set(directoryPath, resolvedEntry);
        return resolvedEntry;
      }
    }
  }
  for (const indexName of ["index.js", "index.mjs", "index.cjs", "index.json", "index.ts", "index.tsx"]) {
    const candidate = resolve(directoryPath, indexName);
    if (virtualSources.has(candidate)) {
      context.resolvedDirectoryModuleByPath.set(directoryPath, candidate);
      return candidate;
    }
    if (await fileExistsInVfs(candidate, vfs, context)) {
      context.resolvedDirectoryModuleByPath.set(directoryPath, candidate);
      return candidate;
    }
  }
  context.resolvedDirectoryModuleByPath.set(directoryPath, null);
  return null;
}

async function resolveAsModulePath(
  candidatePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  context: ResolutionContext
): Promise<string | null> {
  if (context.resolvedAsModulePathByPath.has(candidatePath)) {
    return context.resolvedAsModulePathByPath.get(candidatePath) ?? null;
  }
  const direct = await resolvePathWithExtensions(candidatePath, vfs, virtualSources, context);
  if (direct) {
    context.resolvedAsModulePathByPath.set(candidatePath, direct);
    return direct;
  }
  if (await isDirectoryInVfs(candidatePath, vfs, context)) {
    const resolved = await resolveDirectoryModule(candidatePath, vfs, virtualSources, context);
    context.resolvedAsModulePathByPath.set(candidatePath, resolved);
    return resolved;
  }
  context.resolvedAsModulePathByPath.set(candidatePath, null);
  return null;
}

async function resolveBareSpecifierInPnpmVirtualStore(
  nodeModulesDir: string,
  specifier: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  context: ResolutionContext
): Promise<string | null> {
  const cacheKey = dependencyCacheKey(nodeModulesDir, specifier);
  if (context.resolvedBareSpecifierInPnpmStoreByKey.has(cacheKey)) {
    return context.resolvedBareSpecifierInPnpmStoreByKey.get(cacheKey) ?? null;
  }
  const storeDir = resolve(nodeModulesDir, ".pnpm");
  const entries = await readDirInVfs(storeDir, vfs, context);
  if (!entries) {
    context.resolvedBareSpecifierInPnpmStoreByKey.set(cacheKey, null);
    return null;
  }

  const { packageName, subpath } = splitPackageSpecifier(specifier);
  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    const packageDir = resolve(storeDir, entry.name, "node_modules", packageName);
    if (!(await isDirectoryInVfs(packageDir, vfs, context))) {
      continue;
    }

    const packageJson = await readPackageJson(packageDir, vfs, context);
    const exportsValue = packageJson?.["exports"];
    if (subpath && exportsValue && typeof exportsValue === "object" && !Array.isArray(exportsValue)) {
      const exportsField = exportsValue as Record<string, unknown>;
      const exportKey = `./${subpath}`;
      const exportTarget = packageExportTarget(exportsField[exportKey]);
      if (exportTarget) {
        const resolvedExport = await resolveAsModulePath(resolve(packageDir, exportTarget), vfs, virtualSources, context);
        if (resolvedExport) {
          context.resolvedBareSpecifierInPnpmStoreByKey.set(cacheKey, resolvedExport);
          return resolvedExport;
        }
      }
    }

    const rootTarget = subpath ? resolve(packageDir, subpath) : packageDir;
    const resolved = await resolveAsModulePath(rootTarget, vfs, virtualSources, context);
    if (resolved) {
      context.resolvedBareSpecifierInPnpmStoreByKey.set(cacheKey, resolved);
      return resolved;
    }
  }

  context.resolvedBareSpecifierInPnpmStoreByKey.set(cacheKey, null);
  return null;
}

async function resolveBareSpecifier(
  importerFilePath: string,
  specifier: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  context: ResolutionContext
): Promise<string | null> {
  const cacheKey = dependencyCacheKey(importerFilePath, specifier);
  if (context.resolvedBareSpecifierByKey.has(cacheKey)) {
    return context.resolvedBareSpecifierByKey.get(cacheKey) ?? null;
  }
  const { packageName, subpath } = splitPackageSpecifier(specifier);
  let currentDir = dirname(importerFilePath);
  while (true) {
    const packageDir = resolve(currentDir, "node_modules", packageName);
    if (await isDirectoryInVfs(packageDir, vfs, context)) {
      const packageJson = await readPackageJson(packageDir, vfs, context);
      const exportsValue = packageJson?.["exports"];
      if (subpath && exportsValue && typeof exportsValue === "object" && !Array.isArray(exportsValue)) {
        const exportsField = exportsValue as Record<string, unknown>;
        const exportKey = `./${subpath}`;
        const exportTarget = packageExportTarget(exportsField[exportKey]);
        if (exportTarget) {
          const resolvedExport = await resolveAsModulePath(resolve(packageDir, exportTarget), vfs, virtualSources, context);
          if (resolvedExport) {
            context.resolvedBareSpecifierByKey.set(cacheKey, resolvedExport);
            return resolvedExport;
          }
        }
      }

      const rootTarget = subpath ? resolve(packageDir, subpath) : packageDir;
      const resolved = await resolveAsModulePath(rootTarget, vfs, virtualSources, context);
      if (resolved) {
        context.resolvedBareSpecifierByKey.set(cacheKey, resolved);
        return resolved;
      }
    }

    const nodeModulesDir = resolve(currentDir, "node_modules");
    const resolvedFromPnpmStore = await resolveBareSpecifierInPnpmVirtualStore(nodeModulesDir, specifier, vfs, virtualSources, context);
    if (resolvedFromPnpmStore) {
      context.resolvedBareSpecifierByKey.set(cacheKey, resolvedFromPnpmStore);
      return resolvedFromPnpmStore;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  context.resolvedBareSpecifierByKey.set(cacheKey, null);
  return null;
}

async function resolveDependency(
  importerFilePath: string,
  specifier: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  importMappings: Readonly<Record<string, string>>,
  baseUrl: string | undefined,
  context: ResolutionContext
): Promise<ResolvedDependency> {
  const cacheKey = dependencyCacheKey(importerFilePath, specifier);
  const cached = context.resolvedDependencyByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (isBuiltinSpecifier(specifier)) {
    const resolved = { kind: "external" } satisfies ResolvedDependency;
    context.resolvedDependencyByKey.set(cacheKey, resolved);
    return resolved;
  }

  const mappedTarget = importMappings[specifier];
  if (mappedTarget) {
    const targetPath = await resolveAsModulePath(mappedTarget, vfs, virtualSources, context);
    if (targetPath) {
      const resolved = { kind: "bundled", filePath: targetPath } satisfies ResolvedDependency;
      context.resolvedDependencyByKey.set(cacheKey, resolved);
      return resolved;
    }
  }

  if (baseUrl && !isRelativeOrAbsoluteSpecifier(specifier)) {
    const targetPath = await resolveAsModulePath(resolve(baseUrl, specifier), vfs, virtualSources, context);
    if (targetPath) {
      const resolved = { kind: "bundled", filePath: targetPath } satisfies ResolvedDependency;
      context.resolvedDependencyByKey.set(cacheKey, resolved);
      return resolved;
    }
  }

  if (isRelativeOrAbsoluteSpecifier(specifier)) {
    const targetPath = await resolveAsModulePath(
      specifier.startsWith("/") ? specifier : resolve(dirname(importerFilePath), specifier),
      vfs,
      virtualSources,
      context
    );
    if (targetPath) {
      const resolved = { kind: "bundled", filePath: targetPath } satisfies ResolvedDependency;
      context.resolvedDependencyByKey.set(cacheKey, resolved);
      return resolved;
    }
    const resolved = { kind: "external" } satisfies ResolvedDependency;
    context.resolvedDependencyByKey.set(cacheKey, resolved);
    return resolved;
  }

  const packagePath = await resolveBareSpecifier(importerFilePath, specifier, vfs, virtualSources, context);
  if (packagePath) {
    const resolved = { kind: "bundled", filePath: packagePath } satisfies ResolvedDependency;
    context.resolvedDependencyByKey.set(cacheKey, resolved);
    return resolved;
  }
  const resolved = { kind: "external" } satisfies ResolvedDependency;
  context.resolvedDependencyByKey.set(cacheKey, resolved);
  return resolved;
}

export function detectStaticRequires(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(STATIC_REQUIRE_PATTERN)) {
    const specifier = match[2];
    if (specifier) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

export function detectStaticDynamicImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const occurrence of collectStaticDynamicImportOccurrences(source)) {
    const specifier = occurrence.specifier;
    if (specifier) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

export function rewriteStaticDynamicImports(source: string): string {
  const occurrences = collectStaticDynamicImportOccurrences(source);
  if (occurrences.length === 0) {
    return source;
  }

  let rewritten = "";
  let cursor = 0;
  for (const occurrence of occurrences) {
    rewritten += source.slice(cursor, occurrence.startOffset);
    rewritten += `__vexaImport(${JSON.stringify(occurrence.specifier)})`;
    cursor = occurrence.endOffset;
  }
  rewritten += source.slice(cursor);
  return rewritten;
}

function collectStaticDynamicImportOccurrences(source: string): StaticDynamicImportOccurrence[] {
  try {
    const tokens = tokenize(source);
    const occurrences: StaticDynamicImportOccurrence[] = [];
    for (let index = 0; index <= tokens.length - 4; index += 1) {
      const importToken = tokens[index];
      const openParenToken = tokens[index + 1];
      const specifierToken = tokens[index + 2];
      const closeParenToken = tokens[index + 3];
      if (
        importToken?.type === "identifier"
        && importToken.value === "import"
        && openParenToken?.type === "symbol"
        && openParenToken.value === "("
        && specifierToken?.type === "string"
        && closeParenToken?.type === "symbol"
        && closeParenToken.value === ")"
      ) {
        occurrences.push({
          specifier: specifierToken.value,
          startOffset: importToken.range.start.offset,
          endOffset: closeParenToken.range.end.offset
        });
      }
    }
    return occurrences;
  } catch {
    const occurrences: StaticDynamicImportOccurrence[] = [];
    for (const match of source.matchAll(STATIC_DYNAMIC_IMPORT_PATTERN)) {
      const specifier = match[2];
      const startOffset = match.index;
      if (!specifier || startOffset === undefined) {
        continue;
      }
      occurrences.push({
        specifier,
        startOffset,
        endOffset: startOffset + match[0].length
      });
    }
    return occurrences;
  }
}

function collectExportedDeclarationNames(statement: Statement): string[] {
  if (statement.kind === "VarStatement") {
    const variable = statement as VarStatement;
    const declarations = variable.declarations ?? [{ name: variable.name }];
    const names: string[] = [];
    for (const declaration of declarations) {
      if (declaration.name.kind === "Identifier") {
        names.push(declaration.name.name);
      }
    }
    return names;
  }
  if (statement.kind === "FunctionStatement" || statement.kind === "ClassStatement" || statement.kind === "EnumStatement") {
    return [(statement as FunctionStatement | ClassStatement | EnumStatement).name.name];
  }
  return [];
}

function collectExplicitExportNames(program: Program): string[] {
  const exportNames = new Set<string>();
  for (const statement of program.body) {
    if (statement.kind !== "ExportStatement") {
      continue;
    }
    const exportStatement = statement as ExportStatement;
    if (exportStatement.typeOnly) {
      continue;
    }
    if (exportStatement.default) {
      exportNames.add("default");
    }
    if (exportStatement.namespaceExport) {
      exportNames.add(exportStatement.namespaceExport.name);
    }
    for (const specifier of exportStatement.specifiers ?? []) {
      if (!specifier.typeOnly) {
        exportNames.add(specifier.exported.name);
      }
    }
    if (exportStatement.declaration) {
      for (const name of collectExportedDeclarationNames(exportStatement.declaration)) {
        exportNames.add(name);
      }
    }
  }
  return [...exportNames];
}

export function shouldPreserveCommonJsSource(source: string, filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  if (extension !== ".js" && extension !== ".cjs") {
    return false;
  }
  const hasCommonJsMarkers = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(source);
  const hasEsmMarkers = /^\s*import\b|^\s*export\b/m.test(source);
  return hasCommonJsMarkers && !hasEsmMarkers;
}

export function transpileModuleSource(source: string, filePath: string): { code: string; exportNames: string[] | null } {
  if (shouldPreserveCommonJsSource(source, filePath)) {
    return {
      code: source,
      exportNames: null
    };
  }
  const extension = extname(filePath).toLowerCase();
  const parsed = parseSource(source, {
    language: "typescript",
    jsx: extension === ".tsx" || extension === ".jsx"
  });
  if (!parsed.ast) {
    const detail = parsed.fatalError
      ?? parsed.tokenizeError?.message
      ?? parsed.parserIssues[0]?.message
      ?? "unknown parse error";
    throw new Error(`Unable to parse bundled module '${filePath}': ${detail}`);
  }
  if (parsed.parserIssues.length > 0) {
    const issue = parsed.parserIssues[0]!;
    throw new Error(`Unable to parse bundled module '${filePath}': ${issue.message}`);
  }
  return {
    code: emitProgram(parsed.ast, undefined, undefined, undefined, {
      moduleFormat: "commonjs",
      sourceLanguage: "typescript"
    }),
    exportNames: collectExplicitExportNames(parsed.ast)
  };
}

function commonAncestorDirectory(paths: readonly string[]): string {
  if (paths.length === 0) {
    return ".";
  }
  const segments = paths.map((path) => resolve(path).split("/").filter((segment) => segment.length > 0));
  const shared: string[] = [];
  const minLength = Math.min(...segments.map((parts) => parts.length));
  for (let index = 0; index < minLength; index += 1) {
    const candidate = segments[0]?.[index];
    if (!candidate || !segments.every((parts) => parts[index] === candidate)) {
      break;
    }
    shared.push(candidate);
  }
  return shared.length > 0 ? `/${shared.join("/")}` : "/";
}

function minimalBundlePath(rootDir: string, filePath: string): string {
  const relativePath = relative(rootDir, filePath);
  if (relativePath.length === 0) {
    return basename(filePath);
  }
  if (relativePath.startsWith(".")) {
    return relativePath;
  }
  return `./${relativePath}`;
}

export function collectCommonJsExports(code: string): string[] {
  const exports = new Set<string>();
  const exportPattern = /\bexports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  for (const match of code.matchAll(exportPattern)) {
    const exportName = match[1];
    if (exportName && exportName !== "__esModule") {
      exports.add(exportName);
    }
  }
  if (/\bexports\.default\s*=/.test(code)) {
    exports.add("default");
  }
  if (/\bmodule\.exports\s*=/.test(code)) {
    exports.add("default");
  }
  return [...exports];
}

function createModuleFactoryCode(
  moduleId: string,
  displayFilePath: string,
  transpiledCode: string
): string {
  const moduleDir = dirname(displayFilePath);
  return [
    `${JSON.stringify(moduleId)}: async function (module, exports, __requireFrom) {`,
    `  const require = (specifier) => __requireFrom(${JSON.stringify(moduleId)}, specifier);`,
    `  const __vexaImport = (specifier) => __vexaImportFrom(${JSON.stringify(moduleId)}, specifier);`,
    `  require.resolve = (specifier) => specifier;`,
    `  const __filename = ${JSON.stringify(displayFilePath)};`,
    `  const __dirname = ${JSON.stringify(moduleDir)};`,
    transpiledCode
      .split("\n")
      .map((line) => line.length > 0 ? `  ${line}` : "")
      .join("\n"),
    `}`
  ].join("\n");
}

async function createCachedBundledModuleArtifact(
  filePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  importMappings: Readonly<Record<string, string>>,
  baseUrl: string | undefined,
  context: ResolutionContext
): Promise<CachedBundledModuleArtifact> {
  const extension = extname(filePath).toLowerCase();
  const source = virtualSources.get(filePath) ?? await vfs.readFile(filePath);
  if (source === null) {
    throw new Error(`Unable to read bundled module '${filePath}'`);
  }
  const transpiled = extension === ".json"
    ? { code: `module.exports = ${source.trim()};`, exportNames: ["default"] }
    : extension === ".txt"
      ? { code: `module.exports = ${JSON.stringify(source)};`, exportNames: ["default"] }
      : transpileModuleSource(source, filePath);
  const transpiledCode = rewriteStaticDynamicImports(transpiled.code);
  const resolvedDependencies: Record<string, string | null> = {};
  for (const specifier of [...detectStaticRequires(transpiledCode), ...detectStaticDynamicImports(transpiled.code)]) {
    const resolved = await resolveDependency(filePath, specifier, vfs, virtualSources, importMappings, baseUrl, context);
    resolvedDependencies[specifier] = resolved.kind === "bundled" ? resolved.filePath : null;
  }
  return {
    mtimeMs: await fileMtimeInVfs(filePath, vfs, context) ?? -1,
    code: transpiledCode,
    resolvedDependencies
  };
}

async function loadBundledModuleArtifact(
  filePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  importMappings: Readonly<Record<string, string>>,
  baseUrl: string | undefined,
  context: ResolutionContext
): Promise<CachedBundledModuleArtifact> {
  if (virtualSources.has(filePath)) {
    return createCachedBundledModuleArtifact(filePath, vfs, virtualSources, importMappings, baseUrl, context);
  }

  const mtimeMs = await fileMtimeInVfs(filePath, vfs, context);
  const cached = mtimeMs === null ? undefined : bundledModuleArtifactCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached;
  }

  const artifact = await createCachedBundledModuleArtifact(filePath, vfs, virtualSources, importMappings, baseUrl, context);
  bundledModuleArtifactCache.set(filePath, artifact);
  return artifact;
}

export async function bundleNodeModuleGraph(
  entrySource: string,
  sourcePath: string,
  options: BundleNodeModulesOptions = {}
): Promise<BundleNodeModulesResult> {
  const activeVfs = options.vfs ?? vfs();
  const virtualSources = options.virtualSources ?? new Map<string, string>();
  const importMappings = options.importMappings ?? {};
  const baseUrl = options.baseUrl;
  const resolutionContext = createResolutionContext();
  const externalDependencyStrategy = options.externalDependencyStrategy ?? "runtime-error";
  const entryId = "__vexa_entry__";
  const moduleById = new Map<string, BundledModuleRecord>();
  const moduleIdByPath = new Map<string, string>();
  const watchedFiles = new Set<string>([sourcePath]);
  let nextModuleIndex = 0;

  const visitResolvedFile = async (filePath: string): Promise<string> => {
    const existing = moduleIdByPath.get(filePath);
    if (existing) {
      return existing;
    }

    const moduleId = `__vexa_module_${nextModuleIndex++}`;
    moduleIdByPath.set(filePath, moduleId);

    if (!virtualSources.has(filePath)) {
      watchedFiles.add(filePath);
    }
    const artifact = await loadBundledModuleArtifact(filePath, activeVfs, virtualSources, importMappings, baseUrl, resolutionContext);
    const dependencyMap: Record<string, string | null> = {};
    for (const [specifier, resolvedFilePath] of Object.entries(artifact.resolvedDependencies)) {
      if (resolvedFilePath !== null) {
        dependencyMap[specifier] = await visitResolvedFile(resolvedFilePath);
      } else {
        dependencyMap[specifier] = null;
      }
    }

    moduleById.set(moduleId, {
      id: moduleId,
      filePath,
      code: artifact.code,
      dependencyMap
    });
    return moduleId;
  };

  const entryTranspiled = virtualSources.has(sourcePath)
    ? { code: entrySource, exportNames: null }
    : transpileModuleSource(entrySource, sourcePath);
  const entryCode = rewriteStaticDynamicImports(entryTranspiled.code);
  const entryDependencyMap: Record<string, string | null> = {};
  for (const specifier of [...detectStaticRequires(entryCode), ...detectStaticDynamicImports(entryTranspiled.code)]) {
    const resolved = await resolveDependency(sourcePath, specifier, activeVfs, virtualSources, importMappings, baseUrl, resolutionContext);
    if (resolved.kind === "bundled") {
      entryDependencyMap[specifier] = await visitResolvedFile(resolved.filePath);
    } else {
      entryDependencyMap[specifier] = null;
    }
  }
  moduleById.set(entryId, {
    id: entryId,
    filePath: sourcePath,
    code: entryCode,
    dependencyMap: entryDependencyMap
  });

  const bundleRootDir = commonAncestorDirectory([...moduleById.values()].map((record) => record.filePath));
  const entryExports = entryTranspiled.exportNames ?? collectCommonJsExports(entryCode);
  const dependencyMapsLiteral = [...moduleById.values()]
    .map((record) => `${JSON.stringify(record.id)}: ${JSON.stringify(record.dependencyMap)}`)
    .join(",\n");
  const moduleFactoriesLiteral = [...moduleById.values()]
    .map((record) => createModuleFactoryCode(record.id, minimalBundlePath(bundleRootDir, record.filePath), record.code))
    .join(",\n");

  const exportLines = entryExports
    .filter((name) => name !== "default")
    .map((name) => `const __vexa_export_${name} = __vexaEntry[${JSON.stringify(name)}];`)
    .join("\n");
  const namedExportClause = entryExports
    .filter((name) => name !== "default")
    .map((name) => `__vexa_export_${name} as ${name}`)
    .join(", ");
  const defaultExportLine = entryExports.includes("default")
    ? `export default __vexaEntry.default;`
    : "";

  return {
    code: [
    ...(externalDependencyStrategy === "node-require"
      ? [
          `import { createRequire as __vexaCreateRequire } from "node:module";`,
          `const __vexaExternalRequire = __vexaCreateRequire(import.meta.url);`
        ]
      : []),
    `const __vexaDependencyMaps = {`,
    dependencyMapsLiteral,
    `};`,
    `const __vexaModules = {`,
    moduleFactoriesLiteral,
    `};`,
    `const __vexaCache = Object.create(null);`,
    `const process = globalThis.process ?? { env: { NODE_ENV: "production" } };`,
    `function __vexaMissingExternal(specifier) {`,
    `  throw new Error(\`Unbundled external dependency '\${specifier}' is not available in browser-safe Vexa bundles.\`);`,
    `}`,
    `function __vexaRequireFrom(importerId, specifier) {`,
    `  const mapped = __vexaDependencyMaps[importerId]?.[specifier] ?? null;`,
    `  if (mapped !== null) {`,
    `    return __vexaRequireModule(mapped);`,
    `  }`,
    externalDependencyStrategy === "node-require"
      ? `  return __vexaExternalRequire(specifier);`
      : `  return __vexaMissingExternal(specifier);`,
    `}`,
    `async function __vexaImportFrom(importerId, specifier) {`,
    `  const mapped = __vexaDependencyMaps[importerId]?.[specifier] ?? null;`,
    `  if (mapped !== null) {`,
    `    return await __vexaAwaitModule(mapped);`,
    `  }`,
    externalDependencyStrategy === "node-require"
      ? `  return __vexaExternalRequire(specifier);`
      : `  return __vexaMissingExternal(specifier);`,
    `}`,
    `function __vexaRequireModule(moduleId) {`,
    `  const cached = __vexaCache[moduleId];`,
    `  if (cached) {`,
    `    return cached.exports;`,
    `  }`,
    `  const module = { exports: {} };`,
    `  __vexaCache[moduleId] = module;`,
    `  const factory = __vexaModules[moduleId];`,
    `  if (!factory) {`,
    `    throw new Error(\`Unknown bundled module '\${moduleId}'\`);`,
    `  }`,
    `  module.__vexaPromise = Promise.resolve(factory(module, module.exports, __vexaRequireFrom)).then(() => module.exports);`,
    `  return module.exports;`,
    `}`,
    `async function __vexaAwaitModule(moduleId) {`,
    `  __vexaRequireModule(moduleId);`,
    `  const module = __vexaCache[moduleId];`,
    `  if (module?.__vexaPromise) {`,
    `    await module.__vexaPromise;`,
    `  }`,
    `  return module?.exports;`,
    `}`,
    `const __vexaEntry = await __vexaAwaitModule(${JSON.stringify(entryId)});`,
    exportLines,
    namedExportClause.length > 0 ? `export { ${namedExportClause} };` : `export {};`,
    defaultExportLine
  ].filter((line) => line.length > 0).join("\n"),
    watchedFiles: [...watchedFiles]
  };
}
