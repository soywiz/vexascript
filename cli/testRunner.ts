import { readdir, stat } from "node:fs/promises";
import { LANGUAGE_FILE_EXTENSION } from "../compiler/language";
import { resolve } from "../compiler/utils/path";

const TEST_TYPE_SOURCE = `interface VexaTestContext {
  name: string
  test(name: string, callback: (context: VexaTestContext) => any): Promise<void>
}
declare fun test(name: string, callback: (context: VexaTestContext) => any): Promise<void>
declare fun test(callback: () => any): Promise<void>
declare fun assert(condition: boolean, message?: string): void`;

const IGNORED_TEST_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const TEST_FILE_SUFFIX = `.test${LANGUAGE_FILE_EXTENSION}`;

export function prependTestTypeDeclarations(source: string): string {
  return `${TEST_TYPE_SOURCE}\n${source}`;
}

export async function discoverVexaScriptTestFiles(path: string, cwd = process.cwd()): Promise<string[]> {
  const resolvedPath = resolve(cwd, path);
  const info = await stat(resolvedPath);
  if (info.isFile()) {
    return resolvedPath.endsWith(TEST_FILE_SUFFIX) ? [resolvedPath] : [];
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
      discovered.push(...await discoverVexaScriptTestFiles(entryPath, cwd));
    } else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
      discovered.push(entryPath);
    }
  }
  return discovered;
}
