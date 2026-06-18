/**
 * Pure text-level transformations that strip or rewrite emitted code for bundling.
 * These helpers operate on already-emitted JavaScript strings and have no dependency
 * on compiler or module-graph state.
 */

/**
 * Removes the emitted `import ... from "<local>"` / `import "<local>"`
 * statements that reference bundled local `.vx`/`.ts` modules. Relative imports that
 * resolve to JavaScript stay in the output for downstream bundlers
 * or Node.js to load normally.
 */
export function stripBundledImports(code: string, bundledSpecifiers: ReadonlySet<string>): string {
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

export function stripBundledModuleSyntax(
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

export function stripBundledCommonJsImports(code: string, bundledSpecifiers: ReadonlySet<string>): string {
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
