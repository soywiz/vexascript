import { cp, mkdir, readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const rootRequire = createRequire(import.meta.url);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distNodeModulesDir = join(rootDir, "dist", "node_modules");

const rootPackages = [
  "vscode-languageserver",
  "vscode-languageserver-textdocument"
];

const seen = new Set();
const packageJsonPaths = new Map();

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function packageJsonPathFor(name, resolver = rootRequire) {
  let currentDir = dirname(resolver.resolve(name));
  while (true) {
    const candidate = join(currentDir, "package.json");
    if (await fileExists(candidate)) {
      const packageJson = await readJson(candidate);
      if (packageJson.name === name) {
        return candidate;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find package.json for ${name}`);
    }
    currentDir = parentDir;
  }
}

async function collectPackageNames(name, names) {
  if (seen.has(name)) {
    return;
  }
  seen.add(name);
  names.add(name);

  const packageJsonPath = await packageJsonPathFor(name);
  packageJsonPaths.set(name, packageJsonPath);
  const packageJson = await readJson(packageJsonPath);
  const packageRequire = createRequire(packageJsonPath);
  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    if (dependencyName.startsWith("@types/")) {
      continue;
    }
    await collectPackageNamesFromResolver(dependencyName, names, packageRequire);
  }
}

async function collectPackageNamesFromResolver(name, names, resolver) {
  if (seen.has(name)) {
    return;
  }
  seen.add(name);
  names.add(name);

  const packageJsonPath = await packageJsonPathFor(name, resolver);
  packageJsonPaths.set(name, packageJsonPath);
  const packageJson = await readJson(packageJsonPath);
  const packageRequire = createRequire(packageJsonPath);
  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    if (dependencyName.startsWith("@types/")) {
      continue;
    }
    await collectPackageNamesFromResolver(dependencyName, names, packageRequire);
  }
}

async function copyPackage(name) {
  const packageJsonPath = packageJsonPaths.get(name);
  if (!packageJsonPath) {
    throw new Error(`No staged package path recorded for ${name}`);
  }
  const packageDir = dirname(packageJsonPath);
  const targetDir = join(distNodeModulesDir, name);
  await mkdir(dirname(targetDir), { recursive: true });
  await cp(packageDir, targetDir, { recursive: true });
}

async function main() {
  const packageNames = new Set();
  for (const name of rootPackages) {
    await collectPackageNames(name, packageNames);
  }

  await mkdir(distNodeModulesDir, { recursive: true });
  for (const name of [...packageNames].sort()) {
    await copyPackage(name);
  }
}

await main();
