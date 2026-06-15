import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnalysisSession } from "./analysisSession";
import { createSignatureHelp } from "./signatureHelp";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { collectAllImportedDeclarations, collectImportedTypeDeclarations, collectImportedSymbolTypes } from "./importedDeclarations";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";

function parseAmbientModule(src: string, moduleName: string): Statement[] {
  const result = parseSource(src, { language: "typescript" });
  const ns = result.ast?.body?.find(
    (statement) => statement.kind === "NamespaceStatement"
      && (statement as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: Statement[] } } | undefined;
  return ns?.body?.body ?? [];
}

describe("signature help", () => {
  it("provides function signature and active parameter index", async () => {
    const source = dedent`
      fun sum(a: int, b: int): int {
        return a + b
      }
      fun demo() {
        return sum(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 4, 15);
    expect(help).toEqual({
      signatures: [
        {
          label: "sum(a: int, b: int): int",
          parameters: [{ label: "a: int" }, { label: "b: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("provides constructor signature for new expressions", async () => {
    const source = dedent`
      class Point(val x: int, val y: int)
      fun demo() {
        return new Point(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 2, 22);
    expect(help).toEqual({
      signatures: [
        {
          label: "new Point(x: int, y: int)",
          parameters: [{ label: "x: int" }, { label: "y: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("provides signature help for static members on ambient runtime constructors", async () => {
    const source = dedent`
      fun script() {
        Date.parse("2024-01-01")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 13);
    expect(help?.signatures[0]?.label).toEqual("parse(s: string): number");
    expect(help?.signatures[0]?.parameters).toEqual([{ label: "s: string" }]);
    expect(help?.activeParameter).toEqual(0);
  });

  it("provides signature help for members on ambient runtime interface globals", async () => {
    const source = dedent`
      fun script() {
        Math.max(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 11);
    expect(help?.signatures[0]?.label).toEqual("max(...values: number[]): number");
  });

  it("provides boxed builtin member signature help with optional params and return type", async () => {
    const source = dedent`
      fun demo() {
        10.toFixed()
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 13);
    expect(help).toEqual({
      signatures: [
        {
          label: "toFixed(fractionDigits?: number): string",
          parameters: [{ label: "fractionDigits?: number" }],
          documentation: "Returns a string representing a number in fixed-point notation.\n@param fractionDigits Number of digits after the decimal point. Must be in the range 0 - 100, inclusive."
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("resolves the innermost call inside a tail/brace lambda argument", async () => {
    const source = dedent`
      fun inner(a: int, b: int): int {
        return a + b
      }
      fun outer(callback: (x: int) => void) {
      }
      fun demo() {
        outer({ value ->
          inner(1, 2)
        })
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 7, 13);
    expect(help).toEqual({
      signatures: [
        {
          label: "inner(a: int, b: int): int",
          parameters: [{ label: "a: int" }, { label: "b: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("returns null when cursor is outside invocation", async () => {
    const source = "fun demo() {\n  let value = 1\n}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    expect(await createSignatureHelp(session.ast!, session.analysis!, 1, 6)).toBeNull();
  });

  it("provides signature help for annotations", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      annotation JsName(val name: string)

      @JsName(^^^"rgba")
      fun color() {}
    `);
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, line, character);
    expect(help).toEqual({
      signatures: [
        {
          label: "JsName(val name: string)",
          parameters: [{ label: "val name: string" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("provides signature help and docs for imported class methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-signature-help-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = dedent`
      class Logger {
        /**
         * Writes a number in the output stream.
         */
        log(value: number): int { return 0 }
      }
      `;
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log(1)
      }
      `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(
      session.ast!,
      session.analysis!,
      3,
      12,
      {
        uri: pathToFileURL(helloFile).toString(),
        sourceRoots: [root]
      }
    );

    expect(help).toEqual({
      signatures: [
        {
          label: "log(value: number): int",
          parameters: [{ label: "value: number" }],
          documentation: "Writes a number in the output stream."
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("specializes generic method signature help from instantiated type", async () => {
    const source = dedent`
      class Map<K, V> {
        get(key: K): V { }
      }
      fun demo() {
        const map = new Map<string, int>()
        map.get("id")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 5, 12);
    expect(help).toEqual({
      signatures: [
        {
          label: "get(key: string): int",
          parameters: [{ label: "key: string" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("reads triple-slash documentation comments from the next declaration", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Strings {
        /// searches [sub] in [str]
        /// and returns its index or -1
        find(str: string, sub: string): int { }
      }
      fun demo() {
        const strings = new Strings()
        strings.find(^^^"abc", "b")
      }
      `);

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, line, character);
    expect(help).toEqual({
      signatures: [
        {
          label: "find(str: string, sub: string): int",
          parameters: [{ label: "str: string" }, { label: "sub: string" }],
          documentation: "searches [sub] in [str]\nand returns its index or -1"
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("reads triple-slash documentation comments for local function calls", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      /// searches [sub] in [str]
      /// and returns its index or -1
      fun demo(str: string, sub: string): int {
      }

      fun demo2() {
        demo(^^^"abc", "b")
      }
      `);

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, line, character);
    expect(help).toEqual({
      signatures: [
        {
          label: "demo(str: string, sub: string): int",
          parameters: [{ label: "str: string" }, { label: "sub: string" }],
          documentation: "searches [sub] in [str]\nand returns its index or -1"
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("specializes signature help for inherited generic methods", async () => {
    const source = dedent`
      class Base<T> {
        get(key: T): T { }
      }
      class Child extends Base<string> {
      }
      fun demo() {
        const child = new Child()
        child.get("id")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 7, 13);
    expect(help).toEqual({
      signatures: [
        {
          label: "get(key: string): string",
          parameters: [{ label: "key: string" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("provides signature help for members of a node_modules namespace", async () => {
    const MINI_DTS = dedent`
      declare function pkg(x: string): pkg.Result;
      declare namespace pkg {
        interface Result {
          value(): string;
        }
        export function helper(input: string, count: number): Result;
      }
      export = pkg;
    `;
    const root = await mkdtemp(join(tmpdir(), "vexa-sig-nm-"));
    const pkgDir = join(root, "node_modules", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "index.d.ts"), MINI_DTS, "utf8");
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg", typings: "./index.d.ts" }),
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    // line 1 (0-based), character 16 = inside the call parentheses
    const source = `import pkg from "pkg"\npkg.helper("x", 1)\n`;
    await writeFile(mainPath, source, "utf8");

    const ctx = { uri: pathToFileURL(mainPath).href, sourceRoots: [root], getSessionForFilePath: () => null };
    const baseSession = createAnalysisSession(source);
    const declarations = await collectImportedTypeDeclarations(baseSession.ast!, ctx);
    const symbolTypes = await collectImportedSymbolTypes(baseSession.ast!, ctx);
    const session = createAnalysisSession(source, declarations, symbolTypes);

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 16, ctx);
    expect(help).not.toBeNull();
    expect(help!.signatures[0]!.label).toBe("helper(input: string, count: number): Result");
    expect(help!.signatures[0]!.parameters).toEqual([
      { label: "input: string" },
      { label: "count: number" }
    ]);
    expect(help!.activeSignature).toBe(0);
    expect(help!.activeParameter).toBe(1);
  });

  it("shows all overloads for overloaded interface methods and selects the best matching signature", async () => {
    const source = dedent`
      fun demo() {
        Promise.resolve()
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 17);
    expect(help).not.toBeNull();
    expect(help!.signatures.length).toBeGreaterThan(1);

    const noArgSig = help!.signatures.find((s) => s.parameters?.length === 0);
    const valueSig = help!.signatures.find((s) => s.parameters && s.parameters.length > 0);
    expect(noArgSig).toBeTruthy();
    expect(valueSig).toBeTruthy();

    // With 0 active params, the first 0-parameter overload should be active
    expect(help!.signatures[help!.activeSignature!]?.parameters?.length ?? 0).toBe(0);
  });

  it("selects the overload whose parameter count covers the active argument position", async () => {
    const source = dedent`
      fun demo() {
        Promise.resolve(42)
      }
      `;

    const session = createAnalysisSession(source);
    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 18);
    expect(help).not.toBeNull();
    expect(help!.signatures.length).toBeGreaterThan(1);
    // With 1 active param, an overload that accepts a value should be selected
    const activeSig = help!.signatures[help!.activeSignature!];
    expect(activeSig?.parameters?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("uses the concise ambient imported signature text for node typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-sig-ambient-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const source = 'import { readFile } from "fs/promises"\nawait readFile("hello", { encoding: "utf-8" })\n';

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(nodeTypesDir, "index.d.ts"),
      dedent`
      declare module "node:events" {
        export interface Abortable {
          signal?: AbortSignal;
        }
        export interface AbortSignal {
          parent?: AbortSignal;
        }
      }

      declare module "node:fs" {
        export class Buffer {}
        export class URL {}
        export type PathLike = string | Buffer | URL;
        export type OpenMode = string;
      }

      declare module "fs/promises" {
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
      }
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
    const baseSession = createAnalysisSession(source);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      ambientModuleDeclarations: ambient.moduleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      ambient.globalDeclarations,
      ambient.moduleDeclarations,
      ambient.moduleDeclarationLocations,
      imported.importedSymbolDisplayTypes
    );

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 14);
    expect(help).not.toBeNull();
    expect(help!.signatures[0]!.label).toContain("PathLike | FileHandle");
    expect(help!.signatures[0]!.label).not.toContain("string | Buffer | URL | object");
  });

  it("provides signature help for default-imported ambient module members", async () => {
    const source = 'import util from "node:util"\nutil.format("value")\n';
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(
        `declare module "node:util" {
          export function format(value: string, inspectOptions?: { colors?: boolean }): string;
        }`,
        "node:util"
      )]
    ]);

    const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      ambientModuleDeclarations,
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 12, {
      ambientModuleDeclarations
    });
    expect(help).toEqual({
      signatures: [
        {
          label: "format(value: string, inspectOptions?: { colors?: boolean }): string",
          parameters: [
            { label: "value: string" },
            { label: "inspectOptions?: { colors?: boolean }" }
          ]
        }
      ],
      activeSignature: 0,
      activeParameter: 0
    });
  });

  it("does not expand ambient named types in default-import member signatures", async () => {
    const source = 'import util from "node:util"\nutil.formatWithOptions({}, "x")\n';
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(
        `declare module "node:util" {
          export interface InspectOptions {
            colors?: boolean;
            depth?: number | null;
          }
          export function formatWithOptions(inspectOptions: InspectOptions, format?: any, ...param: any[]): string;
        }`,
        "node:util"
      )]
    ]);

    const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      ambientModuleDeclarations,
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const help = await createSignatureHelp(session.ast!, session.analysis!, 1, 24, {
      ambientModuleDeclarations
    });
    expect(help).not.toBeNull();
    expect(help!.signatures[0]!.label).toBe("formatWithOptions(inspectOptions: InspectOptions, format?: any, ...param: any[]): string");
    expect(help!.signatures[0]!.label).not.toContain("{ colors");
  });
});
