import { afterEach, beforeEach, describe, expect, it, join, mkdir, mkdtemp, resolve, rm, tmpdir, writeFile } from "./test/expect";
import {
  clearNodeModulesTypingsPathCache,
  nodeBuiltinSpecifierCandidates,
  resolveImportTargetFilePath,
  resolveNodeModulesTypingsPath,
  stripNodeBuiltinPrefix
} from "./moduleResolution";
import { compileSource } from "./pipeline/compile";
import { Vfs, VfsStat } from "./vfs";

class MemoryVfs extends Vfs {
  constructor(private readonly files: Set<string>) {
    super();
  }

  override async readFile(path: string): Promise<string> {
    if (!this.files.has(resolve(path))) throw new Error("Can't find file")
    return "";
  }

  override async stat(path: string): Promise<VfsStat> {
    if (!this.files.has(resolve(path))) throw new Error(`${path} not found`);
    return { mtimeMs: 1, isFile: true, isDirectory: false };
  }
}

describe("resolveImportTargetFilePath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vexa-module-resolution-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends a .vx extension when the import omits one", async () => {
    const importer = join(root, "main.vx");
    await writeFile(importer, "");
    const target = join(root, "utils.vx");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "./utils")).toBe(target);
  });

  it("appends a .ts extension when no .vx target exists", async () => {
    const importer = join(root, "main.vx");
    await writeFile(importer, "");
    const target = join(root, "utils.ts");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "./utils")).toBe(target);
  });

  it("prefers a TypeScript source sibling over an extensionless native executable", async () => {
    const importer = join(root, "main.ts");
    await writeFile(importer, "");
    const executable = join(root, "cli");
    const source = join(root, "cli.ts");
    await writeFile(executable, "native executable");
    await writeFile(source, "export const value = 1");

    expect(await resolveImportTargetFilePath(importer, "./cli")).toBe(source);
  });

  it("appends .ts when an extensionless module basename contains a dot", async () => {
    const importer = join(root, "main.ts");
    await writeFile(importer, "");
    const target = join(root, "declarations.shared.ts");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "./declarations.shared")).toBe(target);
  });

  it("resolves an import that already includes the extension", async () => {
    const importer = join(root, "main.vx");
    await writeFile(importer, "");
    const target = join(root, "utils.vx");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "./utils.vx")).toBe(target);
  });


  it("appends .json and .txt extensions for local asset imports", async () => {
    const importer = join(root, "main.vx");
    await writeFile(importer, "");
    const jsonTarget = join(root, "config.json");
    const textTarget = join(root, "message.txt");
    await writeFile(jsonTarget, "{}", "utf8");
    await writeFile(textTarget, "hello", "utf8");

    expect(await resolveImportTargetFilePath(importer, "./config")).toBe(jsonTarget);
    expect(await resolveImportTargetFilePath(importer, "./message")).toBe(textTarget);
  });

  it("resolves imports relative to the importing file's directory", async () => {
    const nestedDir = join(root, "nested");
    await mkdir(nestedDir);
    const importer = join(nestedDir, "main.vx");
    await writeFile(importer, "");
    const target = join(root, "shared.vx");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "../shared")).toBe(target);
  });

  it("returns null when the target file does not exist", async () => {
    const importer = join(root, "main.vx");
    await writeFile(importer, "");

    expect(await resolveImportTargetFilePath(importer, "./missing")).toBeNull();
  });
  it("uses the provided VFS instead of requiring files on disk", async () => {
    const importer = resolve("/virtual/main.vx");
    const target = resolve("/virtual/Point.vx");
    const vfs = new MemoryVfs(new Set([target]));

    expect(await resolveImportTargetFilePath(importer, "./Point", { vfs })).toBe(target);
  });

  it("resolves unsaved open sessions when a target is not visible through the VFS", async () => {
    const importer = resolve("/virtual/main.vx");
    const target = resolve("/virtual/Point.vx");
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

  it("resolves bare specifiers through absolute import mappings", async () => {
    const importer = join(root, "example", "main.vx");
    const target = join(root, "runtime", "myengine-runtime.vx");
    await mkdir(join(root, "example"), { recursive: true });
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(importer, "");
    await writeFile(target, "");

    expect(await resolveImportTargetFilePath(importer, "myengine", {
      importMappings: {
        myengine: target
      }
    })).toBe(target);
  });

});

describe("resolveNodeModulesTypingsPath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vexa-node-modules-typings-"));
    clearNodeModulesTypingsPathCache();
  });

  afterEach(async () => {
    clearNodeModulesTypingsPathCache();
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

    expect(await resolveNodeModulesTypingsPath(join(root, "main.vx"), "minimist")).toBe(dtsPath);
  });

  it("maps scoped packages to DefinitelyTyped's double-underscore package name", async () => {
    const typesDir = join(root, "node_modules", "@types", "scope__pkg");
    await mkdir(typesDir, { recursive: true });
    const dtsPath = join(typesDir, "index.d.ts");
    await writeFile(join(typesDir, "package.json"), JSON.stringify({ name: "@types/scope__pkg" }), "utf8");
    await writeFile(dtsPath, "export declare const value: string;", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.vx"), "@scope/pkg")).toBe(dtsPath);
  });

  it("finds DefinitelyTyped declarations inside pnpm's virtual store layout", async () => {
    const runtimeDir = join(root, "node_modules", "minimist");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "package.json"), JSON.stringify({ name: "minimist" }), "utf8");

    const typesDir = join(root, "node_modules", ".pnpm", "@types+minimist@1.2.5", "node_modules", "@types", "minimist");
    await mkdir(typesDir, { recursive: true });
    const dtsPath = join(typesDir, "index.d.ts");
    await writeFile(join(typesDir, "package.json"), JSON.stringify({ name: "@types/minimist" }), "utf8");
    await writeFile(dtsPath, "declare function minimist(): void; export = minimist;", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.vx"), "minimist")).toBe(dtsPath);
  });

  it("treats node: builtins like their base package name when resolving typings", async () => {
    const typesDir = join(root, "node_modules", "@types", "os");
    await mkdir(typesDir, { recursive: true });
    const dtsPath = join(typesDir, "index.d.ts");
    await writeFile(join(typesDir, "package.json"), JSON.stringify({ name: "@types/os" }), "utf8");
    await writeFile(dtsPath, "export declare function tmpdir(): string;\n", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.vx"), "node:os")).toBe(dtsPath);
  });

  it("resolves typings from package exports subpaths such as preact/hooks", async () => {
    const packageDir = join(root, "node_modules", "preact");
    await mkdir(join(packageDir, "src"), { recursive: true });
    await mkdir(join(packageDir, "hooks", "src"), { recursive: true });
    const dtsPath = join(packageDir, "hooks", "src", "index.d.ts");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "preact",
      types: "./src/index.d.ts",
      exports: {
        "./hooks": {
          types: "./hooks/src/index.d.ts",
          import: "./hooks/dist/hooks.mjs"
        }
      }
    }), "utf8");
    await writeFile(join(packageDir, "src", "index.d.ts"), "export declare const root: number;", "utf8");
    await writeFile(dtsPath, "export declare function useState<S>(value: S): [S, (value: S) => void];", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.vx"), "preact/hooks")).toBe(dtsPath);
  });

  it("prefers root package exports typings when the types field points at a missing file", async () => {
    const packageDir = join(root, "node_modules", "rxjs-like");
    await mkdir(join(packageDir, "dist", "types"), { recursive: true });
    const dtsPath = join(packageDir, "dist", "types", "index.d.ts");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "rxjs-like",
      types: "./index.d.ts",
      exports: {
        ".": {
          types: "./dist/types/index.d.ts",
          default: "./dist/index.js"
        }
      }
    }), "utf8");
    await writeFile(dtsPath, "export declare const root: number;", "utf8");

    expect(await resolveNodeModulesTypingsPath(join(root, "main.vx"), "rxjs-like")).toBe(dtsPath);
  });

  it("clears cached typings paths when requested", async () => {
    const importerPath = join(root, "main.vx");
    const initialTypesDir = join(root, "node_modules", "@types", "minimist");
    await mkdir(initialTypesDir, { recursive: true });
    const initialPath = join(initialTypesDir, "index.d.ts");
    await writeFile(join(initialTypesDir, "package.json"), JSON.stringify({ name: "@types/minimist" }), "utf8");
    await writeFile(initialPath, "export declare const initial: number;\n", "utf8");

    expect(await resolveNodeModulesTypingsPath(importerPath, "minimist")).toBe(initialPath);

    await rm(join(root, "node_modules"), { recursive: true, force: true });

    const replacementTypesDir = join(root, "node_modules", "@types", "minimist");
    await mkdir(replacementTypesDir, { recursive: true });
    const replacementPath = join(replacementTypesDir, "next.d.ts");
    await writeFile(
      join(replacementTypesDir, "package.json"),
      JSON.stringify({ name: "@types/minimist", types: "next.d.ts" }),
      "utf8"
    );
    await writeFile(replacementPath, "export declare const next: number;\n", "utf8");

    clearNodeModulesTypingsPathCache();

    expect(await resolveNodeModulesTypingsPath(importerPath, "minimist")).toBe(replacementPath);
  });
});

describe("node builtin specifier helpers", () => {
  it("strips the node: prefix only when present", () => {
    expect(stripNodeBuiltinPrefix("node:path")).toBe("path");
    expect(stripNodeBuiltinPrefix("path")).toBe("path");
    expect(stripNodeBuiltinPrefix("lodash")).toBe("lodash");
  });

  it("yields prefixed and base candidates for a node: specifier", () => {
    expect(nodeBuiltinSpecifierCandidates("node:path")).toEqual(["node:path", "path"]);
  });

  it("yields only the bare specifier by default", () => {
    expect(nodeBuiltinSpecifierCandidates("path")).toEqual(["path"]);
  });

  it("adds the node: form for a bare specifier when bidirectional", () => {
    expect(nodeBuiltinSpecifierCandidates("path", { bidirectional: true })).toEqual(["path", "node:path"]);
    // A node: specifier ignores bidirectional and still strips to the base name.
    expect(nodeBuiltinSpecifierCandidates("node:fs", { bidirectional: true })).toEqual(["node:fs", "fs"]);
  });
});
