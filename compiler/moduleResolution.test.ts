import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./test/expect";
import { resolveImportTargetFilePath } from "./moduleResolution";

describe("resolveImportTargetFilePath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mylang-module-resolution-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends a .my extension when the import omits one", async () => {
    const importer = join(root, "main.my");
    await writeFile(importer, "");
    const target = join(root, "utils.my");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "./utils")).toBe(target);
  });

  it("resolves an import that already includes the extension", async () => {
    const importer = join(root, "main.my");
    await writeFile(importer, "");
    const target = join(root, "utils.my");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "./utils.my")).toBe(target);
  });

  it("resolves imports relative to the importing file's directory", async () => {
    const nestedDir = join(root, "nested");
    await mkdir(nestedDir);
    const importer = join(nestedDir, "main.my");
    await writeFile(importer, "");
    const target = join(root, "shared.my");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "../shared")).toBe(target);
  });

  it("returns null when the target file does not exist", async () => {
    const importer = join(root, "main.my");
    await writeFile(importer, "");

    expect(await resolveImportTargetFilePath(importer, "./missing")).toBeNull();
  });
});
