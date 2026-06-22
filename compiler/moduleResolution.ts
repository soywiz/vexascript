import { LANGUAGE_FILE_EXTENSION } from "./language";
import { dirname, extname, resolve } from "./utils/path";
import { vfs, type Vfs } from "./vfs";

/** Returns the specifier without the Node builtin `node:` prefix (no-op otherwise). */
export function stripNodeBuiltinPrefix(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

/**
 * The module-name candidates to try when resolving a Node builtin specifier
 * against ambient module declarations, since `@types/node` may register either
 * the prefixed (`node:path`) or bare (`path`) name.
 *
 * - For a `node:`-prefixed specifier: `[specifier, baseName]`.
 * - Otherwise: `[specifier]`, plus the `node:`-prefixed form when `bidirectional`
 *   is set (used where the bare name might only be registered under `node:`).
 */
export function nodeBuiltinSpecifierCandidates(
  specifier: string,
  options: { bidirectional?: boolean } = {}
): string[] {
  if (specifier.startsWith("node:")) {
    return [specifier, specifier.slice("node:".length)];
  }
  return options.bidirectional ? [specifier, `node:${specifier}`] : [specifier];
}


export function candidateImportTargetFilePaths(
  importerFilePath: string,
  importPath: string
): string[] {
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  return extname(direct)
    ? [direct]
    : [direct, `${direct}${LANGUAGE_FILE_EXTENSION}`, `${direct}.ts`, `${direct}.tsx`, `${direct}.json`, `${direct}.txt`];
}

/**
 * Resolve an import path (as written in an `import ... from "<path>"` statement)
 * relative to the importing file, returning the absolute path to the target
 * module or `null` when it cannot be located.
 *
 * Resolution order:
 *  1. The path resolved directly against the importer's directory, if it exists
 *     in the VFS or in an open editor/LSP session.
 *  2. The same path with a `${LANGUAGE_FILE_EXTENSION}` extension appended, when the import omits an
 *     explicit extension.
 *  3. The same path with a `.ts` or `.tsx` extension appended, so VexaScript files can import
 *     colocated TypeScript runtime modules without spelling the extension.
 *  4. The same path with a `.json` or `.txt` extension appended for local
 *     data/text asset imports.
 *
 * This is the shared resolver used by the semantic project index and the LSP
 * cross-file features so they all agree on how local module paths map to files,
 * including unsaved editor documents that are not yet readable through a VFS.
 */
export interface ModuleResolutionSessionLike {
  ast?: unknown | null;
}

export interface ModuleResolutionOptions {
  vfs?: Vfs | undefined;
  getSessionForFilePath?: (
    (filePath: string) => ModuleResolutionSessionLike | null | Promise<ModuleResolutionSessionLike | null>
  ) | undefined;
}

const nodeModulesTypingsPathCache = new Map<string, string | null>();

export function clearNodeModulesTypingsPathCache(): void {
  nodeModulesTypingsPathCache.clear();
}

async function hasImportTarget(
  candidate: string,
  vfs: Vfs,
  getSessionForFilePath?: ModuleResolutionOptions["getSessionForFilePath"]
): Promise<boolean> {
  if (await vfs.fileExists(candidate)) {
    return true;
  }

  if (!getSessionForFilePath) {
    return false;
  }

  const session = await getSessionForFilePath(candidate);
  return session?.ast != null;
}

export async function resolveImportTargetFilePath(
  importerFilePath: string,
  importPath: string,
  options: ModuleResolutionOptions = {}
): Promise<string | null> {
  const activeVfs = options.vfs ?? vfs();
  for (const candidate of candidateImportTargetFilePaths(importerFilePath, importPath)) {
    if (await hasImportTarget(candidate, activeVfs, options.getSessionForFilePath)) {
      return candidate;
    }
  }
  return null;
}

async function declarationPathInPackage(pkgDir: string, vfs: Vfs): Promise<string | null> {
  const pkgJsonPath = resolve(pkgDir, "package.json");
  if (!(await vfs.fileExists(pkgJsonPath))) {
    return null;
  }

  try {
    const pkgText = await vfs.readFile(pkgJsonPath);
    if (pkgText === null) {
      return null;
    }
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    const exportsTypingsPath = await declarationPathFromExports(pkgDir, pkg, null, vfs);
    if (exportsTypingsPath) {
      return exportsTypingsPath;
    }
    const typingsField = (pkg["typings"] ?? pkg["types"]) as string | undefined;
    if (typingsField) {
      const typingsPath = resolve(pkgDir, typingsField);
      if (await vfs.fileExists(typingsPath)) {
        return typingsPath;
      }
    }
    const indexDts = resolve(pkgDir, "index.d.ts");
    if (await vfs.fileExists(indexDts)) {
      return indexDts;
    }
  } catch {
    // malformed package.json
  }

  return null;
}

function declarationExportTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return /\.(d\.(ts|mts|cts))$/i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = declarationExportTarget(entry);
      if (target) {
        return target;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const directTypesTarget = declarationExportTarget(record["types"]);
  if (directTypesTarget) {
    return directTypesTarget;
  }
  for (const key of ["default", "import", "require", "browser", "node"]) {
    const target = declarationExportTarget(record[key]);
    if (target) {
      return target;
    }
  }
  return null;
}

async function declarationPathFromExports(
  pkgDir: string,
  pkg: Record<string, unknown>,
  exportSubpath: string | null,
  vfs: Vfs
): Promise<string | null> {
  const exportsField = pkg["exports"];
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return null;
  }
  const exportsRecord = exportsField as Record<string, unknown>;
  const exportKey = exportSubpath ? `./${exportSubpath}` : ".";
  const exportTarget = declarationExportTarget(exportsRecord[exportKey]);
  if (!exportTarget) {
    return null;
  }
  const typingsPath = resolve(pkgDir, exportTarget);
  return await vfs.fileExists(typingsPath) ? typingsPath : null;
}

async function declarationPathInPnpmVirtualStore(nodeModulesDir: string, packageName: string, vfs: Vfs): Promise<string | null> {
  const storeDir = resolve(nodeModulesDir, ".pnpm");
  let entries;
  try {
    entries = await vfs.readDir(storeDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    const packageDir = resolve(storeDir, entry.name, "node_modules", packageName);
    const declarationPath = await declarationPathInPackage(packageDir, vfs);
    if (declarationPath) {
      return declarationPath;
    }
  }
  return null;
}

function typesPackageNameFor(packageName: string): string {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.slice(1).split("/");
    return name ? `@types/${scope}__${name}` : `@types/${scope}`;
  }
  return `@types/${packageName}`;
}

/**
 * Given a bare specifier (package name, e.g. `"moment"`) and the path of the
 * importing file, walk up the directory tree looking for a `node_modules/<pkg>`
 * folder. When found, read the package's `typings`/`types` field (or fall back
 * to `index.d.ts`) and return the absolute path to the declaration file. If the
 * runtime package does not ship declarations, fall back to the matching
 * DefinitelyTyped package under `node_modules/@types`.
 *
 * Returns `null` when the package or its declaration file cannot be located.
 */
export async function resolveNodeModulesTypingsPath(
  importerFilePath: string,
  packageName: string,
  options: ModuleResolutionOptions = {}
): Promise<string | null> {
  const activeVfs = options.vfs ?? vfs();
  if (packageName.startsWith(".") || packageName.startsWith("/")) {
    return null;
  }
  const cacheKey = `${dirname(importerFilePath)}\0${packageName}`;
  const cached = nodeModulesTypingsPathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const normalizedPackageName = stripNodeBuiltinPrefix(packageName);
  const packagePathParts = normalizedPackageName.startsWith("@")
    ? normalizedPackageName.split("/").slice(0, 2)
    : normalizedPackageName.split("/").slice(0, 1);
  const rootPackageName = packagePathParts.join("/");
  const exportSubpath = normalizedPackageName.slice(rootPackageName.length).replace(/^\/+/, "") || null;
  let dir = dirname(importerFilePath);
  while (true) {
    const nodeModulesDir = resolve(dir, "node_modules");
    const pkgDir = resolve(nodeModulesDir, rootPackageName);
    let packageTypings: string | null = null;
    if (exportSubpath || await activeVfs.fileExists(resolve(pkgDir, "package.json"))) {
      try {
        const pkgText = await activeVfs.readFile(resolve(pkgDir, "package.json"));
        if (pkgText !== null) {
          const pkg = JSON.parse(pkgText) as Record<string, unknown>;
          packageTypings = await declarationPathFromExports(pkgDir, pkg, exportSubpath, activeVfs);
        }
      } catch {
        // malformed package.json
      }
    }
    if (!packageTypings) {
      packageTypings = await declarationPathInPackage(pkgDir, activeVfs);
    }
    if (packageTypings) {
      nodeModulesTypingsPathCache.set(cacheKey, packageTypings);
      return packageTypings;
    }

    const typesPkgDir = resolve(nodeModulesDir, typesPackageNameFor(rootPackageName));
    const definitelyTypedTypings = await declarationPathInPackage(typesPkgDir, activeVfs);
    if (definitelyTypedTypings) {
      nodeModulesTypingsPathCache.set(cacheKey, definitelyTypedTypings);
      return definitelyTypedTypings;
    }
    const pnpmPackageTypings = await declarationPathInPnpmVirtualStore(nodeModulesDir, rootPackageName, activeVfs);
    if (pnpmPackageTypings) {
      nodeModulesTypingsPathCache.set(cacheKey, pnpmPackageTypings);
      return pnpmPackageTypings;
    }
    const pnpmTypesTypings = await declarationPathInPnpmVirtualStore(
      nodeModulesDir,
      typesPackageNameFor(rootPackageName),
      activeVfs
    );
    if (pnpmTypesTypings) {
      nodeModulesTypingsPathCache.set(cacheKey, pnpmTypesTypings);
      return pnpmTypesTypings;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  nodeModulesTypingsPathCache.set(cacheKey, null);
  return null;
}
