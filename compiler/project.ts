import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseToml } from "./runtime/toml";

export interface MylangProject {
  projectDir: string;
  dependencies: Record<string, string>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadProject(startPath: string): Promise<MylangProject | null> {
  const startDir = (await fileExists(startPath) && !(await fileExists(startPath + "/.")))
    ? dirname(startPath)
    : startPath;

  let dir = resolve(startDir);
  while (true) {
    const tomlPath = resolve(dir, "mylang.toml");
    if (await fileExists(tomlPath)) {
      const source = await readFile(tomlPath, "utf8");
      const doc = parseToml(source);
      const depsSection = doc["dependencies"] ?? {};
      const dependencies: Record<string, string> = {};
      for (const [pkg, version] of Object.entries(depsSection)) {
        if (typeof version === "string") {
          dependencies[pkg] = version;
        }
      }
      return { projectDir: dir, dependencies };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
