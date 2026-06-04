// Discovers all *.test.ts files and runs them via node:test
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const root = fileURLToPath(new URL("..", import.meta.url));

function findTests(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findTests(full));
    } else if (entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const searchDirs = ["compiler", "testFixtures"].map((d) => join(root, d));
const testFiles = searchDirs.flatMap(findTests);

if (testFiles.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "./scripts/register-loader.mjs", "--test", ...testFiles],
  { stdio: "inherit", cwd: root }
);

process.exit(result.status ?? 1);
