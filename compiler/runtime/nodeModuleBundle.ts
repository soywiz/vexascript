import { builtinModules } from "node:module";
import * as ts from "typescript";
import { basename, dirname, extname, relative, resolve } from "compiler/utils/path";
import { localVfs } from "compiler/localVfs";
import type { Vfs } from "compiler/vfs";

interface BundleNodeModulesOptions {
  vfs?: Vfs;
  virtualSources?: ReadonlyMap<string, string>;
}

interface BundledModuleRecord {
  id: string;
  filePath: string;
  code: string;
  dependencyMap: Record<string, string | null>;
}

type ResolvedDependency =
  | { kind: "bundled"; filePath: string }
  | { kind: "external" };

const NODE_BUILTIN_SET = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => specifier.startsWith("node:") ? specifier : `node:${specifier}`)
]);

const STATIC_REQUIRE_PATTERN = /\brequire\s*\(\s*(['"])([^"'`]+)\1\s*\)/g;

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

function detectStaticRequires(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(STATIC_REQUIRE_PATTERN)) {
    const specifier = match[2];
    if (specifier) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function transpileModuleSource(source: string, filePath: string): string {
  const transpiled = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      allowJs: true,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    },
    reportDiagnostics: false
  });
  return transpiled.outputText;
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

function collectCommonJsExports(code: string): string[] {
  const exports = new Set<string>();
  const exportPattern = /\bexports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  for (const match of code.matchAll(exportPattern)) {
    const exportName = match[1];
    if (exportName && exportName !== "__esModule") {
      exports.add(exportName);
    }
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

export async function bundleNodeModuleGraph(
  entrySource: string,
  sourcePath: string,
  options: BundleNodeModulesOptions = {}
): Promise<string> {
  const vfs = options.vfs ?? localVfs;
  const virtualSources = options.virtualSources ?? new Map<string, string>();
  const entryId = "__vexa_entry__";
  const moduleById = new Map<string, BundledModuleRecord>();
  const moduleIdByPath = new Map<string, string>();
  let nextModuleIndex = 0;

  const visitResolvedFile = async (filePath: string): Promise<string> => {
    const existing = moduleIdByPath.get(filePath);
    if (existing) {
      return existing;
    }

    const moduleId = `__vexa_module_${nextModuleIndex++}`;
    moduleIdByPath.set(filePath, moduleId);

    const extension = extname(filePath).toLowerCase();
    const source = virtualSources.get(filePath) ?? await vfs.readFile(filePath);
    if (source === null) {
      throw new Error(`Unable to read bundled module '${filePath}'`);
    }
    const transpiledCode = extension === ".json"
      ? `module.exports = ${source.trim()};`
      : transpileModuleSource(source, filePath);
    const dependencyMap: Record<string, string | null> = {};
    for (const specifier of detectStaticRequires(transpiledCode)) {
      const resolved = await resolveDependency(filePath, specifier, vfs, virtualSources);
      if (resolved.kind === "bundled") {
        dependencyMap[specifier] = await visitResolvedFile(resolved.filePath);
      } else {
        dependencyMap[specifier] = null;
      }
    }

    moduleById.set(moduleId, {
      id: moduleId,
      filePath,
      code: transpiledCode,
      dependencyMap
    });
    return moduleId;
  };

  const entryCode = transpileModuleSource(entrySource, sourcePath);
  const entryDependencyMap: Record<string, string | null> = {};
  for (const specifier of detectStaticRequires(entryCode)) {
    const resolved = await resolveDependency(sourcePath, specifier, vfs, virtualSources);
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
  const entryExports = collectCommonJsExports(entryCode);
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

  return [
    `import { createRequire as __vexaCreateRequire } from "node:module";`,
    `const __vexaExternalRequire = __vexaCreateRequire(import.meta.url);`,
    `const __vexaDependencyMaps = {`,
    dependencyMapsLiteral,
    `};`,
    `const __vexaModules = {`,
    moduleFactoriesLiteral,
    `};`,
    `const __vexaCache = Object.create(null);`,
    `function __vexaRequireFrom(importerId, specifier) {`,
    `  const mapped = __vexaDependencyMaps[importerId]?.[specifier] ?? null;`,
    `  if (mapped !== null) {`,
    `    return __vexaRequireModule(mapped);`,
    `  }`,
    `  return __vexaExternalRequire(specifier);`,
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
  ].filter((line) => line.length > 0).join("\n");
}
