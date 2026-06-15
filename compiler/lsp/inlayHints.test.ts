import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createInlayHints } from "./inlayHints";
import { builtinType, functionType, namedType } from "compiler/analysis/types";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("inlay hints", () => {
  it("provides inferred type hints and parameter name hints", async () => {
    const source =
dedent`
      class Box {
        fun size(a: int) {
          return 1
        }
      }
      fun sum(a: int, b: int) {
        return a + b
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));
    const returnHints = hints.filter((hint) => hint.label === ": int");
    const lines = source.split("\n");

    expect(labels).toContain(": int");
    expect(returnHints).toContainEqual(
      expect.objectContaining({
        position: {
          line: 5,
          character: lines[5]!.indexOf(")") + 1
        }
      })
    );
  });

  it("provides constructor parameter name hints for new expressions", async () => {
    const source =
dedent`
      class Point(val x: int, val y: int)
      fun demo() {
        const point = new Point(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain("x: ");
    expect(labels).toContain("y: ");
  });

  it("does not emit parameter hints for arguments already passed by name", async () => {
    const source =
dedent`
      fun connect(host: string, port: number) {}
      fun demo() {
        connect(port: 8080, host: "localhost")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).not.toContain("host: ");
    expect(labels).not.toContain("port: ");
  });

  it("emits hints only for positional arguments when mixed with named ones", async () => {
    const source =
dedent`
      fun connect(host: string, port: number) {}
      fun demo() {
        connect("localhost", port: 8080)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain("host: ");
    expect(labels).not.toContain("port: ");
  });

  it("infers generic type arguments for class constructor calls", async () => {
    const source = dedent`
      class Box<T>(val value: T)
      let b = Box(42)
      let s = Box("hello")
      `;
    const session = createAnalysisSession(source);
    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));
    expect(labels).toContain(": Box<int>");
    expect(labels).toContain(": Box<string>");
  });

  it("suppresses parameter hints when parameters option is false", async () => {
    const source = dedent`
      fun add(a: int, b: int): int { return a + b }
      let result = add(1, 2)
      `;
    const session = createAnalysisSession(source);
    const range = { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } };

    const withParams = await createInlayHints(session.ast!, session.analysis!, range, {}, { parameters: true, types: false });
    const withoutParams = await createInlayHints(session.ast!, session.analysis!, range, {}, { parameters: false, types: false });

    const withLabels = withParams.map((h) => (typeof h.label === "string" ? h.label : ""));
    const withoutLabels = withoutParams.map((h) => (typeof h.label === "string" ? h.label : ""));

    expect(withLabels).toContain("a: ");
    expect(withLabels).toContain("b: ");
    expect(withoutLabels).not.toContain("a: ");
    expect(withoutLabels).not.toContain("b: ");
  });

  it("suppresses type hints when types option is false", async () => {
    const source = dedent`
      fun compute() { return 42 }
      let x = compute()
      `;
    const session = createAnalysisSession(source);
    const range = { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } };

    const withTypes = await createInlayHints(session.ast!, session.analysis!, range, {}, { parameters: false, types: true });
    const withoutTypes = await createInlayHints(session.ast!, session.analysis!, range, {}, { parameters: false, types: false });

    const withLabels = withTypes.map((h) => (typeof h.label === "string" ? h.label : ""));
    const withoutLabels = withoutTypes.map((h) => (typeof h.label === "string" ? h.label : ""));

    expect(withLabels.some((l) => l.startsWith(": "))).toBe(true);
    expect(withoutLabels.some((l) => l.startsWith(": "))).toBe(false);
  });

  it("keeps alias names in variable inlay hints for auto-awaited call results", async () => {
    const externalSource = dedent`
      type BufferAlias = {
        length: int
      }
      fun readFile(path: string): Promise<BufferAlias> {
      }
      `;
    const externalSession = createAnalysisSession(externalSource);
    const source = dedent`
      import { readFile } from "node:fs/promises"
      sync fun main() {
        val bytes = readFile("test")
      }
      `;
    const session = createAnalysisSession(
      source,
      externalSession.ast?.body ?? [],
      new Map([
        [
          "readFile",
          functionType(
            [{ name: "path", type: builtinType("string") }],
            namedType("Promise", [namedType("BufferAlias")])
          )
        ]
      ]),
      [],
      new Map(),
      new Map(),
      new Map([
        ["readFile", "(path: string) => Promise<BufferAlias>"]
      ])
    );
    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain(": BufferAlias");
    expect(labels.some((label) => label.includes("length:"))).toBe(false);
  });

  it("uses the selected ambient overload return type for variable inlay hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-inlay-ambient-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { readFile } from "fs/promises"
      sync fun main() {
        val bytes = readFile("hello")
        val hex = readFile("hello", "hex")
      }
      `;

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
          export type NonSharedBuffer = Buffer;
          export type PathLike = string | Buffer | URL;
          export type OpenMode = string;
          export type BufferEncoding = "hex" | "utf-8";
        }

        declare module "fs/promises" {
          import { Abortable } from "node:events";
          import { BufferEncoding, NonSharedBuffer, OpenMode, PathLike } from "node:fs";

          export interface FileHandle {}
          export function readFile(
            path: PathLike | FileHandle,
            options?: ({ encoding?: null | undefined, flag?: OpenMode | undefined } & Abortable) | null,
          ): Promise<NonSharedBuffer>;
          export function readFile(
            path: PathLike | FileHandle,
            options: ({ encoding: BufferEncoding, flag?: OpenMode | undefined } & Abortable) | BufferEncoding,
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

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain(": NonSharedBuffer");
    expect(labels).toContain(": string");
    expect(labels.some((label) => label.includes("PathLike"))).toBe(false);
  });
});
