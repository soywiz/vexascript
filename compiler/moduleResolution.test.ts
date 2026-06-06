import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./test/expect";
import { resolveImportTargetFilePath } from "./moduleResolution";

describe("resolveImportTargetFilePath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mylang-module-resolution-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("appends a .my extension when the import omits one", () => {
    const importer = join(root, "main.my");
    writeFileSync(importer, "");
    const target = join(root, "utils.my");
    writeFileSync(target, "");

    expect(resolveImportTargetFilePath(importer, "./utils")).toBe(target);
  });

  it("resolves an import that already includes the extension", () => {
    const importer = join(root, "main.my");
    writeFileSync(importer, "");
    const target = join(root, "utils.my");
    writeFileSync(target, "");

    expect(resolveImportTargetFilePath(importer, "./utils.my")).toBe(target);
  });

  it("resolves imports relative to the importing file's directory", () => {
    const nestedDir = join(root, "nested");
    mkdirSync(nestedDir);
    const importer = join(nestedDir, "main.my");
    writeFileSync(importer, "");
    const target = join(root, "shared.my");
    writeFileSync(target, "");

    expect(resolveImportTargetFilePath(importer, "../shared")).toBe(target);
  });

  it("returns null when the target file does not exist", () => {
    const importer = join(root, "main.my");
    writeFileSync(importer, "");

    expect(resolveImportTargetFilePath(importer, "./missing")).toBeNull();
  });
});
