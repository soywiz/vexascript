import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSource } from "./pipeline/parse";
import { describe, expect, it } from "./test/expect";

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

let compilerTypeScriptFilesPromise: Promise<string[]> | undefined;

async function compilerTypeScriptFiles(): Promise<string[]> {
  compilerTypeScriptFilesPromise ??= collectTypeScriptFiles(join(process.cwd(), "compiler"));
  return compilerTypeScriptFilesPromise;
}

describe("Parse compiler codebase", () => {
  const expectedStrictFailures: string[] = [];

  it("discovers every TypeScript file under compiler/ for parser profiling", async () => {
    const files = await compilerTypeScriptFiles();

    expect(files.length > 0).toBe(true);
    expect(files.every((filePath) => filePath.endsWith(".ts"))).toBe(true);
  });

  it("parses the compiler codebase in typescript mode, except for the tracked compatibility gaps", async () => {
    const cwdPrefix = `${process.cwd()}/`;
    const files = await compilerTypeScriptFiles();
    const failures: string[] = [];
    let parsedFileCount = 0;

    for (const filePath of files) {
      const source = await readFile(filePath, "utf8");
      const parsed = parseSource(source, { language: "typescript", jsx: filePath.endsWith(".tsx") });
      if (!parsed.ast || parsed.parserIssues.length > 0 || parsed.tokenizeError || parsed.fatalError) {
        const messages = [
          ...parsed.parserIssues.map((issue) => `${issue.message} @ ${issue.token?.range.start.line}:${issue.token?.range.start.column}`),
          ...(parsed.tokenizeError ? [`${parsed.tokenizeError.message} @ ${parsed.tokenizeError.range.start.line}:${parsed.tokenizeError.range.start.column}`] : []),
          ...(parsed.fatalError ? [parsed.fatalError] : [])
        ];
        failures.push(`${filePath.replace(cwdPrefix, "")}: ${messages.join(" | ") || "missing AST"}`);
        continue;
      }

      parsedFileCount += 1;
    }

    expect(files.length > 0).toBe(true);
    expect(parsedFileCount).toBeGreaterThanOrEqual(files.length - expectedStrictFailures.length);
    expect(failures).toEqual(expectedStrictFailures);
  });
});
