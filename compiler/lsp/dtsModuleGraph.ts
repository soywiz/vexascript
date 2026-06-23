/**
 * Shared, package-independent `.d.ts` declaration-graph primitives. These work
 * from any entry file + VFS and are meant to be reused by every loader that
 * follows a `.d.ts` graph — the node_modules typings loader
 * (`nodeModulesTypings.ts`) and the ambient/runtime types loader
 * (`ambientTypesLoader.ts`) — so the loaders do not drift apart.
 *
 * This is the module the `generalize-dts-declaration-loading` task grows the
 * general loader into; see `docs/tasks/generalize-dts-declaration-loading.md`.
 */

/**
 * Extracts the targets of `/// <reference path="..."/>` directives from a
 * `.d.ts` source. Tolerates single or double quotes and leading whitespace and
 * does not require the closing `/>`, so every loader follows references
 * identically. Results are de-duplicated and trimmed, in source order.
 */
export function extractTripleSlashReferencePaths(source: string): string[] {
  const referencePattern = /^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["']/gm;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(referencePattern)) {
    const path = match[1]?.trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
