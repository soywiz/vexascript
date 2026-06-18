import { builtinModules } from "node:module";
import type { Program, Statement, VarStatement, FunctionStatement, ClassStatement, EnumStatement, ExportStatement } from "../compiler/ast/ast";
import { parseSource } from "../compiler/pipeline/parse";
import { emitProgram } from "../compiler/runtime/emitter";
import { basename, dirname, extname, relative, resolve } from "../compiler/utils/path";
import { vfs, type Vfs } from "../compiler/vfs";

interface BundleNodeModulesOptions {
  vfs?: Vfs;
  virtualSources?: ReadonlyMap<string, string>;
  externalDependencyStrategy?: "runtime-error" | "node-require";
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

type ResolvedDependency =
  | { kind: "bundled"; filePath: string }
  | { kind: "external" };

const NODE_BUILTIN_SET = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => specifier.startsWith("node:") ? specifier : `node:${specifier}`)
]);

const STATIC_REQUIRE_PATTERN = /\brequire\s*\(\s*(['"])([^"'`]+)\1\s*\)/g;
const STATIC_DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(['"])([^"'`]+)\1\s*\)/g;
const bundledModuleArtifactCache = new Map<string, CachedBundledModuleArtifact>();

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

async function readPackageJson(packageDir: string, vfs: Vfs): Promise<Record<string, unknown> | null> {
  const packageJsonPath = resolve(packageDir, "package.json");
  if (!(await fileExistsInVfs(packageJsonPath, vfs))) {
    return null;
  }
  try {
    const source = await vfs.readFile(packageJsonPath);
    if (source === null) {
      return null;
    }
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function fileExistsInVfs(path: string, vfs: Vfs): Promise<boolean> {
  return vfs.fileExists(path);
}

async function isDirectoryInVfs(path: string, vfs: Vfs): Promise<boolean> {
  try {
    const stat = await vfs.stat(path);
    return stat?.isDirectory === true;
  } catch {
    return false;
  }
}

async function fileMtimeInVfs(path: string, vfs: Vfs): Promise<number | null> {
  try {
    return (await vfs.stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function resolvePathWithExtensions(
  basePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>
): Promise<string | null> {
  const candidates = extname(basePath)
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
      return candidate;
    }
    if ((await fileExistsInVfs(candidate, vfs)) && !(await isDirectoryInVfs(candidate, vfs))) {
      return candidate;
    }
  }
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
  virtualSources: ReadonlyMap<string, string>
): Promise<string | null> {
  const packageJson = await readPackageJson(directoryPath, vfs);
  if (packageJson) {
    const exportsField = packageExportTarget(packageJson["exports"]);
    const moduleField = typeof packageJson["module"] === "string" ? packageJson["module"] : null;
    const mainField = typeof packageJson["main"] === "string" ? packageJson["main"] : null;
    for (const candidate of [exportsField, moduleField, mainField]) {
      if (!candidate) {
        continue;
      }
      const resolvedEntry = await resolveAsModulePath(resolve(directoryPath, candidate), vfs, virtualSources);
      if (resolvedEntry) {
        return resolvedEntry;
      }
    }
  }
  for (const indexName of ["index.js", "index.mjs", "index.cjs", "index.json", "index.ts", "index.tsx"]) {
    const candidate = resolve(directoryPath, indexName);
    if (virtualSources.has(candidate)) {
      return candidate;
    }
    if (await fileExistsInVfs(candidate, vfs)) {
      return candidate;
    }
  }
  return null;
}

async function resolveAsModulePath(
  candidatePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>
): Promise<string | null> {
  const direct = await resolvePathWithExtensions(candidatePath, vfs, virtualSources);
  if (direct) {
    return direct;
  }
  if (await isDirectoryInVfs(candidatePath, vfs)) {
    return resolveDirectoryModule(candidatePath, vfs, virtualSources);
  }
  return null;
}

async function resolveBareSpecifierInPnpmVirtualStore(
  nodeModulesDir: string,
  specifier: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>
): Promise<string | null> {
  const storeDir = resolve(nodeModulesDir, ".pnpm");
  let entries;
  try {
    entries = await vfs.readDir(storeDir);
  } catch {
    return null;
  }

  const { packageName, subpath } = splitPackageSpecifier(specifier);
  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    const packageDir = resolve(storeDir, entry.name, "node_modules", packageName);
    if (!(await isDirectoryInVfs(packageDir, vfs))) {
      continue;
    }

    const packageJson = await readPackageJson(packageDir, vfs);
    const exportsValue = packageJson?.["exports"];
    if (subpath && exportsValue && typeof exportsValue === "object" && !Array.isArray(exportsValue)) {
      const exportsField = exportsValue as Record<string, unknown>;
      const exportKey = `./${subpath}`;
      const exportTarget = packageExportTarget(exportsField[exportKey]);
      if (exportTarget) {
        const resolvedExport = await resolveAsModulePath(resolve(packageDir, exportTarget), vfs, virtualSources);
        if (resolvedExport) {
          return resolvedExport;
        }
      }
    }

    const rootTarget = subpath ? resolve(packageDir, subpath) : packageDir;
    const resolved = await resolveAsModulePath(rootTarget, vfs, virtualSources);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolveBareSpecifier(
  importerFilePath: string,
  specifier: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>
): Promise<string | null> {
  const { packageName, subpath } = splitPackageSpecifier(specifier);
  let currentDir = dirname(importerFilePath);
  while (true) {
    const packageDir = resolve(currentDir, "node_modules", packageName);
    if (await isDirectoryInVfs(packageDir, vfs)) {
      const packageJson = await readPackageJson(packageDir, vfs);
      const exportsValue = packageJson?.["exports"];
      if (subpath && exportsValue && typeof exportsValue === "object" && !Array.isArray(exportsValue)) {
        const exportsField = exportsValue as Record<string, unknown>;
        const exportKey = `./${subpath}`;
        const exportTarget = packageExportTarget(exportsField[exportKey]);
        if (exportTarget) {
          const resolvedExport = await resolveAsModulePath(resolve(packageDir, exportTarget), vfs, virtualSources);
          if (resolvedExport) {
            return resolvedExport;
          }
        }
      }

      const rootTarget = subpath ? resolve(packageDir, subpath) : packageDir;
      const resolved = await resolveAsModulePath(rootTarget, vfs, virtualSources);
      if (resolved) {
        return resolved;
      }
    }

    const nodeModulesDir = resolve(currentDir, "node_modules");
    const resolvedFromPnpmStore = await resolveBareSpecifierInPnpmVirtualStore(nodeModulesDir, specifier, vfs, virtualSources);
    if (resolvedFromPnpmStore) {
      return resolvedFromPnpmStore;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return null;
}

async function resolveDependency(
  importerFilePath: string,
  specifier: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>
): Promise<ResolvedDependency> {
  if (isBuiltinSpecifier(specifier)) {
    return { kind: "external" };
  }

  if (isRelativeOrAbsoluteSpecifier(specifier)) {
    const targetPath = await resolveAsModulePath(
      specifier.startsWith("/") ? specifier : resolve(dirname(importerFilePath), specifier),
      vfs,
      virtualSources
    );
    if (targetPath) {
      return { kind: "bundled", filePath: targetPath };
    }
    return { kind: "external" };
  }

  const packagePath = await resolveBareSpecifier(importerFilePath, specifier, vfs, virtualSources);
  if (packagePath) {
    return { kind: "bundled", filePath: packagePath };
  }
  return { kind: "external" };
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
  for (const match of source.matchAll(STATIC_DYNAMIC_IMPORT_PATTERN)) {
    const specifier = match[2];
    if (specifier) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

export function rewriteStaticDynamicImports(source: string): string {
  return source.replace(
    STATIC_DYNAMIC_IMPORT_PATTERN,
    (_match, _quote, specifier) => `__vexaImport(${JSON.stringify(specifier)})`
  );
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

function transformImportClauseToCommonJs(clause: string, specifier: string, tempName: string): string {
  const trimmed = clause.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const bindings = trimmed.slice(1, -1).trim();
    const commonJsBindings = bindings.replace(/\bas\b/g, ":");
    return `const { ${commonJsBindings} } = require(${JSON.stringify(specifier)});`;
  }
  if (trimmed.startsWith("* as ")) {
    return `const ${trimmed.slice(5).trim()} = require(${JSON.stringify(specifier)});`;
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex >= 0) {
    const defaultImport = trimmed.slice(0, commaIndex).trim();
    const rest = trimmed.slice(commaIndex + 1).trim();
    const lines = [
      `const ${tempName} = require(${JSON.stringify(specifier)});`,
      `const ${defaultImport} = ${tempName} && ${tempName}.__esModule ? ${tempName}.default : ${tempName};`
    ];
    if (rest.startsWith("{") && rest.endsWith("}")) {
      const bindings = rest.slice(1, -1).trim().replace(/\bas\b/g, ":");
      lines.push(`const { ${bindings} } = ${tempName};`);
    } else if (rest.startsWith("* as ")) {
      lines.push(`const ${rest.slice(5).trim()} = ${tempName};`);
    }
    return lines.join("\n");
  }
  return [
    `const ${tempName} = require(${JSON.stringify(specifier)});`,
    `const ${trimmed} = ${tempName} && ${tempName}.__esModule ? ${tempName}.default : ${tempName};`
  ].join("\n");
}

function transformJavaScriptModuleSource(source: string): string {
  let tempIndex = 0;
  let usesEsmExports = false;
  const appendedExports: string[] = [];
  let transformed = source;

  transformed = transformed.replace(/(^|[\n;])\s*import\s+(['"])([^"'`]+)\2\s*;?/g, (_match, prefix, _quote, specifier) => {
    return `${prefix}require(${JSON.stringify(specifier)});`;
  });

  transformed = transformed.replace(/(^|[\n;])\s*import\s*([^;'"]+?)\s*from\s*(['"])([^"'`]+)\3\s*;?/g, (_match, prefix, clause, _quote, specifier) => {
    const tempName = `__vexa_import_${tempIndex++}`;
    return `${prefix}${transformImportClauseToCommonJs(clause, specifier, tempName)}`;
  });

  transformed = transformed.replace(/export\s+default\s+([^;]+);?/g, (_match, expression) => {
    usesEsmExports = true;
    return `exports.default = ${expression};`;
  });

  transformed = transformed.replace(/export\s*\{([^}]+)\}(?:\s+from\s+(['"])([^"'`]+)\2)?\s*;?/g, (_match, specifiersText, _quote, fromSpecifier) => {
    usesEsmExports = true;
    const specifiers = specifiersText
      .split(",")
      .map((part: string) => part.trim())
      .filter((part: string) => part.length > 0);
    if (fromSpecifier) {
      const tempName = `__vexa_export_${tempIndex++}`;
      const lines = [`const ${tempName} = require(${JSON.stringify(fromSpecifier)});`];
      for (const specifier of specifiers) {
        const aliasParts = specifier.split(/\s+as\s+/);
        const localName = aliasParts[0]!.trim();
        const exportedName = (aliasParts[1] ?? aliasParts[0])!.trim();
        lines.push(`exports.${exportedName} = ${tempName}.${localName};`);
      }
      return lines.join("\n");
    }
    return specifiers.map((specifier: string) => {
      const aliasParts = specifier.split(/\s+as\s+/);
      const localName = aliasParts[0]!.trim();
      const exportedName = (aliasParts[1] ?? aliasParts[0])!.trim();
      return `exports.${exportedName} = ${localName};`;
    }).join("\n");
  });

  transformed = transformed.replace(/export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;]+);?/g, (_match, kind, name, initializer) => {
    usesEsmExports = true;
    return `${kind} ${name} = ${initializer};\nexports.${name} = ${name};`;
  });

  transformed = transformed.replace(/export\s+((?:async\s+)?function(?:\s*\*)?)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g, (_match, prefix, name) => {
    usesEsmExports = true;
    appendedExports.push(`exports.${name} = ${name};`);
    return `${prefix} ${name}(`;
  });

  transformed = transformed.replace(/export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, (_match, name) => {
    usesEsmExports = true;
    appendedExports.push(`exports.${name} = ${name};`);
    return `class ${name}`;
  });

  if (appendedExports.length > 0) {
    transformed = `${transformed}\n${appendedExports.join("\n")}`;
  }
  if (usesEsmExports) {
    transformed = `${transformed}\nexports.__esModule = true;`;
  }
  return transformed;
}

function isJavaScriptLikeModulePath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".js" || extension === ".mjs" || extension === ".cjs" || extension === ".jsx";
}

export function transpileModuleSource(source: string, filePath: string): { code: string; exportNames: string[] | null } {
  if (shouldPreserveCommonJsSource(source, filePath)) {
    return {
      code: source,
      exportNames: null
    };
  }
  const extension = extname(filePath).toLowerCase();
  const javascriptLikeModule = isJavaScriptLikeModulePath(filePath);
  const parsed = parseSource(source, {
    language: "typescript",
    jsx: extension === ".tsx" || extension === ".jsx"
  });
  if (!parsed.ast) {
    if (javascriptLikeModule) {
      return {
        code: transformJavaScriptModuleSource(source),
        exportNames: null
      };
    }
    const detail = parsed.fatalError
      ?? parsed.tokenizeError?.message
      ?? parsed.parserIssues[0]?.message
      ?? "unknown parse error";
    throw new Error(`Unable to parse bundled module '${filePath}': ${detail}`);
  }
  if (parsed.parserIssues.length > 0) {
    if (javascriptLikeModule) {
      return {
        code: transformJavaScriptModuleSource(source),
        exportNames: null
      };
    }
    const issue = parsed.parserIssues[0]!;
    throw new Error(`Unable to parse bundled module '${filePath}': ${issue.message}`);
  }
  return {
    code: emitProgram(parsed.ast, undefined, undefined, undefined, { moduleFormat: "commonjs" }),
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
  virtualSources: ReadonlyMap<string, string>
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
    const resolved = await resolveDependency(filePath, specifier, vfs, virtualSources);
    resolvedDependencies[specifier] = resolved.kind === "bundled" ? resolved.filePath : null;
  }
  return {
    mtimeMs: await fileMtimeInVfs(filePath, vfs) ?? -1,
    code: transpiledCode,
    resolvedDependencies
  };
}

async function loadBundledModuleArtifact(
  filePath: string,
  vfs: Vfs,
  virtualSources: ReadonlyMap<string, string>
): Promise<CachedBundledModuleArtifact> {
  if (virtualSources.has(filePath)) {
    return createCachedBundledModuleArtifact(filePath, vfs, virtualSources);
  }

  const mtimeMs = await fileMtimeInVfs(filePath, vfs);
  const cached = mtimeMs === null ? undefined : bundledModuleArtifactCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached;
  }

  const artifact = await createCachedBundledModuleArtifact(filePath, vfs, virtualSources);
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
    const artifact = await loadBundledModuleArtifact(filePath, activeVfs, virtualSources);
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
    const resolved = await resolveDependency(sourcePath, specifier, activeVfs, virtualSources);
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
