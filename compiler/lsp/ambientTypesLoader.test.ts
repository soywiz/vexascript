import { describe, it } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";

describe("loadAmbientTypesForProject", () => {
  it("returns empty result when types list is empty", async () => {
    const result = await loadAmbientTypesForProject("/some/file.vx", []);
    expect(result.globalDeclarations).toHaveLength(0);
    expect(result.moduleDeclarations.size).toBe(0);
  });

  it("returns empty result when importer path is null", async () => {
    const result = await loadAmbientTypesForProject(null, ["node"]);
    expect(result.globalDeclarations).toHaveLength(0);
    expect(result.moduleDeclarations.size).toBe(0);
  });

  it("loads declare module blocks from a types package into moduleDeclarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "mylib");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "index.d.ts"),
      `declare module "mylib" {\n  export function hello(): void;\n  export const version: string;\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/mylib", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["mylib"]);

    expect(result.moduleDeclarations.has("mylib")).toBe(true);
    expect(result.moduleDeclarations.get("mylib")?.length).toBeGreaterThan(0);
    expect(result.globalDeclarations).toHaveLength(0);
  });

  it("loads global ambient declarations (not inside declare module) into globalDeclarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "myenv");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "index.d.ts"),
      `declare var process: { env: Record<string, string> };\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/myenv", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["myenv"]);

    expect(result.globalDeclarations.length).toBeGreaterThan(0);
    expect(result.moduleDeclarations.size).toBe(0);
  });

  it("follows /// <reference path> directives to load additional declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "mylib2");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "index.d.ts"),
      `/// <reference path="extra.d.ts" />\n`,
      "utf8"
    );
    await writeFile(
      join(pkgDir, "extra.d.ts"),
      `declare module "mylib2/extra" {\n  export function extra(): void;\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/mylib2", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["mylib2"]);

    expect(result.moduleDeclarations.has("mylib2/extra")).toBe(true);
  });

  it("records moduleDeclarationLocations for each declare module block", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "mymod");
    await mkdir(pkgDir, { recursive: true });
    const dtsPath = join(pkgDir, "index.d.ts");
    await writeFile(
      dtsPath,
      `declare module "mymod" {\n  export function hello(): void;\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/mymod", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["mymod"]);

    expect(result.moduleDeclarationLocations.has("mymod")).toBe(true);
    const loc = result.moduleDeclarationLocations.get("mymod")!;
    expect(loc.filePath).toBe(dtsPath);
    expect(loc.line).toBe(0);
  });
});
