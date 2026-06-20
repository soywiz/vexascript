import { describe, expect, it, join, mkdir, mkdtemp, tmpdir, writeFile } from "../test/expect";
import { clearAmbientTypesCache, loadAmbientTypesForProject } from "./ambientTypesLoader";

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

  it("loads declarations from a runtime package that publishes its own types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "pixi.js");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "index.d.ts"),
      `declare module "pixi.js" {\n  export function hello(): void;\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "pixi.js", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["pixi.js"]);

    expect(result.moduleDeclarations.has("pixi.js")).toBe(true);
    expect(result.moduleDeclarations.get("pixi.js")?.length).toBeGreaterThan(0);
  });

  it("loads declarations from a direct .d.ts path listed in compilerOptions.types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const typesDir = join(root, "types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      join(typesDir, "pixi-global.d.ts"),
      `declare var PIXI: { version: string };\n`,
      "utf8"
    );

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["types/pixi-global.d.ts"]);

    expect(result.globalDeclarations.length).toBeGreaterThan(0);
  });

  it("falls back to @types when the runtime package has no declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const runtimePkgDir = join(root, "node_modules", "mylib");
    const typesPkgDir = join(root, "node_modules", "@types", "mylib");
    await mkdir(runtimePkgDir, { recursive: true });
    await mkdir(typesPkgDir, { recursive: true });
    await writeFile(join(runtimePkgDir, "package.json"), JSON.stringify({ name: "mylib", main: "index.js" }), "utf8");
    await writeFile(
      join(typesPkgDir, "index.d.ts"),
      `declare module "mylib" {\n  export const version: string;\n}\n`,
      "utf8"
    );
    await writeFile(join(typesPkgDir, "package.json"), JSON.stringify({ name: "@types/mylib", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["mylib"]);

    expect(result.moduleDeclarations.has("mylib")).toBe(true);
    expect(result.moduleDeclarations.get("mylib")?.length).toBeGreaterThan(0);
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

  it("extracts declarations from global blocks nested inside declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "myglobals");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "index.d.ts"),
      `global {\n  type BufferEncoding = "utf8" | "utf-8";\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/myglobals", types: "index.d.ts" }), "utf8");

    const result = await loadAmbientTypesForProject(join(root, "main.vx"), ["myglobals"]);

    expect(
      result.globalDeclarations.some(
        (statement) => statement.kind === "TypeAliasStatement" && (statement as { name?: { name?: string } }).name?.name === "BufferEncoding"
      )
    ).toBe(true);
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

  it("clears cached ambient type packages when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "mylib");
    await mkdir(pkgDir, { recursive: true });
    const dtsPath = join(pkgDir, "index.d.ts");
    await writeFile(
      dtsPath,
      `declare module "mylib" {\n  export function oldVersion(): void;\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/mylib", types: "index.d.ts" }), "utf8");

    const first = await loadAmbientTypesForProject(join(root, "main.vx"), ["mylib"]);
    expect(first.moduleDeclarations.get("mylib")?.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "FunctionStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "oldVersion"
    )).toBe(true);

    await writeFile(
      dtsPath,
      `declare module "mylib" {\n  export function newVersion(): void;\n}\n`,
      "utf8"
    );
    clearAmbientTypesCache();

    const second = await loadAmbientTypesForProject(join(root, "main.vx"), ["mylib"]);
    expect(second.moduleDeclarations.get("mylib")?.some((statement) =>
      statement.kind === "ExportStatement"
      && (statement as { declaration?: { kind?: string; name?: { name?: string } } }).declaration?.kind === "FunctionStatement"
      && (statement as { declaration?: { name?: { name?: string } } }).declaration?.name?.name === "newVersion"
    )).toBe(true);
  });

  it("reuses merged project ambient results until the ambient cache is cleared", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ambient-"));
    const pkgDir = join(root, "node_modules", "@types", "mylib");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "index.d.ts"),
      `declare module "mylib" {\n  export function hello(): void;\n}\n`,
      "utf8"
    );
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@types/mylib", types: "index.d.ts" }), "utf8");

    const importerPath = join(root, "main.vx");
    const first = await loadAmbientTypesForProject(importerPath, ["mylib"]);
    const second = await loadAmbientTypesForProject(importerPath, ["mylib"]);
    expect(first).toBe(second);

    clearAmbientTypesCache();

    const third = await loadAmbientTypesForProject(importerPath, ["mylib"]);
    expect(third).not.toBe(first);
    expect(third.moduleDeclarations.get("mylib")?.length).toBeGreaterThan(0);
  });
});
