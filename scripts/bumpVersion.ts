import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const semanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface PackageManifest {
  version?: unknown;
  [key: string]: unknown;
}

function updatedPackageManifest(source: string, version: string, path: string): string {
  const manifest = JSON.parse(source) as PackageManifest;
  if (typeof manifest.version !== "string") {
    throw new Error(`${path} is missing a version string`);
  }
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function bumpPackageVersions(version: string, projectRoot: string): Promise<void> {
  if (!semanticVersionPattern.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  const packagePaths = [
    join(projectRoot, "package.json"),
    join(projectRoot, "plugins", "vscode", "package.json"),
  ];
  const sources = await Promise.all(packagePaths.map((path) => readFile(path, "utf8")));
  const updatedSources = sources.map((source, index) => updatedPackageManifest(source, version, packagePaths[index]));
  await Promise.all(packagePaths.map((path, index) => writeFile(path, updatedSources[index], "utf8")));
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (!version) {
    throw new Error("Usage: pnpm bump <version>");
  }
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await bumpPackageVersions(version, projectRoot);
  console.log(`Bumped VexaScript packages to ${version}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
