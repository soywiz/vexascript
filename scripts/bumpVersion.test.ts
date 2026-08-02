import { afterEach, describe, expect, it } from "../compiler/test/expect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpPackageVersions } from "./bumpVersion";

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
});
