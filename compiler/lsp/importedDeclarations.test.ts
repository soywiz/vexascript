import { describe, expect, it } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";
import { typeToString } from "compiler/analysis/types";

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

  it("preserves ambient function overloads for named imports", async () => {
    const fsDecls = parseAmbientModule(
      `declare module "node:fs" {
        export class Buffer {}
        export class URL {}
        export type PathLike = string | Buffer | URL;
      }`,
      "node:fs"
    );
    const fsPromisesDecls = parseAmbientModule(
      `declare module "fs/promises" {
        import { PathLike } from "node:fs";
        export interface FileHandle {}
        export function readFile(path: PathLike | FileHandle): Promise<Buffer>;
        export function readFile(path: PathLike | FileHandle, options: { encoding: string }): Promise<string>;
      }`,
      "fs/promises"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:fs", fsDecls],
      ["fs/promises", fsPromisesDecls]
    ]);

    const ast = parseSource(`import { readFile } from "fs/promises"`, {}).ast!;
    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    expect(importedSymbolTypes.get("readFile")?.kind).toBe("union");
    expect(typeToString(importedSymbolTypes.get("readFile")!)).toContain("(path: string | Buffer | URL | object) => Promise<Buffer>");
    expect(typeToString(importedSymbolTypes.get("readFile")!)).toContain("(path: string | Buffer | URL | object, options: { encoding: string }) => Promise<string>");
  });

  it("expands ambient object and interface types inside overload parameters", async () => {
    const fsDecls = parseAmbientModule(
      `declare module "node:fs" {
        export class Buffer {}
        export class URL {}
        export type PathLike = string | Buffer | URL;
        export type OpenMode = string;
      }`,
      "node:fs"
    );
    const eventsDecls = parseAmbientModule(
      `declare module "node:events" {
        export interface Abortable {
          signal?: AbortSignal;
        }
        export interface AbortSignal {}
      }`,
      "node:events"
    );
    const fsPromisesDecls = parseAmbientModule(
      `declare module "fs/promises" {
        import { Abortable } from "node:events";
        import { OpenMode, PathLike } from "node:fs";
        export interface FileHandle {}
        export function readFile(
          path: PathLike | FileHandle,
          options: ({ encoding?: null | undefined, flag?: OpenMode | undefined } & Abortable) | null,
        ): Promise<Buffer>;
        export function readFile(
          path: PathLike | FileHandle,
          options: ({ encoding: string, flag?: OpenMode | undefined } & Abortable) | string,
        ): Promise<string>;
      }`,
      "fs/promises"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:fs", fsDecls],
      ["node:events", eventsDecls],
      ["fs/promises", fsPromisesDecls]
    ]);

    const ast = parseSource(`import { readFile } from "fs/promises"`, {}).ast!;
    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    const rendered = typeToString(importedSymbolTypes.get("readFile")!);
    expect(rendered).toContain("{ encoding: string");
    expect(rendered).toContain("flag: string | undefined");
    expect(rendered).toContain("{ signal: object | undefined }");
    expect(rendered).toContain("{ encoding: null | undefined");
  });

  it("expands ambient global aliases referenced from imported module overloads", async () => {
    const globalDeclarations = parseSource(
      `type BufferEncoding = "utf8" | "utf-8"`,
      { language: "typescript" }
    ).ast!.body;
    const fsDecls = parseAmbientModule(
      `declare module "node:fs" {
        export type OpenMode = string;
        export type PathLike = string;
        export interface ObjectEncodingOptions {
          encoding?: BufferEncoding | null | undefined;
        }
      }`,
      "node:fs"
    );
    const eventsDecls = parseAmbientModule(
      `declare module "node:events" {
        export interface Abortable {
          signal?: AbortSignal;
        }
        export interface AbortSignal {}
      }`,
      "node:events"
    );
    const fsPromisesDecls = parseAmbientModule(
      `declare module "fs/promises" {
        import { Abortable } from "node:events";
        import { ObjectEncodingOptions, OpenMode, PathLike } from "node:fs";
        export interface FileHandle {}
        interface FlagAndOpenMode {
          flag?: OpenMode | undefined;
        }
        export function readFile(
          path: PathLike | FileHandle,
          options: (ObjectEncodingOptions & FlagAndOpenMode & Abortable) | null,
        ): Promise<string>;
        export function readFile(
          path: PathLike | FileHandle,
          options: ({ encoding: BufferEncoding, flag?: OpenMode | undefined } & Abortable) | BufferEncoding,
        ): Promise<string>;
      }`,
      "fs/promises"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:fs", fsDecls],
      ["node:events", eventsDecls],
      ["fs/promises", fsPromisesDecls]
    ]);

    const ast = parseSource(`import { readFile } from "fs/promises"`, {}).ast!;
    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations,
      ambientGlobalDeclarations: globalDeclarations
    });

    const rendered = typeToString(importedSymbolTypes.get("readFile")!);
    expect(rendered).toContain('"utf8" | "utf-8"');
  });

  it("does not recurse forever on ambient interfaces that reference themselves indirectly", async () => {
    const eventsDecls = parseAmbientModule(
      `declare module "node:events" {
        export interface AbortSignal {
          parent?: AbortSignal;
        }
        export interface Abortable {
          signal?: AbortSignal;
        }
      }`,
      "node:events"
    );
    const fsDecls = parseAmbientModule(
      `declare module "node:fs" {
        export type OpenMode = string;
        export type PathLike = string;
      }`,
      "node:fs"
    );
    const fsPromisesDecls = parseAmbientModule(
      `declare module "fs/promises" {
        import { Abortable } from "node:events";
        import { OpenMode, PathLike } from "node:fs";
        export interface FileHandle {}
        export function readFile(
          path: PathLike | FileHandle,
          options: ({ encoding: string, flag?: OpenMode | undefined } & Abortable) | string,
        ): Promise<string>;
      }`,
      "fs/promises"
    );
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:events", eventsDecls],
      ["node:fs", fsDecls],
      ["fs/promises", fsPromisesDecls]
    ]);

    const ast = parseSource(`import { readFile } from "fs/promises"`, {}).ast!;
    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });

    expect(importedSymbolTypes.get("readFile")?.kind).toBe("function");
    expect(typeToString(importedSymbolTypes.get("readFile")!)).toContain("Promise<string>");
  });

  it("resolves default import type from ambient module direct exports as a module-shaped object", async () => {
    const utilDecls = parseAmbientModule(
      `declare module "node:util" {
        export function format(value: string): string;
        export function inspect(value: unknown): string;
      }`,
      "node:util"
    );
    const ast = parseSource(`import util from "node:util"`, {}).ast!;

    const { importedSymbolTypes, importedSymbolDisplayTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations: new Map([["node:util", utilDecls]])
    });

    expect(typeToString(importedSymbolTypes.get("util")!)).toBe("{ format: (value: string) => string, inspect: (value: unknown) => string }");
    expect(importedSymbolDisplayTypes.get("util")).toBe('typeof import("node:util")');
  });

  it("reports unknown members on default imports from ambient modules", async () => {
    const utilDecls = parseAmbientModule(
      `declare module "node:util" {
        export function format(value: string): string;
      }`,
      "node:util"
    );
    const source = `import util from "node:util"\nutil.missing()\n`;
    const ast = parseSource(source, {}).ast!;

    const imported = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations: new Map([["node:util", utilDecls]])
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      new Map([["node:util", utilDecls]]),
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    expect(session.semanticIssues.map((issue: { message: string }) => issue.message)).toContain(
      "Property 'missing' does not exist on type '{ format: (value: string) => string }'"
    );
  });

  it("resolves default import type from export= namespace ambient modules", async () => {
    const nodePathDecls = parseAmbientModule(
      `declare module "node:mypath" { export = mypath; }`,
      "node:mypath"
    );
    const mypathDecls = parseAmbientModule(
      `declare module "mypath" {
        namespace mypath {
          export function join(...paths: string[]): string;
          export function dirname(path: string): string;
        }
        export = mypath;
      }`,
      "mypath"
    );
    const ast = parseSource(`import path from "node:mypath"`, {}).ast!;

    const { importedSymbolTypes } = await collectAllImportedDeclarations(ast, {
      uri: "file:///tmp/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations: new Map([
        ["node:mypath", nodePathDecls],
        ["mypath", mypathDecls]
      ])
    });

    expect(typeToString(importedSymbolTypes.get("path")!)).toBe("{ join: (...paths: string) => string, dirname: (path: string) => string }");
  });
});
