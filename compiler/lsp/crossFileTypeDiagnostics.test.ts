import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectCrossFileTypeDiagnostics, collectModuleNotFoundDiagnostics } from "./crossFileTypeDiagnostics";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";

describe("cross-file type diagnostics", () => {
  it("accepts implicit VexaScript exports for imported extension properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const utilsFile = join(root, "utils.vx");
    const htmlFile = join(root, "html.vx");

    await writeFile(utilsFile, dedent`
      class Vec2(val x: number, val y: number)
      class View(var x: number, var y: number)
      var View.point: Vec2 {
        get { return Vec2(x, y) }
        set { x = newValue.x; y = newValue.y }
      }
    `, "utf8");
    const source = dedent`
      import { View, Vec2, point } from "./utils"
      val view = View(0, 0)
      view.point = Vec2(1, 2)
      val x = view.point.x
    `;
    await writeFile(htmlFile, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(htmlFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(htmlFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(collected.invalidImportedBindings.has("point")).toBe(false);
    expect(session.analysis?.getUnusedImportIdentifiers().map((identifier) => identifier.name)).toEqual([]);
    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
  });

  it("accepts implicit VexaScript exports for imported extension methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const utilsFile = join(root, "utils.vx");
    const htmlFile = join(root, "html.vx");

    await writeFile(utilsFile, dedent`
      class View {}
      class Container<T> {}
      fun View.addTo(container: Container<any>) {
      }
    `, "utf8");
    const source = dedent`
      import { View, Container, addTo } from "./utils"
      val stage = Container<any>()
      val view = View()
        ..addTo(stage)
    `;
    await writeFile(htmlFile, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(htmlFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(htmlFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(collected.invalidImportedBindings.has("addTo")).toBe(false);
    expect(session.analysis?.getUnusedImportIdentifiers().map((identifier) => identifier.name)).toEqual([]);
    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
  });

  it("reports argument count and type errors for imported class methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = dedent`
      class Logger {
        log(value: number, text: string): int { return 0 }
      }
    `;
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log(1, "ok")
        logger.log("bad", 10)
        logger.log(1)
        logger.log(1, "ok", 2)
      }
    `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'"
    );
    expect(messages).toContain(
      "Argument 2 of type 'int' is not assignable to parameter 'text' of type 'string'"
    );
    expect(messages).toContain("Expected at least 2 argument(s), but got 1");
    expect(messages).toContain("Expected at most 2 argument(s), but got 3");
    expect(messages).toContain(
      "Unexpected argument 3; function expects at most 2 argument(s)"
    );
  });

  it("reports missing constructor arguments for imported classes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    await writeFile(worldFile, "class Point(val x: number, val y: number)\n", "utf8");
    await writeFile(
      helloFile, dedent`
      import { Point } from "./world"
      fun demo() {
        new Point()
        Point()
      }
    `,
      "utf8"
    );

    const session = createAnalysisSession(dedent`
      import { Point } from "./world"
      fun demo() {
        new Point()
        Point()
      }
      `
    );
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.filter((diagnostic) => diagnostic.message === "Expected at least 2 argument(s), but got 0")
    ).toHaveLength(2);
  });

  it("accepts ambient constructor-interface globals when class-call syntax passes arguments", async () => {
    const source = dedent`
      const scores = Map<string, number>([["Ada", 3], ["Grace", 5]])
      scores.set("Linus", 8)
    `;

    const session = createAnalysisSession(
      source,
      [],
      new Map(),
      getEcmaScriptRuntimeProgram().body
    );
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: "file:///map-constructor-call.vx",
      session,
      sourceRoots: []
    });

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
  });

  it("reports importing a symbol that the target module does not export", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    await writeFile(worldFile, "class Point(val x: int)\n", "utf8");
    await writeFile(
      helloFile,
      dedent`
      import { Point, MissingPoint } from "./world"
      fun demo() {
        Point(1)
      }
      `,
      "utf8"
    );

    const session = createAnalysisSession(dedent`
      import { Point, MissingPoint } from "./world"
      fun demo() {
        Point(1)
      }
      `);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Module './world' has no exported symbol 'MissingPoint'"
    );
    expect(
      diagnostics.find((diagnostic) => diagnostic.message === "Module './world' has no exported symbol 'MissingPoint'")
        ?.range.start
    ).toEqual({ line: 0, character: 16 });
  });

  it("reports importing a missing symbol from an ambient module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const source =
      'import { readFile, UNEXISTANT_UNEXISTANT_UNEXISTANT } from "fs/promises"\n'
      + 'await readFile("hello")\n'
      + 'UNEXISTANT_UNEXISTANT_UNEXISTANT()\n';

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(nodeTypesDir, "index.d.ts"),
      dedent`
      declare module "fs/promises" {
        export function readFile(path: string): Promise<string>;
      }

      declare module "node:fs/promises" {
        export * from "fs/promises";
      }
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
    const session = createAnalysisSession(
      source,
      [],
      new Map(),
      ambient.globalDeclarations,
      ambient.moduleDeclarations,
      ambient.moduleDeclarationLocations
    );

    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root]
    });
    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      ambientGlobalDeclarations: ambient.globalDeclarations,
      ambientModuleDeclarations: ambient.moduleDeclarations
    });
    const resolvedSession = createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      ambient.globalDeclarations,
      ambient.moduleDeclarations,
      ambient.moduleDeclarationLocations,
      collected.importedSymbolDisplayTypes ?? new Map(),
      collected.invalidImportedBindings ?? new Set()
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Module 'fs/promises' has no exported symbol 'UNEXISTANT_UNEXISTANT_UNEXISTANT'"
    );
    expect(resolvedSession.semanticIssues.map((issue) => issue.message)).toContain(
      "Type 'unknown' is not callable"
    );
    expect(
      diagnostics.find((diagnostic) => diagnostic.message === "Module 'fs/promises' has no exported symbol 'UNEXISTANT_UNEXISTANT_UNEXISTANT'")
        ?.range.start
    ).toEqual({ line: 0, character: 19 });
  });

  it("reports importing a missing symbol from node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const packageDir = join(root, "node_modules", "preact");
    const helloFile = join(root, "hello.vx");

    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "preact", types: "index.d.ts" }), "utf8");
    await writeFile(
      join(packageDir, "index.d.ts"),
      "export function h(): void;\nexport type ComponentChildren = string | number;\n",
      "utf8"
    );
    await writeFile(
      helloFile,
      dedent`
      import { h, UNEXISTANT_SYMBOL } from "preact"
      fun demo() {
        h()
      }
      `,
      "utf8"
    );

    const session = createAnalysisSession(dedent`
      import { h, UNEXISTANT_SYMBOL } from "preact"
      fun demo() {
        h()
      }
    `);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Module 'preact' has no exported symbol 'UNEXISTANT_SYMBOL'"
    );
  });

  it("anchors member-call arity diagnostics on the member name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = "class Logger {\n  log(value: number): int { return 0 }\n}\n";
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log()
      }
    `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.find((diagnostic) => diagnostic.message === "Expected at least 1 argument(s), but got 0")
        ?.range.start
    ).toEqual({ line: 3, character: 9 });
  });

  it("does not duplicate same-file member-call arity diagnostics already reported by analysis", async () => {
    const source = dedent`
      class Logger {
        log(value: number): int { return 0 }
      }
      fun demo() {
        const logger = new Logger()
        logger.log()
      }
    `;

    const session = createAnalysisSession(source);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: "file:///demo.vx",
      session,
      sourceRoots: []
    });

    expect(
      diagnostics.some((diagnostic) => diagnostic.message === "Expected at least 1 argument(s), but got 0")
    ).toBe(false);
  });

  it("reports non-callable member usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = "class Logger(val level: number)\n";
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger(1)
        logger.level(10)
      }
    `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain("Property 'level' of type 'Logger' is not callable");
  });

  it("accepts string arguments for ambient aliased union parameter types from imported node-style modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const source = 'import { readFile } from "fs/promises"\nreadFile("hello")\n';

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(nodeTypesDir, "index.d.ts"),
      dedent`
      declare module "fs" {
        export class Buffer {}
        export class URL {}
        export type PathLike = string | Buffer | URL;
      }

      declare module "node:fs" {
        export * from "fs";
      }

      declare module "fs/promises" {
        import { PathLike } from "node:fs";

        export interface FileHandle {}
        export function readFile(path: PathLike | FileHandle): Promise<string>;
      }

      declare module "node:fs/promises" {
        export * from "fs/promises";
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
      ambient.moduleDeclarationLocations
    );

    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'path' of type 'PathLike | FileHandle'"
    );
  });

  it("does not report missing exports for node_modules imports that already resolved symbol types", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const pkgDir = join(root, "node_modules", "preact");
    const hooksDir = join(pkgDir, "hooks");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { render } from "preact"
      import { useState } from "preact/hooks"

      const [count, setCount] = useState(0)
      setCount(count + 1)
      render(count, count)
    `;

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await mkdir(join(hooksDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "preact",
        types: "src/index.d.ts",
        exports: {
          ".": { types: "./src/index.d.ts" },
          "./hooks": { types: "./hooks/src/index.d.ts" }
        }
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "src", "index.d.ts"), "export function render(vnode: unknown, parent: unknown): void;\n", "utf8");
    await writeFile(
      join(hooksDir, "src", "index.d.ts"),
      dedent`
        export type Dispatch<A> = (value: A) => void;
        export type StateUpdater<S> = S | ((prevState: S) => S);
        export function useState<S>(initialState: S | (() => S)): [S, Dispatch<StateUpdater<S>>];
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Module 'preact/hooks' has no exported symbol 'useState'"
    );
  });

  it("does not type-check member calls resolved from node_modules declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const pkgDir = join(root, "node_modules", "pixi.js");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Application, Graphics, View } from "pixi.js"

      val app = Application()
      await app.init({
        width: 480,
        height: 320,
        resolution: 1,
        antialias: true,
      })

      val stage = app.stage
      val badge = Graphics()
      badge.beginFill(0xff6b35)
      badge.drawRoundedRect(-110, -64, 220, 128, 28)
      stage.addChild(badge)
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pixi.js", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export type ColorSource = string | number;
        export interface ApplicationOptions {
          width?: number;
          height?: number;
          resolution?: number;
          antialias?: boolean;
        }
        export class View {
          x: number;
          y: number;
        }
        export class Container<C extends View = View> extends View {
          addChild<U extends View[]>(...children: U): unknown;
        }
        export class Graphics extends Container {
          beginFill(color: ColorSource): this;
          drawRoundedRect(...args: Parameters<GraphicsContext["roundRect"]>): this;
        }
        export interface GraphicsContext {
          roundRect(x: number, y: number, width: number, height: number, radius: number): void;
        }
        export class Application {
          stage: Container;
          init(options: Partial<ApplicationOptions>): Promise<void>;
        }
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
  });

  it("accepts ambient imported overloads selected by an options object argument", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
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
      declare module "fs" {
        export class Buffer {}
        export class URL {}
        export type PathLike = string | Buffer | URL;
        export type OpenMode = string;
      }

      declare module "node:fs" {
        export * from "fs";
      }

      declare module "node:events" {
        export interface Abortable {
          signal?: AbortSignal;
        }
        export interface AbortSignal {}
      }

      declare module "fs/promises" {
        import { Abortable } from "node:events";
        import { PathLike } from "node:fs";
        import { OpenMode } from "node:fs";

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

      declare module "node:fs/promises" {
        export * from "fs/promises";
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
      ambient.moduleDeclarationLocations
    );

    expect(session.semanticIssues.map((issue) => issue.message)).toEqual([]);

    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(mainPath).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics).toEqual([]);
  });

  it("supports variadic imported class methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = "class Logger {\n  log(...values: number[]): int { return 0 }\n}\n";
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        logger.log()
        logger.log(1, 2, 3)
        logger.log(1, "bad")
      }
    `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).not.toContain("Expected at most 1 argument(s), but got 3");
    expect(messages).toContain(
      "Argument 2 of type 'string' is not assignable to parameter 'values' of type 'number[]'"
    );
  });

  it("reports cross-file incompatible assignment to class member", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = "class Point(val y: int)\n";
    const helloSource = dedent`
      import { Point } from "./world"
      fun demo() {
        const point = new Point(1)
        point.y = "test"
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("specializes generic method arguments and return diagnostics across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = dedent`
      class Map<K, V> {
        get(key: K): V { }
      }
      
`;
    const helloSource = dedent`
      import { Map } from "./world"
      fun demo() {
        const map = new Map<string, int>()
        const ok: int = map.get("id")
        const badArg: int = map.get(1)
        const badReturn: string = map.get("id")
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain(
      "Argument 1 of type 'int' is not assignable to parameter 'key' of type 'string'"
    );
  });

  it("specializes inherited generic method arguments across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = dedent`
      class Base<T> {
        get(key: T): T { }
      }
      class Child extends Base<string> {
      }
      
`;
    const helloSource = dedent`
      import { Child } from "./world"
      fun demo() {
        const child = new Child()
        const ok: string = child.get("id")
        const badArg: string = child.get(1)
      }
      
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message);

    expect(messages).toContain(
      "Argument 1 of type 'int' is not assignable to parameter 'key' of type 'string'"
    );
  });

  it("reports an error when the imported module file does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const helloFile = join(root, "hello.vx");

    const helloSource = dedent`
      import { milliseconds, delay } from "../testFixtures/unexistant_file.vx"
      class Demo {
        var x = 0.0
      }
    `;

    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectModuleNotFoundDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session
    });

    expect(diagnostics.map((d) => d.message)).toContain(
      "Cannot find module '../testFixtures/unexistant_file.vx'"
    );
    const diag = diagnostics.find((d) => d.message === "Cannot find module '../testFixtures/unexistant_file.vx'");
    expect(diag?.range.start.line).toEqual(0);
  });

  it("does not report module-not-found for a bare specifier resolved via node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const pkgDir = join(root, "node_modules", "mylib");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "index.d.ts"), "export declare function hello(): void;\n", "utf8");
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "mylib", types: "index.d.ts" }), "utf8");
    const mainFile = join(root, "main.vx");
    const source = 'import { hello } from "mylib"\n';
    await writeFile(mainFile, source, "utf8");

    const session = createAnalysisSession(source);
    const diagnostics = await collectModuleNotFoundDiagnostics({
      uri: pathToFileURL(mainFile).toString(),
      session
    });

    expect(diagnostics.map((d) => d.message)).not.toContain("Cannot find module 'mylib'");
  });

  it("reports module-not-found for a bare specifier not in node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const mainFile = join(root, "main.vx");
    const source = 'import { foo } from "nonexistent-package"\n';
    await writeFile(mainFile, source, "utf8");

    const session = createAnalysisSession(source);
    const diagnostics = await collectModuleNotFoundDiagnostics({
      uri: pathToFileURL(mainFile).toString(),
      session
    });

    expect(diagnostics.map((d) => d.message)).toContain("Cannot find module 'nonexistent-package'");
  });

  it("does not report module-not-found when a node: builtin is available via the base ambient module name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const mainFile = join(root, "main.vx");
    const source = 'import { tmpdir } from "node:os"\n';
    await writeFile(mainFile, source, "utf8");

    const session = createAnalysisSession(source, [], new Map(), [], new Map([["os", []]]));
    const diagnostics = await collectModuleNotFoundDiagnostics({
      uri: pathToFileURL(mainFile).toString(),
      session
    });

    expect(diagnostics.map((d) => d.message)).not.toContain("Cannot find module 'node:os'");
  });

  it("reports cross-file call errors nested in arrow-function expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-types-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = "class Logger { log(value: number): int { return 0 } }\n";
    const helloSource = dedent`
      import { Logger } from "./world"
      fun demo() {
        const logger = new Logger()
        const invoke = () => logger.log("bad")
      }
    `.trimEnd() + "\n";

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileTypeDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'"
    );
  });
});
