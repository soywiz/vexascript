import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommandCapture, type CommandOutput } from "../cli/io";

const semanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface PackageManifest {
  version?: unknown;
  [key: string]: unknown;
}

export type GitRunner = (args: string[], cwd: string) => Promise<CommandOutput>;

function validateVersion(version: string): void {
  if (!semanticVersionPattern.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
}

function updatedPackageManifest(source: string, version: string, path: string): string {
  const manifest = JSON.parse(source) as PackageManifest;
  if (typeof manifest.version !== "string") {
    throw new Error(`${path} is missing a version string`);
  }
  if (manifest.version === version) {
    return source;
  }
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function bumpPackageVersions(version: string, projectRoot: string): Promise<boolean> {
  validateVersion(version);

  const packagePaths = [
    join(projectRoot, "package.json"),
    join(projectRoot, "plugins", "vscode", "package.json"),
  ];
  const sources = await Promise.all(packagePaths.map((path) => readFile(path, "utf8")));
  const updatedSources = sources.map((source, index) => updatedPackageManifest(source, version, packagePaths[index]));
  const changedIndexes = updatedSources.flatMap((source, index) => source === sources[index] ? [] : [index]);
  await Promise.all(changedIndexes.map((index) => writeFile(packagePaths[index], updatedSources[index], "utf8")));
  return changedIndexes.length > 0;
}

async function defaultGitRunner(args: string[], cwd: string): Promise<CommandOutput> {
  return await runCommandCapture("git", args, { cwd });
}

async function gitOutput(runGit: GitRunner, args: string[], projectRoot: string): Promise<string> {
  const result = await runGit(args, projectRoot);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited with code ${result.code}`);
  }
  return result.stdout.trim();
}

export async function publishRelease(
  version: string,
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner
): Promise<void> {
  validateVersion(version);
  const status = await gitOutput(runGit, ["status", "--porcelain"], projectRoot);
  if (status) {
    throw new Error("Cannot publish a release from a dirty working tree");
  }

  const branch = await gitOutput(runGit, ["branch", "--show-current"], projectRoot);
  if (!branch) {
    throw new Error("Cannot publish a release from a detached HEAD");
  }

  const localTag = await gitOutput(runGit, ["tag", "--list", version], projectRoot);
  if (localTag) {
    throw new Error(`Git tag ${version} already exists locally`);
  }
  const remoteTag = await gitOutput(
    runGit,
    ["ls-remote", "--tags", "origin", `refs/tags/${version}`],
    projectRoot
  );
  if (remoteTag) {
    throw new Error(`Git tag ${version} already exists on origin`);
  }

  const changed = await bumpPackageVersions(version, projectRoot);
  if (changed) {
    await gitOutput(runGit, ["add", "package.json", "plugins/vscode/package.json"], projectRoot);
    await gitOutput(runGit, ["commit", "-m", `Release ${version}`], projectRoot);
  }

  await gitOutput(runGit, ["tag", "-a", version, "-m", version], projectRoot);
  await gitOutput(runGit, ["push", "origin", `refs/tags/${version}`], projectRoot);
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (!version) {
    throw new Error("Usage: pnpm bump <version>");
  }
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await publishRelease(version, projectRoot);
  console.log(`Published VexaScript ${version}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
