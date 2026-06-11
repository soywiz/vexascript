import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";

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
});
