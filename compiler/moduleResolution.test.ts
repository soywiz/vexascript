import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./test/expect";
import { resolveImportTargetFilePath, resolveNodeModulesTypingsPath } from "./moduleResolution";
import { compileSource } from "./pipeline/compile";
import type { Vfs, VfsDirEntry, VfsStat } from "./vfs";


class MemoryVfs implements Vfs {
  constructor(private readonly files: Set<string>) {}

  async readFile(path: string): Promise<string | null> {
    return this.files.has(resolve(path)) ? "" : null;
  }

  async fileExists(path: string): Promise<boolean> {
    return this.files.has(resolve(path));
  }

  async stat(path: string): Promise<VfsStat | null> {
    return this.files.has(resolve(path)) ? { mtimeMs: 1, isFile: true, isDirectory: false } : null;
  }

  async readDir(_path: string): Promise<VfsDirEntry[] | null> {
    return null;
  }
}

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

  it("appends a .ts extension when no .my target exists", async () => {
    const importer = join(root, "main.my");
    await writeFile(importer, "");
    const target = join(root, "utils.ts");
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
  it("uses the provided VFS instead of requiring files on disk", async () => {
    const importer = resolve("/virtual/main.my");
    const target = resolve("/virtual/Point.my");
    const vfs = new MemoryVfs(new Set([target]));

    expect(await resolveImportTargetFilePath(importer, "./Point", { vfs })).toBe(target);
  });

  it("resolves unsaved open sessions when a target is not visible through the VFS", async () => {
    const importer = resolve("/virtual/main.my");
    const target = resolve("/virtual/Point.my");
    const vfs = new MemoryVfs(new Set());
    const targetSession = compileSource("class Point");

    expect(
      await resolveImportTargetFilePath(importer, "./Point", {
        vfs,
        getSessionForFilePath: (filePath) => filePath === target
          ? { ast: targetSession.ast }
          : null
      })
    ).toBe(target);
  });

});

describe("resolveNodeModulesTypingsPath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mylang-node-modules-typings-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("falls back to a matching @types package when the runtime package has no declarations", async () => {
    const runtimeDir = join(root, "node_modules", "minimist");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "package.json"), JSON.stringify({ name: "minimist" }), "utf8");

    const typesDir = join(root, "node_modules", "@types", "minimist");
    await mkdir(typesDir, { recursive: true });
    const dtsPath = join(typesDir, "index.d.ts");
    await writeFile(join(typesDir, "package.json"), JSON.stringify({ name: "@types/minimist" }), "utf8");
    await writeFile(dtsPath, "declare function minimist(): void; export = minimist;", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.my"), "minimist")).toBe(dtsPath);
  });

  it("maps scoped packages to DefinitelyTyped's double-underscore package name", async () => {
    const typesDir = join(root, "node_modules", "@types", "scope__pkg");
    await mkdir(typesDir, { recursive: true });
    const dtsPath = join(typesDir, "index.d.ts");
    await writeFile(join(typesDir, "package.json"), JSON.stringify({ name: "@types/scope__pkg" }), "utf8");
    await writeFile(dtsPath, "export declare const value: string;", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.my"), "@scope/pkg")).toBe(dtsPath);
  });
});
