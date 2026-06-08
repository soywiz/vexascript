import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export type MyLangTestExecutor = (source: string, filePath: string) => Promise<void>;

export interface MyLangTestRunResult {
  testFiles: string[];
}

const TEST_RUNTIME_SOURCE = `@JsInline("((function test() { call() })())")
fun test(call: any)
@JsInline("if (!cond) throw new Error(message)")
fun assert(cond: boolean, message: string = "assert failed")
`;

const IGNORED_TEST_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

export function appendTestRuntimeSource(source: string): string {
  return `${source}\n${TEST_RUNTIME_SOURCE}`;
}

export async function discoverMyLangTestFiles(path: string, cwd = process.cwd()): Promise<string[]> {
  const resolvedPath = resolve(cwd, path);
  const info = await stat(resolvedPath);
  if (info.isFile()) {
    return resolvedPath.endsWith(".test.my") ? [resolvedPath] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const discovered: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && IGNORED_TEST_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const entryPath = resolve(resolvedPath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...await discoverMyLangTestFiles(entryPath, cwd));
    } else if (entry.isFile() && entry.name.endsWith(".test.my")) {
      discovered.push(entryPath);
    }
  }
  return discovered;
}

export async function runMyLangTests(
  paths: string[],
  executeTest: MyLangTestExecutor,
  cwd = process.cwd()
): Promise<MyLangTestRunResult> {
  const roots = paths.length > 0 ? paths : [cwd];
  const discovered = await Promise.all(roots.map((path) => discoverMyLangTestFiles(path, cwd)));
  const testFiles = [...new Set(discovered.flat())].sort();
  if (testFiles.length === 0) {
    throw new Error("No .test.my files found");
  }

  for (const testFile of testFiles) {
    const source = await readFile(testFile, "utf8");
    await executeTest(appendTestRuntimeSource(source), testFile);
  }

  return { testFiles };
}
