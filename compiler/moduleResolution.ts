import { dirname, extname, resolve } from "node:path";
import { localVfs, type Vfs } from "./vfs";


export function candidateImportTargetFilePaths(
  importerFilePath: string,
  importPath: string
): string[] {
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  return extname(direct) ? [direct] : [direct, `${direct}.my`, `${direct}.ts`];
}

/**
 * Resolve an import path (as written in an `import ... from "<path>"` statement)
 * relative to the importing file, returning the absolute path to the target
 * module or `null` when it cannot be located.
 *
 * Resolution order:
 *  1. The path resolved directly against the importer's directory, if it exists
 *     in the VFS or in an open editor/LSP session.
 *  2. The same path with a `.my` extension appended, when the import omits an
 *     explicit extension.
 *  3. The same path with a `.ts` extension appended, so MyLang files can import
 *     colocated TypeScript runtime modules without spelling the extension.
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
  const vfs = options.vfs ?? localVfs;
  for (const candidate of candidateImportTargetFilePaths(importerFilePath, importPath)) {
    if (await hasImportTarget(candidate, vfs, options.getSessionForFilePath)) {
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
  const vfs = options.vfs ?? localVfs;
  if (packageName.startsWith(".") || packageName.startsWith("/")) {
    return null;
  }
  let dir = dirname(importerFilePath);
  while (true) {
    const pkgDir = resolve(dir, "node_modules", packageName);
    const packageTypings = await declarationPathInPackage(pkgDir, vfs);
    if (packageTypings) {
      return packageTypings;
    }

    const typesPkgDir = resolve(dir, "node_modules", typesPackageNameFor(packageName));
    const definitelyTypedTypings = await declarationPathInPackage(typesPkgDir, vfs);
    if (definitelyTypedTypings) {
      return definitelyTypedTypings;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
