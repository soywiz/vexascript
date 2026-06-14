import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";

function parseAmbientModule(src: string, moduleName: string): Statement[] {
  // Parse `declare module "<name>" { ... }` and return the body statements
  const result = parseSource(src, { language: "typescript" });
  const ns = result.ast?.body?.find(
    (s) => s.kind === "NamespaceStatement" && (s as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: Statement[] } } | undefined;
  return ns?.body?.body ?? [];
}

describe("collectAllImportedDeclarations — ambient module type resolution", () => {
  it("resolves named import type from direct export function in ambient module", async () => {
    const decls = parseAmbientModule(
      `declare module "myfs" {\n  export function readFile(path: string): string;\n}\n`,
      "myfs"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([["myfs", decls]]);

    const src = `import { readFile } from "myfs"`;
    const ast = parseSource(src, {}).ast!;

    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    expect(importedSymbolTypes.has("readFile")).toBe(true);
    const type = importedSymbolTypes.get("readFile")!;
    expect(type.kind).toBe("function");
  });

  it("resolves named import type from interface member via export= pattern (node:path style)", async () => {
    const nodePathDecls = parseAmbientModule(
      `declare module "node:mypath" { export = mypath; }`,
      "node:mypath"
    );
    const mypathDecls = parseAmbientModule(
      `declare module "mypath" {
  namespace mypath {
    interface PathUtils {
      join(...paths: string[]): string;
    }
  }
  const mypath: mypath.PathUtils;
  export = mypath;
}`,
      "mypath"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:mypath", nodePathDecls],
      ["mypath", mypathDecls]
    ]);

    const src = `import { join } from "node:mypath"`;
    const ast = parseSource(src, {}).ast!;

    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    expect(importedSymbolTypes.has("join")).toBe(true);
    const joinType = importedSymbolTypes.get("join")!;
    expect(joinType.kind).toBe("function");
  });

  it("resolves aliased named import (import { fn as alias })", async () => {
    const decls = parseAmbientModule(
      `declare module "simplepkg" {\n  export function doThing(x: string): void;\n}\n`,
      "simplepkg"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([["simplepkg", decls]]);

    const src = `import { doThing as myThing } from "simplepkg"`;
    const ast = parseSource(src, {}).ast!;

    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    expect(importedSymbolTypes.has("myThing")).toBe(true);
    expect(importedSymbolTypes.has("doThing")).toBe(false);
  });

  it("strips node: prefix and resolves from base module when node:X module only has re-export stub", async () => {
    const nodeDecls = parseAmbientModule(
      `declare module "node:simplepkg" { export = simplepkg; }`,
      "node:simplepkg"
    );
    const baseDecls = parseAmbientModule(
      `declare module "simplepkg" {\n  export function process(x: string): number;\n}\n`,
      "simplepkg"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:simplepkg", nodeDecls],
      ["simplepkg", baseDecls]
    ]);

    const src = `import { process } from "node:simplepkg"`;
    const ast = parseSource(src, {}).ast!;

    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    expect(importedSymbolTypes.has("process")).toBe(true);
    expect(importedSymbolTypes.get("process")!.kind).toBe("function");
  });
});
