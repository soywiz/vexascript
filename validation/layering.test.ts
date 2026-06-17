import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";

// Core compiler layers must stay usable without the LSP layer (and therefore
// without `vscode-languageserver`), so editors, the CLI, and browser bundles
// can consume them independently.
const CORE_LAYER_DIRECTORIES = [
  "compiler/parser",
  "compiler/ast",
  "compiler/analysis",
  "compiler/runtime",
  "compiler/pipeline"
];

const LSP_IMPORT_PATTERN = /from\s+["'](?:compiler\/lsp\/|(?:\.\.\/)+lsp\/)/;
const STATIC_IMPORT_SPECIFIER_PATTERN = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]\s*;?/gm;
const DYNAMIC_IMPORT_SPECIFIER_PATTERN = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const FORBIDDEN_COMPILER_IMPORT_ROOTS = ["cli", "website", "plugins", "samples", "docs"];

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function isForbiddenBareSpecifier(specifier: string): boolean {
  return FORBIDDEN_COMPILER_IMPORT_ROOTS.some((root) => specifier === root || specifier.startsWith(`${root}/`));
}

function resolveRelativeImport(filePath: string, specifier: string): string {
  return resolve(filePath, "..", specifier);
}

function isInsideDirectory(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(rootDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("../"));
}

function isRelativeImportInsideCompiler(filePath: string, specifier: string): boolean {
  const resolvedTarget = resolveRelativeImport(filePath, specifier);
  const compilerRoot = resolve(process.cwd(), "compiler");
  return isInsideDirectory(compilerRoot, resolvedTarget);
}

function resolvesIntoForbiddenAppFolder(filePath: string, specifier: string): boolean {
  const resolvedTarget = resolveRelativeImport(filePath, specifier);
  return FORBIDDEN_COMPILER_IMPORT_ROOTS.some((root) =>
    isInsideDirectory(resolve(process.cwd(), root), resolvedTarget)
  );
}

function shouldCheckCompilerFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return !normalized.endsWith(".test.ts") && !normalized.includes("compiler/test/");
}

function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    specifiers.push(specifier);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

function collectForbiddenCompilerImports(filePath: string, source: string): string[] {
  const invalidSpecifiers: string[] = [];
  for (const specifier of collectImportSpecifiers(source)) {
    if (isBareSpecifier(specifier)) {
      if (isForbiddenBareSpecifier(specifier)) {
        invalidSpecifiers.push(specifier);
      }
      continue;
    }
    if (specifier.startsWith("/")) {
      invalidSpecifiers.push(specifier);
      continue;
    }
    if (isRelativeImportInsideCompiler(filePath, specifier)) {
      continue;
    }
    if (resolvesIntoForbiddenAppFolder(filePath, specifier)) {
      invalidSpecifiers.push(specifier);
    }
  }
  return invalidSpecifiers;
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const filePaths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...await collectSourceFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      filePaths.push(entryPath);
    }
  }
  return filePaths;
}

describe("layering", () => {
  it("keeps core compiler layers free of LSP-layer imports", async () => {
    const violations: string[] = [];

    for (const directory of CORE_LAYER_DIRECTORIES) {
      for (const filePath of await collectSourceFiles(directory)) {
        const source = await readFile(filePath, "utf8");
        if (LSP_IMPORT_PATTERN.test(source)) {
          violations.push(filePath);
        }
      }
    }

    expect(
      violations,
      `Core compiler modules must not import from compiler/lsp: ${violations.join(", ")}`
    ).toEqual([]);
  });

  it("keeps compiler source imports inside compiler or external packages", async () => {
    const violations: string[] = [];
    for (const filePath of await collectSourceFiles("compiler")) {
      if (!shouldCheckCompilerFile(filePath)) {
        continue;
      }
      const source = await readFile(filePath, "utf8");
      for (const specifier of collectForbiddenCompilerImports(filePath, source)) {
        violations.push(`${filePath} -> ${specifier}`);
      }
    }

    expect(
      violations,
      `Compiler source files must not import sibling app folders such as cli/: ${violations.join(", ")}`
    ).toEqual([]);
  });

  it("keeps non-test compiler source free of node:* imports", async () => {
    const violations: string[] = [];
    for (const filePath of await collectSourceFiles("compiler")) {
      if (!shouldCheckCompilerFile(filePath)) {
        continue;
      }
      const source = await readFile(filePath, "utf8");
      const nodeSpecifiers = collectImportSpecifiers(source).filter((specifier) => specifier.startsWith("node:"));
      if (nodeSpecifiers.length > 0) {
        violations.push(`${filePath} -> ${nodeSpecifiers.join(", ")}`);
      }
    }

    expect(
      violations,
      `Non-test compiler source files must not import node:* modules: ${violations.join(", ")}`
    ).toEqual([]);
  });
});
