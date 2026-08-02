import { afterEach, describe, expect, it } from "../compiler/test/expect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpPackageVersions, publishRelease, type GitRunner } from "./bumpVersion";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("version bump", () => {
  it("updates the root package and VS Code extension versions together", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vexa-version-bump-"));
    temporaryDirectories.push(projectRoot);
    const extensionRoot = join(projectRoot, "plugins", "vscode");
    await mkdir(extensionRoot, { recursive: true });
    await Promise.all([
      writeFile(join(projectRoot, "package.json"), '{"name":"vexascript","version":"0.10.0"}\n', "utf8"),
      writeFile(join(extensionRoot, "package.json"), '{"name":"vexascript-vscodeext","version":"0.10.0"}\n', "utf8"),
    ]);

    await bumpPackageVersions("0.11.0", projectRoot);

    const [rootPackage, extensionPackage] = await Promise.all([
      readFile(join(projectRoot, "package.json"), "utf8"),
      readFile(join(extensionRoot, "package.json"), "utf8"),
    ]);
    expect(JSON.parse(rootPackage).version).toBe("0.11.0");
    expect(JSON.parse(extensionPackage).version).toBe("0.11.0");
  });

  it("rejects invalid versions without changing either package", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vexa-version-bump-"));
    temporaryDirectories.push(projectRoot);
    const extensionRoot = join(projectRoot, "plugins", "vscode");
    await mkdir(extensionRoot, { recursive: true });
    const originalPackage = '{"version":"0.10.0"}\n';
    await Promise.all([
      writeFile(join(projectRoot, "package.json"), originalPackage, "utf8"),
      writeFile(join(extensionRoot, "package.json"), originalPackage, "utf8"),
    ]);

    await expect(bumpPackageVersions("next", projectRoot)).rejects.toThrow("Invalid semantic version: next");

    expect(await readFile(join(projectRoot, "package.json"), "utf8")).toBe(originalPackage);
    expect(await readFile(join(extensionRoot, "package.json"), "utf8")).toBe(originalPackage);
  });

  it("commits, tags, and pushes a synchronized version bump", async () => {
    const projectRoot = await createVersionedProject("0.10.0");
    const commands: string[][] = [];
    const runGit = fakeGitRunner(commands);

    await publishRelease("0.11.0", projectRoot, runGit);

    expect(commands).toEqual([
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      ["tag", "--list", "0.11.0"],
      ["ls-remote", "--tags", "origin", "refs/tags/0.11.0"],
      ["add", "package.json", "plugins/vscode/package.json"],
      ["commit", "-m", "Release 0.11.0"],
      ["tag", "-a", "0.11.0", "-m", "0.11.0"],
      ["push", "origin", "refs/tags/0.11.0"],
    ]);
  });

  it("tags and pushes the current commit when manifests already use the requested version", async () => {
    const projectRoot = await createVersionedProject("0.11.0");
    const commands: string[][] = [];

    await publishRelease("0.11.0", projectRoot, fakeGitRunner(commands));

    expect(commands.some((args) => args[0] === "commit")).toBe(false);
    expect(commands).toContainEqual(["tag", "-a", "0.11.0", "-m", "0.11.0"]);
    expect(commands).toContainEqual([
      "push",
      "origin",
      "refs/tags/0.11.0",
    ]);
  });

  it("refuses to publish from a dirty working tree", async () => {
    const projectRoot = await createVersionedProject("0.10.0");
    const runGit: GitRunner = async () => ({ code: 0, stdout: " M package.json\n", stderr: "" });

    await expect(publishRelease("0.11.0", projectRoot, runGit)).rejects.toThrow(
      "Cannot publish a release from a dirty working tree"
    );

    const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    expect(rootPackage.version).toBe("0.10.0");
  });

  it("refuses to overwrite an existing remote tag before changing manifests", async () => {
    const projectRoot = await createVersionedProject("0.10.0");
    const runGit: GitRunner = async (args) => {
      if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "ls-remote") return { code: 0, stdout: "deadbeef\trefs/tags/0.11.0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(publishRelease("0.11.0", projectRoot, runGit)).rejects.toThrow(
      "Git tag 0.11.0 already exists on origin"
    );

    const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    expect(rootPackage.version).toBe("0.10.0");
  });
});

async function createVersionedProject(version: string): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "vexa-version-bump-"));
  temporaryDirectories.push(projectRoot);
  const extensionRoot = join(projectRoot, "plugins", "vscode");
  await mkdir(extensionRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "package.json"), `{"version":"${version}"}\n`, "utf8"),
    writeFile(join(extensionRoot, "package.json"), `{"version":"${version}"}\n`, "utf8"),
  ]);
  return projectRoot;
}

function fakeGitRunner(commands: string[][]): GitRunner {
  return async (args) => {
    commands.push(args);
    if (args[0] === "branch") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}
