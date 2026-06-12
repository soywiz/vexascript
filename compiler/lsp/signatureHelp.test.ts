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
import { collectImportedTypeDeclarations, collectImportedSymbolTypes } from "./importedDeclarations";

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
});
