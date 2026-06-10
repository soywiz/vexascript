import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSource } from "./pipeline/parse";
import { expect } from "./test/expect";

async function collectTypeScriptFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const parentPath = "parentPath" in entry && typeof entry.parentPath === "string"
      ? entry.parentPath
      : rootDir;
    files.push(join(parentPath, entry.name));
  }

  return files.sort();
}

describe("Parse compiler codebase", () => {
  it("discovers every TypeScript file under compiler/ for parser profiling", async () => {
    const compilerRoot = join(process.cwd(), "compiler");
    const files = await collectTypeScriptFiles(compilerRoot);

    expect(files.length > 0).toBe(true);
    expect(files.every((filePath) => filePath.endsWith(".ts"))).toBe(true);
  });

  it.skip("parses every TypeScript file under compiler/ in typescript mode", async () => {
    const compilerRoot = join(process.cwd(), "compiler");
    const files = await collectTypeScriptFiles(compilerRoot);
    const failures: string[] = [];

    for (const filePath of files) {
      const source = await readFile(filePath, "utf8");
      const parsed = parseSource(source, { language: "typescript", jsx: filePath.endsWith(".tsx") });
      const messages = [
        ...parsed.parserIssues.map((issue) => issue.message),
        ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
        ...(parsed.fatalError ? [parsed.fatalError] : [])
      ];

      if (!parsed.ast || messages.length > 0) {
        failures.push(`${filePath}: ${messages.join(" | ") || "missing AST"}`);
      }
    }

    expect(files.length > 0).toBe(true);
    expect(failures).toEqual([]);
  });
});
