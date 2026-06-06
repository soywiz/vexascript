import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

/**
 * Resolve an import path (as written in an `import ... from "<path>"` statement)
 * relative to the importing file, returning the absolute path to the target
 * module on disk or `null` when it cannot be located.
 *
 * Resolution order:
 *  1. The path resolved directly against the importer's directory, if it exists.
 *  2. The same path with a `.my` extension appended, when the import omits an
 *     explicit extension.
 *
 * This is the shared resolver used by the semantic project index and the LSP
 * cross-file features so they all agree on how local module paths map to files.
 */
export function resolveImportTargetFilePath(
  importerFilePath: string,
  importPath: string
): string | null {
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  if (existsSync(direct)) {
    return direct;
  }
  if (!extname(direct)) {
    const withMyExt = `${direct}.my`;
    if (existsSync(withMyExt)) {
      return withMyExt;
    }
  }
  return null;
}
