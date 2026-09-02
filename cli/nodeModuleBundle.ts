import { ClassStatement, EnumStatement, ExportStatement, FunctionStatement, VarStatement } from "compiler/ast/ast";
import { builtinModules } from "node:module";
import type { Program, Statement } from "../compiler/ast/ast";
import { bindingIdentifiers } from "../compiler/ast/bindingPatterns";
import { parseSource } from "../compiler/pipeline/parse";
import { tokenize, TokenType, type Token } from "../compiler/parser/tokenizer";
import { emitProgram } from "../compiler/runtime/emitter";
import {
  asTextModulePath,
  isTextModulePath,
  textModuleSourcePath,
  textModuleSourceSpecifier
} from "../compiler/runtime/textModuleImports";
import { basename, dirname, extname, relative, resolve } from "../compiler/utils/path";
import { hasRecognizedModuleFileExtension } from "../compiler/language";
import { vfs, type Vfs } from "../compiler/vfs";

type ImportMappings = Readonly<Partial<Record<string, string>>>;

export interface BundleNodeModulesOptions {
  vfs?: Vfs;
  virtualSources?: ReadonlyMap<string, string>;
  importMappings?: ImportMappings;
  externalDependencyStrategy?: "runtime-error" | "node-require";
  baseUrl?: string;
  incrementalCache?: NodeModuleBundleIncrementalCache;
  changedFiles?: readonly string[];
  pnpmVirtualStore?: boolean;
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

export interface NodeModuleBundleIncrementalCache {}

interface NodeModuleBundleIncrementalState {
  sourcePath: string;
  configurationKey: string;
  entrySpecifiers: string[];
  virtualSources: Map<string, string>;
  moduleById: Map<string, BundledModuleRecord>;
  moduleIdByPath: Map<string, string>;
  watchedFiles: string[];
  entryDependencyMap: Record<string, string | null>;
  bundleRootDir: string;
  dependencyMapsLiteral: string;
  moduleFactoriesLiteral: string;
  nextModuleIndex: number;
}

type VfsStatResult = Awaited<ReturnType<Vfs["stat"]>> | null;

type ResolvedDependency =
  | { kind: "bundled"; filePath: string }
  | { kind: "external" };

interface ResolutionContext {
  pnpmVirtualStore: boolean;
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

const bundledModuleArtifactCache = new Map<string, CachedBundledModuleArtifact>();
const incrementalBundleStates = new WeakMap<NodeModuleBundleIncrementalCache, NodeModuleBundleIncrementalState>();

export function createNodeModuleBundleIncrementalCache(): NodeModuleBundleIncrementalCache {
  return {};
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dependencyVirtualSources(
  virtualSources: ReadonlyMap<string, string>,
  sourcePath: string
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [filePath, source] of virtualSources) {
    if (filePath !== sourcePath) result.set(filePath, source);
  }
  return result;
}

function sameVirtualSources(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) return false;
  for (const [filePath, source] of left) {
    if (right.get(filePath) !== source) return false;
  }
  return true;
}

interface StaticDynamicImportOccurrence {
  specifier: string;
  startOffset: number;
  endOffset: number;
}

class SourceReplacement {
  constructor(
    public startOffset: number,
    public endOffset: number,
    public text: string
  ) {}
}

class ModuleSpecifierBinding {
  constructor(
    public imported: string,
    public local: string
  ) {}
}

class ModuleTransformResult {
  constructor(
    public replacement: SourceReplacement,
    public endIndex: number,
    public exportNames: string[] = []
  ) {}
}

export class TranspiledModuleSource {
  constructor(
    public code: string,
    public exportNames: string[],
    public collectCommonJsExportNames = false
  ) {}
}

function createResolutionContext(pnpmVirtualStore = true): ResolutionContext {
  return {
    pnpmVirtualStore,
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
  let stat: VfsStatResult = null;
  try {
    stat = await vfs.stat(path);
  } catch {
    stat = null;
  }
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
  let exists = false;
  try {
    exists = await vfs.fileExists(path);
  } catch {
    exists = false;
  }
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
  path = textModuleSourcePath(path);
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
  let entries: Awaited<ReturnType<Vfs["readDir"]>> | null = null;
  try {
    entries = await vfs.readDir(path);
  } catch {
    entries = null;
  }
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
        `${basePath}.vx`,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.jsx`,
        `${basePath}.mjs`,
        `${basePath}.cjs`,
        `${basePath}.json`,
        `${basePath}.txt`,
        basePath
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
    const candidates: string[] = [];
    if (exportsField) candidates.push(exportsField);
    if (moduleField) candidates.push(moduleField);
    if (mainField) candidates.push(mainField);
    for (const candidate of candidates) {
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
  if (!(await isDirectoryInVfs(storeDir, vfs, context))) {
    context.resolvedBareSpecifierInPnpmStoreByKey.set(cacheKey, null);
    return null;
  }
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
    if (context.pnpmVirtualStore) {
      const resolvedFromPnpmStore = await resolveBareSpecifierInPnpmVirtualStore(nodeModulesDir, specifier, vfs, virtualSources, context);
      if (resolvedFromPnpmStore) {
        context.resolvedBareSpecifierByKey.set(cacheKey, resolvedFromPnpmStore);
        return resolvedFromPnpmStore;
      }
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
  importMappings: ImportMappings,
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
  const textSourceSpecifier = textModuleSourceSpecifier(specifier);
  const resolutionSpecifier = textSourceSpecifier ?? specifier;
  const decorateResolvedPath = (filePath: string): string =>
    textSourceSpecifier === null ? filePath : asTextModulePath(filePath);

  const mappedTarget = importMappings[resolutionSpecifier] ?? importMappings[specifier];
  if (mappedTarget) {
    const targetPath = await resolveAsModulePath(mappedTarget, vfs, virtualSources, context);
    if (targetPath) {
      const resolved = { kind: "bundled", filePath: decorateResolvedPath(targetPath) } satisfies ResolvedDependency;
      context.resolvedDependencyByKey.set(cacheKey, resolved);
      return resolved;
    }
  }

  if (baseUrl && !isRelativeOrAbsoluteSpecifier(resolutionSpecifier)) {
    const targetPath = await resolveAsModulePath(resolve(baseUrl, resolutionSpecifier), vfs, virtualSources, context);
    if (targetPath) {
      const resolved = { kind: "bundled", filePath: decorateResolvedPath(targetPath) } satisfies ResolvedDependency;
      context.resolvedDependencyByKey.set(cacheKey, resolved);
      return resolved;
    }
  }

  if (isRelativeOrAbsoluteSpecifier(resolutionSpecifier)) {
    const targetPath = await resolveAsModulePath(
      resolutionSpecifier.startsWith("/")
        ? resolutionSpecifier
        : resolve(dirname(textModuleSourcePath(importerFilePath)), resolutionSpecifier),
      vfs,
      virtualSources,
      context
    );
    if (targetPath) {
      const resolved = { kind: "bundled", filePath: decorateResolvedPath(targetPath) } satisfies ResolvedDependency;
      context.resolvedDependencyByKey.set(cacheKey, resolved);
      return resolved;
    }
    const resolved = { kind: "external" } satisfies ResolvedDependency;
    context.resolvedDependencyByKey.set(cacheKey, resolved);
    return resolved;
  }

  const packagePath = await resolveBareSpecifier(
    textModuleSourcePath(importerFilePath),
    resolutionSpecifier,
    vfs,
    virtualSources,
    context
  );
  if (packagePath) {
    const resolved = { kind: "bundled", filePath: decorateResolvedPath(packagePath) } satisfies ResolvedDependency;
    context.resolvedDependencyByKey.set(cacheKey, resolved);
    return resolved;
  }
  const resolved = { kind: "external" } satisfies ResolvedDependency;
  context.resolvedDependencyByKey.set(cacheKey, resolved);
  return resolved;
}

export function detectStaticRequires(source: string): string[] {
  const specifiers = new Set<string>();
  for (const occurrence of collectStaticCallOccurrences(source, "require")) {
    specifiers.add(occurrence.specifier);
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
  return collectStaticCallOccurrences(source, "import");
}

function collectStaticCallOccurrences(
  source: string,
  calleeName: "require" | "import"
): StaticDynamicImportOccurrence[] {
  try {
    const tokens = tokenize(source, { language: "typescript" });
    const occurrences: StaticDynamicImportOccurrence[] = [];
    for (let index = 0; index <= tokens.length - 4; index += 1) {
      const importToken = tokens[index];
      const openParenToken = tokens[index + 1];
      const specifierToken = tokens[index + 2];
      const closeParenToken = tokens[index + 3];
      if (
        importToken?.type === TokenType.IDENTIFIER
        && importToken.value === calleeName
        && openParenToken?.type === TokenType.SYMBOL
        && openParenToken.value === "("
        && specifierToken?.type === TokenType.STRING
        && closeParenToken?.type === TokenType.SYMBOL
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
    return [];
  }
}

const MODULE_SYNTAX_SYMBOLS = new Set(["(", ")", "*", ",", ".", ";", "[", "]", "{", "}"]);

function tokenIs(token: Token | undefined, value: string): boolean {
  if (MODULE_SYNTAX_SYMBOLS.has(value)) {
    return token?.type === TokenType.SYMBOL && token.value === value;
  }
  return token?.value === value;
}

function findStatementEnd(tokens: readonly Token[], startIndex: number): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type === TokenType.END_OF_FILE) {
      return Math.max(startIndex, index - 1);
    }
    if (tokenIs(token, "(")) roundDepth += 1;
    else if (tokenIs(token, ")")) roundDepth -= 1;
    else if (tokenIs(token, "[")) squareDepth += 1;
    else if (tokenIs(token, "]")) squareDepth -= 1;
    else if (tokenIs(token, "{")) curlyDepth += 1;
    else if (tokenIs(token, "}")) curlyDepth -= 1;
    else if (tokenIs(token, ";") && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) return index;
  }
  return tokens.length - 1;
}

function findTokenValue(tokens: readonly Token[], value: string, startIndex: number, endIndex: number): number {
  let foundIndex = -1;
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (tokenIs(tokens[index], value)) {
      foundIndex = index;
      break;
    }
  }
  return foundIndex;
}

function findImportFromClause(tokens: readonly Token[], startIndex: number, endIndex: number): number {
  for (let index = endIndex - 1; index > startIndex; index -= 1) {
    if (tokenIs(tokens[index], "from") && tokens[index + 1]?.type === TokenType.STRING) {
      return index;
    }
  }
  return -1;
}

function moduleSpecifierBindings(
  tokens: readonly Token[],
  openBraceIndex: number,
  closeBraceIndex: number
): ModuleSpecifierBinding[] {
  const bindings: ModuleSpecifierBinding[] = [];
  let index = openBraceIndex + 1;
  while (index < closeBraceIndex) {
    const importedToken = tokens[index];
    if (!importedToken || tokenIs(importedToken, ",")) {
      index += 1;
      continue;
    }
    let local = importedToken.value;
    if (tokenIs(tokens[index + 1], "as") && tokens[index + 2]) {
      local = tokens[index + 2]!.value;
      index += 3;
    } else {
      index += 1;
    }
    bindings.push(new ModuleSpecifierBinding(importedToken.value, local));
  }
  return bindings;
}

function requireExpression(specifier: string): string {
  return `require(${JSON.stringify(specifier)})`;
}

function transformStaticImport(
  tokens: readonly Token[],
  startIndex: number,
  temporaryIndex: number
): ModuleTransformResult | null {
  if (tokenIs(tokens[startIndex + 1], "(") || tokenIs(tokens[startIndex + 1], ".")) {
    return null;
  }
  const endIndex = findStatementEnd(tokens, startIndex);
  const importToken = tokens[startIndex]!;
  const endToken = tokens[endIndex]!;
  if (tokens[startIndex + 1]?.type === TokenType.STRING) {
    const specifier = tokens[startIndex + 1]!.value;
    return new ModuleTransformResult(
      new SourceReplacement(
        importToken.range.start.offset,
        endToken.range.end.offset,
        `${requireExpression(specifier)};`
      ),
      endIndex
    );
  }

  const fromIndex = findImportFromClause(tokens, startIndex, endIndex);
  const sourceToken = tokens[fromIndex + 1];
  if (fromIndex < 0 || sourceToken?.type !== TokenType.STRING) {
    return null;
  }
  const specifier = sourceToken.value;
  const declarations: string[] = [];
  const firstClauseToken = tokens[startIndex + 1];
  const commaIndex = findTokenValue(tokens, ",", startIndex + 1, fromIndex - 1);
  let importTemporaryName: string | null = null;
  if (
    firstClauseToken?.type === TokenType.IDENTIFIER
    && !tokenIs(firstClauseToken, "{")
    && !tokenIs(firstClauseToken, "*")
  ) {
    importTemporaryName = `__vexa_import_${temporaryIndex}`;
    declarations.push(`const ${importTemporaryName} = ${requireExpression(specifier)};`);
    declarations.push(
      `const ${firstClauseToken.value} = ${importTemporaryName} && ${importTemporaryName}.__esModule`
      + ` ? ${importTemporaryName}.default : ${importTemporaryName};`
    );
  }
  const openBraceIndex = findTokenValue(tokens, "{", startIndex + 1, fromIndex - 1);
  if (openBraceIndex >= 0) {
    const closeBraceIndex = findTokenValue(tokens, "}", openBraceIndex + 1, fromIndex - 1);
    if (closeBraceIndex < 0) {
      return null;
    }
    const bindings = moduleSpecifierBindings(tokens, openBraceIndex, closeBraceIndex);
    const properties: string[] = [];
    for (const binding of bindings) {
      properties.push(
        binding.imported === binding.local
          ? binding.imported
          : `${binding.imported}: ${binding.local}`
      );
    }
    declarations.push(
      `const { ${properties.join(", ")} } = ${importTemporaryName ?? requireExpression(specifier)};`
    );
  } else {
    const starIndex = findTokenValue(tokens, "*", startIndex + 1, fromIndex - 1);
    if (starIndex >= 0 && tokenIs(tokens[starIndex + 1], "as") && tokens[starIndex + 2]) {
      declarations.push(`const ${tokens[starIndex + 2]!.value} = ${requireExpression(specifier)};`);
    } else if (commaIndex >= 0) {
      return null;
    }
  }
  return new ModuleTransformResult(
    new SourceReplacement(
      importToken.range.start.offset,
      endToken.range.end.offset,
      declarations.join("\n")
    ),
    endIndex
  );
}

function declarationExportNames(tokens: readonly Token[], declarationIndex: number): string[] {
  const declarationKindIndex = tokenIs(tokens[declarationIndex], "async")
    ? declarationIndex + 1
    : declarationIndex;
  const declarationKind = tokens[declarationKindIndex]?.value;
  if (declarationKind === "function" || declarationKind === "class") {
    const generatorOffset = declarationKind === "function" && tokenIs(tokens[declarationKindIndex + 1], "*")
      ? 1
      : 0;
    const nameToken = tokens[declarationKindIndex + 1 + generatorOffset];
    return nameToken?.type === TokenType.IDENTIFIER ? [nameToken.value] : [];
  }
  if (declarationKind !== "const" && declarationKind !== "let" && declarationKind !== "var") {
    return [];
  }
  const endIndex = findStatementEnd(tokens, declarationIndex);
  const names: string[] = [];
  let expectName = true;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = declarationIndex + 1; index < endIndex; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (tokenIs(token, "(")) roundDepth += 1;
    else if (tokenIs(token, ")")) roundDepth -= 1;
    else if (tokenIs(token, "[")) squareDepth += 1;
    else if (tokenIs(token, "]")) squareDepth -= 1;
    else if (tokenIs(token, "{")) curlyDepth += 1;
    else if (tokenIs(token, "}")) curlyDepth -= 1;
    if (expectName && token.type === TokenType.IDENTIFIER && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      names.push(token.value);
      expectName = false;
    } else if (tokenIs(token, ",") && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      expectName = true;
    }
  }
  return names;
}

function exportedFunctionDeclarationName(
  tokens: readonly Token[],
  declarationIndex: number
): string | null {
  const functionIndex = tokenIs(tokens[declarationIndex], "async")
    ? declarationIndex + 1
    : declarationIndex;
  if (!tokenIs(tokens[functionIndex], "function")) {
    return null;
  }
  const generatorOffset = tokenIs(tokens[functionIndex + 1], "*") ? 1 : 0;
  const nameToken = tokens[functionIndex + 1 + generatorOffset];
  return nameToken?.type === TokenType.IDENTIFIER ? nameToken.value : null;
}

function transformNamedExport(
  tokens: readonly Token[],
  startIndex: number,
  temporaryIndex: number
): ModuleTransformResult | null {
  const openBraceIndex = startIndex + 1;
  const endIndex = findStatementEnd(tokens, startIndex);
  const closeBraceIndex = findTokenValue(tokens, "}", openBraceIndex + 1, endIndex);
  if (closeBraceIndex < 0) {
    return null;
  }
  const bindings = moduleSpecifierBindings(tokens, openBraceIndex, closeBraceIndex);
  const fromIndex = findTokenValue(tokens, "from", closeBraceIndex + 1, endIndex);
  let text: string;
  if (fromIndex >= 0) {
    const specifierToken = tokens[fromIndex + 1];
    if (specifierToken?.type !== TokenType.STRING) {
      return null;
    }
    const temporaryName = `__vexa_reexport_${temporaryIndex}`;
    const statements = [`const ${temporaryName} = ${requireExpression(specifierToken.value)};`];
    for (const binding of bindings) {
      statements.push(`exports.${binding.local} = ${temporaryName}.${binding.imported};`);
    }
    text = statements.join("\n");
  } else {
    const statements: string[] = [];
    for (const binding of bindings) {
      statements.push(`exports.${binding.local} = ${binding.imported};`);
    }
    text = statements.join("\n");
  }
  const exportNames: string[] = [];
  for (const binding of bindings) {
    exportNames.push(binding.local);
  }
  return new ModuleTransformResult(
    new SourceReplacement(
      tokens[startIndex]!.range.start.offset,
      tokens[endIndex]!.range.end.offset,
      text
    ),
    endIndex,
    exportNames
  );
}

function transformJavaScriptModuleSource(source: string): TranspiledModuleSource {
  const tokens = tokenize(source, { language: "typescript" });
  const replacements: SourceReplacement[] = [];
  const trailingExports: ModuleSpecifierBinding[] = [];
  const hoistedExports: ModuleSpecifierBinding[] = [];
  const exportNames = new Set<string>();
  let temporaryIndex = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.type !== TokenType.IDENTIFIER) {
      continue;
    }
    if (token.value === "import") {
      const transformed = transformStaticImport(tokens, index, temporaryIndex);
      if (transformed) {
        temporaryIndex += 1;
        replacements.push(transformed.replacement);
        index = transformed.endIndex;
      }
      continue;
    }
    if (token.value !== "export") {
      continue;
    }

    const nextToken = tokens[index + 1];
    if (tokenIs(nextToken, "{")) {
      const transformed = transformNamedExport(tokens, index, temporaryIndex);
      if (transformed) {
        temporaryIndex += 1;
        replacements.push(transformed.replacement);
        for (const name of transformed.exportNames) exportNames.add(name);
        index = transformed.endIndex;
      }
      continue;
    }
    if (tokenIs(nextToken, "*")) {
      const endIndex = findStatementEnd(tokens, index);
      const fromIndex = findTokenValue(tokens, "from", index + 1, endIndex);
      const specifierToken = fromIndex >= 0 ? tokens[fromIndex + 1] : undefined;
      if (specifierToken?.type !== TokenType.STRING) {
        continue;
      }
      let text = `Object.assign(exports, ${requireExpression(specifierToken.value)});`;
      if (tokenIs(tokens[index + 2], "as") && tokens[index + 3]) {
        const name = tokens[index + 3]!.value;
        text = `exports.${name} = ${requireExpression(specifierToken.value)};`;
        exportNames.add(name);
      }
      replacements.push(new SourceReplacement(
        token.range.start.offset,
        tokens[endIndex]!.range.end.offset,
        text
      ));
      index = endIndex;
      continue;
    }
    if (tokenIs(nextToken, "default")) {
      const declarationToken = tokens[index + 2];
      if (
        (tokenIs(declarationToken, "function") || tokenIs(declarationToken, "class"))
        && tokens[index + 3]?.type === TokenType.IDENTIFIER
        && !tokenIs(tokens[index + 3], "extends")
      ) {
        const name = tokens[index + 3]!.value;
        replacements.push(new SourceReplacement(
          token.range.start.offset,
          nextToken!.range.end.offset,
          ""
        ));
        trailingExports.push(new ModuleSpecifierBinding(name, "default"));
        const functionName = exportedFunctionDeclarationName(tokens, index + 2);
        if (functionName) {
          hoistedExports.push(new ModuleSpecifierBinding(functionName, "default"));
        }
      } else {
        replacements.push(new SourceReplacement(
          token.range.start.offset,
          nextToken!.range.end.offset,
          "exports.default ="
        ));
      }
      exportNames.add("default");
      continue;
    }

    const names = declarationExportNames(tokens, index + 1);
    if (names.length > 0) {
      replacements.push(new SourceReplacement(
        token.range.start.offset,
        token.range.end.offset,
        ""
      ));
      for (const name of names) {
        trailingExports.push(new ModuleSpecifierBinding(name, name));
        exportNames.add(name);
      }
      const functionName = exportedFunctionDeclarationName(tokens, index + 1);
      if (functionName) {
        hoistedExports.push(new ModuleSpecifierBinding(functionName, functionName));
      }
    }
  }

  replacements.sort((left, right) => left.startOffset - right.startOffset);
  let code = "";
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.startOffset < cursor) {
      continue;
    }
    code += source.slice(cursor, replacement.startOffset);
    code += replacement.text;
    cursor = replacement.endOffset;
  }
  code += source.slice(cursor);
  const hoistedExportStatements: string[] = [];
  if (exportNames.size > 0) {
    hoistedExportStatements.push("exports.__esModule = true;");
  }
  for (const binding of hoistedExports) {
    hoistedExportStatements.push(`exports.${binding.local} = ${binding.imported};`);
  }
  if (hoistedExportStatements.length > 0) {
    code = `${hoistedExportStatements.join("\n")}\n${code}`;
  }
  for (const binding of trailingExports) {
    code += `\nexports.${binding.local} = ${binding.imported};`;
  }
  return new TranspiledModuleSource(code, setValues(exportNames));
}

function collectExportedDeclarationNames(statement: Statement): string[] {
  if (statement instanceof VarStatement) {
    const variable = statement as VarStatement;
    const names: string[] = [];
    if (variable.declarations) {
      for (const declaration of variable.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          names.push(identifier.name);
        }
      }
    } else {
      for (const identifier of bindingIdentifiers(variable.name)) {
        names.push(identifier.name);
      }
    }
    return names;
  }
  if (statement instanceof FunctionStatement) return [statement.name.name];
  if (statement instanceof ClassStatement) return [statement.name.name];
  if (statement instanceof EnumStatement) return [statement.name.name];
  return [];
}

function collectExplicitExportNames(program: Program): string[] {
  const exportNames = new Set<string>();
  for (const statement of program.body) {
    if (!(statement instanceof ExportStatement)) {
      continue;
    }
    const exportStatement = statement as ExportStatement;
    if (exportStatement.typeOnly) {
      continue;
    }
    if (exportStatement.isDefault) {
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

export function transpileModuleSource(source: string, filePath: string): TranspiledModuleSource {
  if (shouldPreserveCommonJsSource(source, filePath)) {
    return new TranspiledModuleSource(source, [], true);
  }
  const extension = extname(filePath).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return transformJavaScriptModuleSource(source);
  }
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
  return new TranspiledModuleSource(
    emitProgram(
      parsed.ast,
      new Map(),
      new Set(),
      new Set(),
      {
        moduleFormat: "commonjs",
        sourceLanguage: "typescript"
      },
      new Set()
    ),
    collectExplicitExportNames(parsed.ast)
  );
}

function commonAncestorDirectory(paths: readonly string[]): string {
  if (paths.length === 0) {
    return ".";
  }
  const segments = paths.map((path) => resolve(path).split("/").filter((segment) => segment.length > 0));
  const shared: string[] = [];
  let minLength = segments[0]?.length ?? 0;
  for (const parts of segments) {
    minLength = Math.min(minLength, parts.length);
  }
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
  let cursor = 0;
  while (cursor < code.length) {
    const marker = code.indexOf("exports.", cursor);
    if (marker < 0) {
      break;
    }
    let end = marker + "exports.".length;
    while (end < code.length && /[A-Za-z0-9_$]/.test(code[end]!)) {
      end += 1;
    }
    const exportName = code.slice(marker + "exports.".length, end);
    if (exportName.length > 0 && exportName !== "__esModule") {
      exports.add(exportName);
    }
    cursor = end;
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
  importMappings: ImportMappings,
  baseUrl: string | undefined,
  context: ResolutionContext
): Promise<CachedBundledModuleArtifact> {
  const sourcePath = textModuleSourcePath(filePath);
  const extension = extname(sourcePath).toLowerCase();
  const mtimePromise = virtualSources.has(filePath) || virtualSources.has(sourcePath)
    ? Promise.resolve(-1)
    : fileMtimeInVfs(sourcePath, vfs, context).then((mtimeMs) => mtimeMs ?? -1);
  let source = virtualSources.get(filePath) ?? virtualSources.get(sourcePath);
  if (source === undefined) {
    source = await vfs.readFile(sourcePath) ?? undefined;
  }
  if (source === undefined) {
    throw new Error(`Unable to read bundled module '${filePath}'`);
  }
  let transpiled: TranspiledModuleSource;
  try {
    transpiled = extension === ".json"
      ? new TranspiledModuleSource(`module.exports = ${source.trim()};`, ["default"])
      : extension === ".txt" || isTextModulePath(filePath)
        ? new TranspiledModuleSource(`module.exports = ${JSON.stringify(source)};`, ["default"])
        : transpileModuleSource(source, filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to transform bundled module '${filePath}': ${detail}`);
  }
  const transpiledCode = rewriteStaticDynamicImports(transpiled.code);
  const resolvedDependencies: Record<string, string | null> = {};
  const specifiers = [...detectStaticRequires(transpiledCode), ...detectStaticDynamicImports(transpiled.code)];
  const resolutions = await Promise.all(specifiers.map(async (specifier) => {
    try {
      return await resolveDependency(filePath, specifier, vfs, virtualSources, importMappings, baseUrl, context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to resolve '${specifier}' imported by '${filePath}': ${detail}`);
    }
  }));
  for (let index = 0; index < specifiers.length; index += 1) {
    const specifier = specifiers[index]!;
    const resolved = resolutions[index]!;
    resolvedDependencies[specifier] = resolved.kind === "bundled" ? resolved.filePath : null;
  }
  return {
    mtimeMs: await mtimePromise,
    code: transpiledCode,
    resolvedDependencies
  };
}

async function loadBundledModuleArtifact(
  filePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>,
  importMappings: ImportMappings,
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

interface BundleTraversalContext {
  activeVfs: Vfs;
  virtualSources: ReadonlyMap<string, string>;
  importMappings: ImportMappings;
  baseUrl: string | undefined;
  resolutionContext: ResolutionContext;
  moduleById: Map<string, BundledModuleRecord>;
  moduleIdByPath: Map<string, string>;
  watchedFiles: Set<string>;
  nextModuleIndex: number;
  discoveredByIdentity: Map<string, DiscoveredModuleRecord>;
}

interface DiscoveredModuleDependency {
  specifier: string;
  module: DiscoveredModuleRecord | null;
}

interface DiscoveredModuleRecord {
  filePath: string;
  physicalIdentityKey?: string;
  artifact: CachedBundledModuleArtifact | null;
  dependencies: DiscoveredModuleDependency[];
}

async function discoverResolvedFile(
  filePath: string,
  traversal: BundleTraversalContext
): Promise<DiscoveredModuleRecord> {
  let physicalIdentityKey: string | undefined;
  if (!traversal.virtualSources.has(filePath)) {
    const textModule = isTextModulePath(filePath);
    const sourcePath = textModuleSourcePath(filePath);
    try {
      const canonicalSourcePath = await traversal.activeVfs.realPath(sourcePath);
      const canonicalPath = textModule ? asTextModulePath(canonicalSourcePath) : canonicalSourcePath;
      physicalIdentityKey = `\0real:${canonicalPath}`;
    } catch {
      // Virtual and non-filesystem VFS implementations may not expose a
      // canonical path. Their stable logical path remains the module identity.
    }
  }
  const identityKey = physicalIdentityKey ?? filePath;
  const existing = traversal.discoveredByIdentity.get(identityKey);
  if (existing) {
    return existing;
  }

  const discovered: DiscoveredModuleRecord = {
    filePath,
    ...(physicalIdentityKey ? { physicalIdentityKey } : {}),
    artifact: null,
    dependencies: []
  };
  traversal.discoveredByIdentity.set(identityKey, discovered);
  if (!traversal.virtualSources.has(filePath)) {
    traversal.watchedFiles.add(filePath);
  }
  const artifact = await loadBundledModuleArtifact(
    filePath,
    traversal.activeVfs,
    traversal.virtualSources,
    traversal.importMappings,
    traversal.baseUrl,
    traversal.resolutionContext
  );
  discovered.artifact = artifact;
  let resolvedDependencyEntries: [string, string | null][];
  try {
    resolvedDependencyEntries = Object.entries(artifact.resolvedDependencies);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to enumerate dependencies for '${filePath}': ${detail}`);
  }
  discovered.dependencies = await Promise.all(resolvedDependencyEntries.map(async ([specifier, resolvedFilePath]) => {
    if (resolvedFilePath === null) return { specifier, module: null };
    try {
      return { specifier, module: await discoverResolvedFile(resolvedFilePath, traversal) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to bundle '${specifier}' imported by '${filePath}': ${detail}`);
    }
  }));
  return discovered;
}

function emitDiscoveredFile(
  discovered: DiscoveredModuleRecord,
  traversal: BundleTraversalContext
): string {
  const existing = traversal.moduleIdByPath.get(discovered.filePath)
    ?? (discovered.physicalIdentityKey
      ? traversal.moduleIdByPath.get(discovered.physicalIdentityKey)
      : undefined);
  if (existing) return existing;

  const moduleId = `__vexa_module_${traversal.nextModuleIndex}`;
  traversal.nextModuleIndex += 1;
  traversal.moduleIdByPath.set(discovered.filePath, moduleId);
  if (discovered.physicalIdentityKey) {
    traversal.moduleIdByPath.set(discovered.physicalIdentityKey, moduleId);
  }
  const dependencyMap: Record<string, string | null> = {};
  for (const dependency of discovered.dependencies) {
    dependencyMap[dependency.specifier] = dependency.module
      ? emitDiscoveredFile(dependency.module, traversal)
      : null;
  }
  const artifact = discovered.artifact;
  if (!artifact) throw new Error(`Unable to load discovered bundled module '${discovered.filePath}'`);
  traversal.moduleById.set(moduleId, {
    id: moduleId,
    filePath: discovered.filePath,
    code: artifact.code,
    dependencyMap
  });
  return moduleId;
}

function setValues(values: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const value of values) {
    result.push(value);
  }
  return result;
}

function bundledModuleRecords(
  moduleById: ReadonlyMap<string, BundledModuleRecord>
): BundledModuleRecord[] {
  const records: BundledModuleRecord[] = [];
  for (const [, record] of moduleById) {
    records.push(record);
  }
  return records;
}

export async function bundleNodeModuleGraph(
  entrySource: string,
  sourcePath: string,
  options: BundleNodeModulesOptions = {},
  pnpmVirtualStore = options.pnpmVirtualStore !== false
): Promise<BundleNodeModulesResult> {
  const activeVfs = options.vfs ?? vfs();
  const virtualSources = options.virtualSources ?? new Map<string, string>();
  const importMappings = options.importMappings ?? {};
  const baseUrl = options.baseUrl;
  const resolutionContext = createResolutionContext(pnpmVirtualStore);
  const externalDependencyStrategy = options.externalDependencyStrategy ?? "runtime-error";
  const entryId = "__vexa_entry__";
  const entryTranspiled = virtualSources.has(sourcePath)
    ? new TranspiledModuleSource(entrySource, [], true)
    : transpileModuleSource(entrySource, sourcePath);
  const entryCode = rewriteStaticDynamicImports(entryTranspiled.code);
  const entrySpecifiers = [
    ...detectStaticRequires(entryCode),
    ...detectStaticDynamicImports(entryTranspiled.code)
  ];
  const dependencySources = options.incrementalCache
    ? dependencyVirtualSources(virtualSources, sourcePath)
    : new Map<string, string>();
  const configurationKey = JSON.stringify([
    baseUrl ?? "",
    externalDependencyStrategy,
    importMappings
  ]);
  const cachedState = options.incrementalCache
    ? incrementalBundleStates.get(options.incrementalCache)
    : undefined;
  const dependencyChanged = (options.changedFiles ?? []).some((filePath) => filePath !== sourcePath);
  const canReuseDependencies = cachedState !== undefined &&
    !dependencyChanged &&
    cachedState.sourcePath === sourcePath &&
    cachedState.configurationKey === configurationKey &&
    sameStringArray(cachedState.entrySpecifiers, entrySpecifiers) &&
    sameVirtualSources(cachedState.virtualSources, dependencySources);
  const reusableState = canReuseDependencies ? cachedState : undefined;
  const moduleById = reusableState
    ? new Map(reusableState.moduleById)
    : new Map<string, BundledModuleRecord>();
  const moduleIdByPath = reusableState
    ? new Map(reusableState.moduleIdByPath)
    : new Map<string, string>();
  const watchedFiles = new Set<string>(reusableState ? reusableState.watchedFiles : [sourcePath]);
  const entryDependencyMap: Record<string, string | null> = reusableState
    ? { ...reusableState.entryDependencyMap }
    : {};
  const traversal: BundleTraversalContext = {
    activeVfs,
    virtualSources,
    importMappings,
    baseUrl,
    resolutionContext,
    moduleById,
    moduleIdByPath,
    watchedFiles,
    nextModuleIndex: reusableState?.nextModuleIndex ?? 0,
    discoveredByIdentity: new Map()
  };

  if (!canReuseDependencies) {
    const entryResolutions = await Promise.all(entrySpecifiers.map(async (specifier) => {
      try {
        return await resolveDependency(
          sourcePath,
          specifier,
          activeVfs,
          virtualSources,
          importMappings,
          baseUrl,
          resolutionContext
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to resolve bundled dependency '${specifier}': ${detail}`);
      }
    }));
    const discoveredEntries = await Promise.all(entryResolutions.map(async (resolved, index) => {
      if (resolved.kind === "external") return null;
      const specifier = entrySpecifiers[index]!;
      try {
        return await discoverResolvedFile(resolved.filePath, traversal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to bundle resolved dependency '${specifier}' from '${resolved.filePath}': ${detail}`
        );
      }
    }));
    for (let index = 0; index < entrySpecifiers.length; index += 1) {
      const specifier = entrySpecifiers[index]!;
      const discovered = discoveredEntries[index];
      if (discovered) {
        try {
          entryDependencyMap[specifier] = emitDiscoveredFile(discovered, traversal);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Unable to emit bundled dependency '${specifier}': ${detail}`
          );
        }
      } else {
        entryDependencyMap[specifier] = null;
      }
    }
  }

  const bundledPaths: string[] = [];
  const moduleRecords = bundledModuleRecords(moduleById);
  for (const record of moduleRecords) {
    bundledPaths.push(record.filePath);
  }
  bundledPaths.push(sourcePath);
  const bundleRootDir = reusableState?.bundleRootDir
    ?? commonAncestorDirectory(bundledPaths);
  const entryExports = entryTranspiled.collectCommonJsExportNames
    ? collectCommonJsExports(entryCode)
    : entryTranspiled.exportNames;
  const dependencyMapChunks: string[] = [];
  const moduleFactoryChunks: string[] = [];
  for (const record of moduleRecords) {
    dependencyMapChunks.push(`${JSON.stringify(record.id)}: ${JSON.stringify(record.dependencyMap)}`);
    moduleFactoryChunks.push(
      createModuleFactoryCode(
        record.id,
        minimalBundlePath(bundleRootDir, record.filePath),
        record.code
      )
    );
  }
  const cachedDependencyMapsLiteral = reusableState?.dependencyMapsLiteral
    ?? dependencyMapChunks.join(",\n");
  const cachedModuleFactoriesLiteral = reusableState?.moduleFactoriesLiteral
    ?? moduleFactoryChunks.join(",\n");
  const dependencyMapsLiteral = [
    cachedDependencyMapsLiteral,
    `${JSON.stringify(entryId)}: ${JSON.stringify(entryDependencyMap)}`
  ].filter((chunk) => chunk.length > 0).join(",\n");
  const moduleFactoriesLiteral = [
    cachedModuleFactoriesLiteral,
    createModuleFactoryCode(entryId, minimalBundlePath(bundleRootDir, sourcePath), entryCode)
  ].filter((chunk) => chunk.length > 0).join(",\n");

  if (!canReuseDependencies && options.incrementalCache) {
    incrementalBundleStates.set(options.incrementalCache, {
      sourcePath,
      configurationKey,
      entrySpecifiers: [...entrySpecifiers],
      virtualSources: dependencySources,
      moduleById: new Map(moduleById),
      moduleIdByPath: new Map(moduleIdByPath),
      watchedFiles: setValues(watchedFiles),
      entryDependencyMap: { ...entryDependencyMap },
      bundleRootDir,
      dependencyMapsLiteral: cachedDependencyMapsLiteral,
      moduleFactoriesLiteral: cachedModuleFactoriesLiteral,
      nextModuleIndex: traversal.nextModuleIndex,
    });
  }

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
    watchedFiles: setValues(watchedFiles)
  };
}
