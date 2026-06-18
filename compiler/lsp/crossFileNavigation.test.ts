import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, readFile, tmpdir, writeFile } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { collectAllImportedDeclarations, collectImportedSymbolTypes, collectImportedTypeDeclarations } from "./importedDeclarations";
import {
  resolveDefinitionAcrossFiles,
  resolveDefinitionWithLocalFallback,
  resolveMemberHoverAcrossFiles,
  resolveHoverWithLocalFallback,
  resolvePrepareRenameAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import { resolveImportPathHover } from "./importPathNavigation";
import { pathToUri } from "./importFixes";
import {
  ensureEcmaScriptRuntimeProgram,
  getEcmaScriptRuntimeDeclarationFilePath,
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath
} from "compiler/runtime/ecmascriptDeclarations";
import { Vfs } from "compiler/vfs";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";
import { findAmbientNamedExportRange } from "./crossFileContext";

class MyVfs extends Vfs {
    constructor(public virtualDomPath: string, public domSource: string) {
      super()
    }

    override async readFile(filePath: string) {
      if (filePath !== this.virtualDomPath) throw new Error()
      return this.domSource
    }
    override async stat(filePath: string) {
      if (filePath !== this.virtualDomPath) throw new Error()
      return { mtimeMs: 0, isFile: true, isDirectory: false }
    }
}

function parseAmbientModule(src: string, moduleName: string): Statement[] {
  const result = parseSource(src, { language: "typescript" });
  const namespace = result.ast?.body.find(
    (statement) =>
      statement.kind === "NamespaceStatement" &&
      (statement as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: Statement[] } } | undefined;
  return namespace?.body?.body ?? [];
}

describe("cross-file navigation", () => {
  it("resolves go-to-definition from imported symbol usage to original declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun demo() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 2,
      character: 15,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });
  });

  it("navigates builtin annotations to the dedicated VexaScript runtime declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = '@JsName("renamed")\nfun demo() {}\n';

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 0,
      character: 2,
      session,
      sourceRoots: [root]
    });

    expect(location?.uri).toBe(pathToFileURL(getVexaScriptRuntimeDeclarationFilePath()).toString());
  });

  it("resolves go-to-definition for member access inside a trailing-lambda body", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "other.vx");

    const source = dedent`
      class TimeSpan(val ms: number)
      fun delay(time: TimeSpan): Promise<T> => new Promise { resolve, reject ->
        setTimeout(resolve, time.ms)
      }
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    // Cursor on `ms` in `time.ms`, which lives inside the `new Promise { ... }`
    // trailing lambda body.
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 2,
      character: source.split("\n")[2]!.indexOf(".ms") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(file).toString(),
      range: {
        start: { line: 0, character: 19 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("resolves merged node_modules class members from class declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-merged-members-"));
    const pkgDir = join(root, "node_modules", "pkg");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Widget } from "pkg"

      fun demo() {
        val widget = new Widget()
        widget.drawRoundedRect(0, 0, 10, 20, 5)
        widget.x = 1
      }
    `;
    const pkgSource = dedent`
      export interface Base {
      }

      export declare class Base {
        x: number;
      }

      export interface Widget extends Base {
      }

      export declare class Widget extends Base {
        drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): this;
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pkg",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
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

    const lines = source.split("\n");
    const pkgLines = pkgSource.split("\n");
    const methodLine = lines.findIndex((line) => line.includes("widget.drawRoundedRect"));
    const propertyLine = lines.findIndex((line) => line.includes("widget.x = 1"));
    const methodCharacter = lines[methodLine]!.indexOf("drawRoundedRect") + 2;
    const propertyCharacter = lines[propertyLine]!.indexOf(".x") + 2;
    const methodDefinitionLine = pkgLines.findIndex((line) => line.includes("drawRoundedRect"));
    const propertyDefinitionLine = pkgLines.findIndex((line) => line.includes("x: number"));

    const methodHover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: methodLine,
      character: methodCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const methodDefinition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: methodLine,
      character: methodCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const propertyHover = await resolveHoverWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: propertyLine,
      character: propertyCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const propertyDefinition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: propertyLine,
      character: propertyCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect((methodHover?.contents as { value?: string } | undefined)?.value).toContain("drawRoundedRect");
    expect((methodHover?.contents as { value?: string } | undefined)?.value).toContain("radius: number");
    expect(methodDefinition?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(methodDefinition?.range.start.line).toBe(methodDefinitionLine);

    expect((propertyHover?.contents as { value?: string } | undefined)?.value).toContain("x: number");
    expect(propertyDefinition?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(propertyDefinition?.range.start.line).toBe(propertyDefinitionLine);
  });

  it("navigates node_modules members inherited through qualified namespace mixins", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-mixin-members-"));
    const pkgDir = join(root, "node_modules", "pixi-like");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Container } from "pixi-like"

      fun demo(stage: Container) {
        stage.addChildAt(0)
      }
    `;
    const pkgSource = dedent`
      export interface ChildrenHelperMixin {
        addChildAt(index: number): void;
      }

      declare global {
        namespace PixiMixins {
          interface Container extends ChildrenHelperMixin {}
        }
      }

      export interface Container extends PixiMixins.Container {}

      export declare class Container {
      }

      export { };
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "pixi-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
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

    const lines = source.split("\n");
    const pkgLines = pkgSource.split("\n");
    const memberLine = lines.findIndex((line) => line.includes("stage.addChildAt"));
    const memberCharacter = lines[memberLine]!.indexOf("addChildAt") + 2;
    const definitionLine = pkgLines.findIndex((line) => line.includes("addChildAt"));

    const definition = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: memberLine,
      character: memberCharacter,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(definition?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(definition?.range.start.line).toBe(definitionLine);
  });

  it("resolves go-to-definition from member access to class member declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 20 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("resolves go-to-definition from operator usage to the operator declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "point.vx");

    const source = dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point {
          return new Point(this.x + other.x, this.y + other.y)
        }
      }
      fun demo() {
        let p = new Point(1, 2)
        let q = new Point(3, 4)
        let r = p + q
      }
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 8,
      character: 12,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(file).toString(),
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 11 }
      }
    });
  });

  it("resolves go-to-definition from a cross-file operator usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "other.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class Point(val x: number, val y: number)
      fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)
      `;
    const mainSource =
      'import { Point, operator+ } from "./other"\n' +
      "const sum = Point(1, 2) + Point(3, 4)\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, externalDeclarations);

    // Cursor on the `+` operator of `Point(1, 2) + Point(3, 4)`.
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(") + ") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 10 },
        end: { line: 1, character: 19 }
      }
    });
  });

  it("resolves go-to-definition from a cross-file extension property usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "other.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class TimeSpan(val ms: number)
      val number.seconds: TimeSpan => TimeSpan(this * 1000.0)
      `;
    const mainSource =
      'import { TimeSpan, seconds } from "./other"\n' +
      "const span = 1.seconds\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, externalDeclarations);

    // Cursor on `seconds` in `1.seconds`.
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(".seconds") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 11 },
        end: { line: 1, character: 18 }
      }
    });
  });

  it("resolves inherited imported receiver extension properties and hovers them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const lib = join(root, "lib.vx");
    const main = join(root, "main.vx");

    const libSource = dedent`
      export class View(var x: number, var y: number)
      export class Graphics extends View
    `;
    const marked = sourceWithCursor(dedent`
      import { View, Graphics } from "./lib"

      class Vec2(val x: number, val y: number)

      /// World-space point.
      var View.point: Vec2 {
        get => Vec2(x, y)
      }

      val badge = Graphics(1, 2)
      badge.^^^point
    `);

    await writeFile(lib, libSource, "utf8");
    await writeFile(main, marked.source, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(marked.source);
    const resolved = await collectAllImportedDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      marked.source,
      resolved.externalDeclarations,
      resolved.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      resolved.importedSymbolDisplayTypes,
      resolved.invalidImportedBindings
    );

    const location = await resolveDefinitionWithLocalFallback({
      uri,
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveHoverWithLocalFallback({
      uri,
      line: marked.line,
      character: marked.character,
      session,
      sourceRoots: [root]
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(uri);
    expect(location?.range.start.line).toBe(5);
    expect(location?.range.start.character).toBe(9);
    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("point: Vec2");
    expect((hover?.contents as { value?: string } | undefined)?.value).toContain("World-space point.");
  });

  it("resolves go-to-definition from a cross-file extension method usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "other.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class Point(val x: number, val y: number)
      fun Point.magnitude(): number => x
      `;
    const mainSource =
      'import { Point, magnitude } from "./other"\n' +
      "const m = Point(1, 2).magnitude()\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, externalDeclarations);

    // Cursor on `magnitude` in `Point(1, 2).magnitude()`.
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(".magnitude") + 2,
      session,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 10 },
        end: { line: 1, character: 19 }
      }
    });
  });

  it("resolves go-to-definition from a chain extension method usage to the imported declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const other = join(root, "utils.vx");
    const main = join(root, "main.vx");

    const otherSource = dedent`
      class View {}
      class Graphics extends View {}
      class Container<T> {}
      var View.point: number {
        get { return 0 }
        set { }
      }
      fun View.addTo(container: Container<any>) {}
      `;
    const mainSource =
      'import { Graphics, Container, point, addTo } from "./utils"\n' +
      "const stage = Container<any>()\n" +
      "const view = Graphics()\n" +
      "  ..point = 1\n" +
      "  ..addTo(stage)\n";

    await writeFile(other, otherSource, "utf8");
    await writeFile(main, mainSource, "utf8");

    const uri = pathToFileURL(main).toString();
    const baseSession = createAnalysisSession(mainSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });
    const session = createAnalysisSession(
      mainSource,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    const lines = mainSource.split("\n");
    const pointLine = lines[3]!;
    const addToLine = lines[4]!;
    const pointLocation = await resolveDefinitionAcrossFiles({
      uri,
      line: 3,
      character: pointLine.indexOf("point") + "point".length,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });
    const location = await resolveDefinitionAcrossFiles({
      uri,
      line: 4,
      character: addToLine.indexOf("addTo") + 1,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });
    const locationAtTokenEnd = await resolveDefinitionAcrossFiles({
      uri,
      line: 4,
      character: addToLine.indexOf("addTo") + "addTo".length,
      session,
      sourceRoots: [root],
      getSessionForFilePath: (filePath) => filePath === other ? createAnalysisSession(otherSource) : null
    });

    const expectedLocation = {
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 7, character: 9 },
        end: { line: 7, character: 14 }
      }
    };
    expect(pointLocation).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 3, character: 9 },
        end: { line: 3, character: 14 }
      }
    });
    expect(location).toEqual(expectedLocation);
    expect(locationAtTokenEnd).toEqual(expectedLocation);
  });

  it("provides hover info for primary constructor members", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "world.vx");
    const source = "class MyPoint(const x: number, const y: number) { }\n";

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 0,
      character: 20,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "x: number"
    });
    expect(hover?.range).toEqual({
      start: { line: 0, character: 20 },
      end: { line: 0, character: 21 }
    });
  });

  it("provides hover info for imported class member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "y: number"
    });
    expect(hover?.range).toEqual({
      start: { line: 3, character: 8 },
      end: { line: 3, character: 9 }
    });
  });

  it("infers hover info for getter shorthand class properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = dedent`
      class Adler32 {
        private checksum = 1
        value => checksum
      }
      val adler = Adler32()
      adler.value
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 5,
      character: 8,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "value: int"
    });
  });

  it("resolves hover and definition for boxed Number members on int receivers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = dedent`
      class Adler32 {
        private checksum = 1
        value => checksum
      }
      val adler = Adler32()
      adler.value.valueOf()
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 5,
      character: source.split("\n")[5]!.indexOf("valueOf") + 1,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 5,
      character: source.split("\n")[5]!.indexOf("valueOf") + 1,
      session,
      sourceRoots: [root]
    });

    expect(definition?.uri).toBe(pathToFileURL(await getEcmaScriptRuntimeDeclarationFilePath()).toString());
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "valueOf: () => number\n\nReturns the primitive value of the specified object."
    });
  });

  it("resolves definition and hover for imported object type alias members", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const scenariosPath = join(root, "scenarios.vx");
    const mainPath = join(root, "main.vx");

    const scenariosSource = dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `;
    const mainSource = dedent`
      import { Scenario } from "./scenarios.vx"
      function lex(source: string) {}
      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.source)
      }
    `;

    await writeFile(scenariosPath, scenariosSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, externalDeclarations, importedSymbolTypes);

    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".source") + 2,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".source") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition).toEqual({
      uri: pathToFileURL(scenariosPath).toString(),
      range: {
        start: { line: 2, character: 2 },
        end: { line: 2, character: 8 }
      }
    });
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "source: string"
    });
  });

  it("resolves definition and hover for imported class members after an 'is' smart-cast", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-smart-cast-"));
    const astPath = join(root, "ast.vx");
    const mainPath = join(root, "optimizer.vx");
    const astSource = dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      export class UnaryExpr(val operator: string, val operand: NumberExpr | UnaryExpr) {
        readonly kind = "unary"
      }
    `;
    const mainSource = dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"
      export function foldConstants(expression: NumberExpr | UnaryExpr): NumberExpr | UnaryExpr {
        if (expression is UnaryExpr) {
          expression.operator
        }
        return expression
      }
    `;

    await writeFile(astPath, astSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, externalDeclarations, importedSymbolTypes);

    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition).toEqual({
      uri: pathToFileURL(astPath).toString(),
      range: {
        start: { line: 3, character: 27 },
        end: { line: 3, character: 35 }
      }
    });
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "operator: string"
    });
  });

  it("resolves definition and hover for imported class members after an 'instanceof' smart-cast", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-smart-cast-instanceof-"));
    const astPath = join(root, "ast.vx");
    const mainPath = join(root, "optimizer.vx");
    const astSource = dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      export class UnaryExpr(val operator: string, val operand: NumberExpr | UnaryExpr) {
        readonly kind = "unary"
      }
    `;
    const mainSource = dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"
      export function foldConstants(expression: NumberExpr | UnaryExpr): NumberExpr | UnaryExpr {
        if (expression instanceof UnaryExpr) {
          expression.operator
        }
        return expression
      }
    `;

    await writeFile(astPath, astSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, externalDeclarations, importedSymbolTypes);

    const definition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2,
      session,
      sourceRoots: [root]
    });

    expect(definition).toEqual({
      uri: pathToFileURL(astPath).toString(),
      range: {
        start: { line: 3, character: 27 },
        end: { line: 3, character: 35 }
      }
    });
    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "operator: string"
    });
  });

  it("resolves DOM type and member definitions from tsconfig lib declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-dom-"));
    const file = join(root, "main.vx");
    const source = dedent`
      fun createDocument(): Document => document
      const root: HTMLElement = createDocument().createElement("main")
      root.className
    `;
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["es2025", "dom"] } }), "utf8");
    await writeFile(file, source, "utf8");

    const ambientDeclarations = (await ensureDomProgram()).body;
    const session = createAnalysisSession(source, [], new Map(), ambientDeclarations);

    const typeDefinition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 1,
      character: 14,
      session,
      sourceRoots: [root]
    });
    const memberDefinition = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 2,
      character: 9,
      session,
      sourceRoots: [root]
    });
    const memberHover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 2,
      character: 9,
      session,
      sourceRoots: [root]
    });

    expect(typeDefinition?.uri).toBe(pathToFileURL(getDomDeclarationFilePath()).toString());
    expect(memberDefinition?.uri).toBe(pathToFileURL(getDomDeclarationFilePath()).toString());
    expect(memberHover?.contents).toEqual({
      kind: "plaintext",
      value: "className: string\n\nThe **string** property of the of the specified element.\n\n[MDN Reference](https://developer.mozilla.org/docs/Web/API/Element/className)"
    });
  });

  it("resolves aliased imported class member definitions through the shared declaration resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = dedent`
      import { MyPoint as P } from "./world"
      fun demo() {
        const point = new P()
        point.x
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 20 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("provides specialized hover info for generic member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "generic.vx");
    const source = dedent`
      class Map<K, V> {
        a: K
        b: V
      }
      fun demo() {
        const map = new Map<string, int>()
        map.a
      }
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 6,
      character: 7,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "a: string"
    });
    expect(hover?.range).toEqual({
      start: { line: 6, character: 6 },
      end: { line: 6, character: 7 }
    });
  });

  it("provides hover info for inherited generic member access across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      class Base<T> {
        value: T
      }
      class Child extends Base<string> {
      }
      `;
    const sourceB = dedent`
      import { Child } from "./world"
      fun demo() {
        const child = new Child()
        child.value
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "value: string"
    });
    expect(hover?.range).toEqual({
      start: { line: 3, character: 8 },
      end: { line: 3, character: 13 }
    });
  });

  it("includes triple-slash documentation in cross-file member hover", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      class Point {
        /// The x coordinate.
        x: number
        /// The y coordinate.
        y: number
      }
      `;
    const sourceB = dedent`
      import { Point } from "./world"
      fun demo() {
        const point = new Point()
        point.x
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "x: number\n\nThe x coordinate."
    });
  });

  it("finds references across importer files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");
    const fileC = join(root, "c.vx");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun first() {\n  return new Point()\n}\n";
    const sourceC = "import { Point } from \"./a\"\nfun second() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");
    await writeFile(fileC, sourceC, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 2,
        character: 15,
        session: sessionB,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 18 }
          }
        },
        {
          uri: pathToFileURL(fileC).toString(),
          range: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 18 }
          }
        }
      ])
    );
  });

  it("finds annotation references from the declaration position in the same file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "main.vx");
    const source = dedent`
      annotation DemoTag(val label: string)
      @DemoTag("hello")
      @DemoTag("bye")
      fun demo() {}
      `;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(file).toString(),
        line: 0,
        character: 13,
        session,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual([
      {
        uri: pathToFileURL(file).toString(),
        range: {
          start: { line: 0, character: 11 },
          end: { line: 0, character: 18 }
        }
      },
      {
        uri: pathToFileURL(file).toString(),
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 8 }
        }
      },
      {
        uri: pathToFileURL(file).toString(),
        range: {
          start: { line: 2, character: 1 },
          end: { line: 2, character: 8 }
        }
      }
    ]);
  });

  it("finds member references across files from usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 3,
        character: 8,
        session: sessionB,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 0, character: 20 },
            end: { line: 0, character: 21 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 3, character: 8 },
            end: { line: 3, character: 9 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 4, character: 8 },
            end: { line: 4, character: 9 }
          }
        }
      ])
    );
    expect(
      locations.some((location) =>
        location.uri === pathToFileURL(fileB).toString() &&
        location.range.start.line === 5 &&
        location.range.start.character === 8
      )
    ).toBe(false);
  });

  it("finds member references across files from declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileA).toString(),
        line: 0,
        character: 20,
        session: sessionA,
        sourceRoots: [root]
      },
      false
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 3, character: 8 },
            end: { line: 3, character: 9 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 4, character: 8 },
            end: { line: 4, character: 9 }
          }
        }
      ])
    );
  });

  it("finds member references for instantiated generic classes across files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      class Map<K, V> {
        a: K
        b: V
      }
      `;
    const sourceB = dedent`
      import { Map } from "./world"
      fun demo() {
        const map = new Map<string, int>()
        map.a
        map.a
        map.b
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 3,
        character: 7,
        session: sessionB,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 3 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 3, character: 6 },
            end: { line: 3, character: 7 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 4, character: 6 },
            end: { line: 4, character: 7 }
          }
        }
      ])
    );
    expect(
      locations.some((location) =>
        location.uri === pathToFileURL(fileB).toString() &&
        location.range.start.line === 5 &&
        location.range.start.character === 6
      )
    ).toBe(false);
  });

  it("renames symbol across declaration and importer usages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint {}\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  return new MyPoint()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 2,
        character: 16,
        session: sessionB,
        sourceRoots: [root]
      },
      "Point2"
    );

    expect(edit?.changes).toEqual({
      [pathToFileURL(fileA).toString()]: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 }
          },
          newText: "Point2"
        }
      ],
      [pathToFileURL(fileB).toString()]: [
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 16 }
          },
          newText: "Point2"
        },
        {
          range: {
            start: { line: 2, character: 13 },
            end: { line: 2, character: 20 }
          },
          newText: "Point2"
        }
      ]
    });
  });

  it("renames local function parameter symbols in the same file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "local.vx");
    const source = `fun demo(arg: number) {
  return arg + arg
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(file).toString(),
        line: 1,
        character: 10,
        session,
        sourceRoots: [root]
      },
      "value"
    );

    expect(edit?.changes).toEqual({
      [pathToFileURL(file).toString()]: [
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 12 }
          },
          newText: "value"
        },
        {
          range: {
            start: { line: 1, character: 9 },
            end: { line: 1, character: 12 }
          },
          newText: "value"
        },
        {
          range: {
            start: { line: 1, character: 15 },
            end: { line: 1, character: 18 }
          },
          newText: "value"
        }
      ]
    });
  });

  it("renames from the parameter declaration position even without extra files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "decl.vx");
    const source = `fun test3(a: string, b: int, arg3: int, arg4: int) {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(file).toString(),
        line: 0,
        character: 10,
        session,
        sourceRoots: [root]
      },
      "renamed"
    );

    expect(edit?.changes).toEqual({
      [pathToFileURL(file).toString()]: [
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 0, character: 11 }
          },
          newText: "renamed"
        }
      ]
    });
  });

  it("finds references for imported type names used in implements clauses", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    const sourceA = "class Base\n";
    const sourceB = dedent`
      import { Base } from "./a"
      class Child implements Base {
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileA).toString(),
        line: 0,
        character: 7,
        session: sessionA,
        sourceRoots: [root]
      },
      true
    );

    expect(locations).toEqual(
      expect.arrayContaining([
        {
          uri: pathToFileURL(fileA).toString(),
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 10 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 13 }
          }
        },
        {
          uri: pathToFileURL(fileB).toString(),
          range: {
            start: { line: 1, character: 23 },
            end: { line: 1, character: 27 }
          }
        }
      ])
    );
  });

  it("renames interface declarations across imports and implements clauses", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = dedent`
      interface Readable {
        say(): int
      }
      `;
    const sourceB = dedent`
      import { Readable } from "./world"
      class Map implements Readable {
        say(): int {
          return 1
        }
      }
      `;

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(fileA).toString(),
        line: 0,
        character: 12,
        session: sessionA,
        sourceRoots: [root]
      },
      "Speakable"
    );

    expect(edit?.changes?.[pathToFileURL(fileA).toString()]).toEqual(
      expect.arrayContaining([
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 0, character: 18 }
          },
          newText: "Speakable"
        }
      ])
    );
    expect(edit?.changes?.[pathToFileURL(fileB).toString()]).toEqual(
      expect.arrayContaining([
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 17 }
          },
          newText: "Speakable"
        },
        {
          range: {
            start: { line: 1, character: 21 },
            end: { line: 1, character: 29 }
          },
          newText: "Speakable"
        }
      ])
    );
  });
  it("navigates array member definitions to the ECMAScript runtime declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-"));
    const file = join(root, "runtime.vx");
    const source = "fun demo() {\n  [1, 2].map { it * 2 }\n}\n";

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 1,
      character: 10,
      session,
      sourceRoots: [root]
    });

    const runtimeFilePath = await getEcmaScriptRuntimeDeclarationFilePath();
    expect(location?.uri).toBe(pathToFileURL(runtimeFilePath).toString());
    const runtimeLines = (await readFile(runtimeFilePath, "utf8")).split("\n");
    const lineText = runtimeLines[location?.range.start.line ?? -1] ?? "";
    expect(lineText).toContain("map");
  });

  it("resolves go-to-definition on import path string to the imported file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-path-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Foo\n", "utf8");
    await writeFile(fileB, `import { Foo } from "./a"\n`, "utf8");

    const sessionB = createAnalysisSession(`import { Foo } from "./a"\n`);
    // cursor on the "./a" string (line 0, character 21 is inside the string)
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 0,
      character: 21,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
  });

  it("resolves hover on import path string shows resolved file path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-hover-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Foo\n", "utf8");
    await writeFile(fileB, `import { Foo } from "./a"\n`, "utf8");

    const sessionB = createAnalysisSession(`import { Foo } from "./a"\n`);
    const hover = await resolveImportPathHover({
      uri: pathToFileURL(fileB).toString(),
      line: 0,
      character: 21,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover).not.toBeNull();
    expect(hover?.contents).toMatchObject({ kind: "plaintext" });
    expect((hover?.contents as { value: string }).value).toContain(fileA);
  });

  it("resolves go-to-definition from a virtual-workspace import string to the imported file", async () => {
    const mainPath = "/demo.vx";
    const pointPath = "/Point.vx";
    const mainSource = 'import { Point } from "./Point"\n';
    const pointSource = "class Point(val x: number, val y: number)\n";
    const sessions = new Map([
      [mainPath, createAnalysisSession(mainSource)],
      [pointPath, createAnalysisSession(pointSource)]
    ]);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("./Point") + 2,
      session: sessions.get(mainPath)!,
      sourceRoots: [],
      getSessionForFilePath: (filePath) => sessions.get(filePath) ?? null
    });

    expect(location).toEqual({
      uri: pathToFileURL(pointPath).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    });
  });

  it("resolves imported class calls and operators in a virtual workspace", async () => {
    const mainPath = "/demo.vx";
    const pointPath = "/Point.vx";
    const pointSource = dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point => Point(x + other.x, y + other.y)
      }
      `;
    const mainSource = 'import { Point, operator+ } from "./Point"\nval point = Point(1, 2) + Point(3, 4)\n';
    const pointSession = createAnalysisSession(pointSource);
    const baseSession = createAnalysisSession(mainSource);
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [],
      getSessionForFilePath: (filePath) => filePath === pointPath ? pointSession : null
    });
    const mainSession = createAnalysisSession(mainSource, externalDeclarations);

    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'unknown' and 'unknown'"
    );
    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'Point' and 'Point'"
    );

    const hover = mainSession.analysis!.getHoverAt(1, mainSource.split("\n")[1]!.indexOf(") + ") + 3);
    expect(hover?.contents).toBe("method operator+: (other: Point) => Point");

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf("Point(1") + 1,
      session: mainSession,
      sourceRoots: [],
      getSessionForFilePath: (filePath) => filePath === pointPath ? pointSession : null
    });

    expect(location).toEqual({
      uri: pathToFileURL(pointPath).toString(),
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 }
      }
    });
  });

  it("resolves imported extension operators in a virtual workspace without requiring export", async () => {
    const mainPath = "/demo.vx";
    const timePath = "/time.vx";
    const timeSource = dedent`
      class TimeSpan(val ms: number)
      val number.seconds => TimeSpan(this * 1000.0)
      val number.milliseconds => TimeSpan(this)
      fun TimeSpan.operator+(other: TimeSpan): TimeSpan => TimeSpan(ms + other.ms)
      `;
    const mainSource = dedent`
      import { TimeSpan, seconds, milliseconds, operator+ } from "./time"
      val duration = 0.25.seconds + 10.milliseconds
      `;
    const timeSession = createAnalysisSession(timeSource);
    const baseSession = createAnalysisSession(mainSource);
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [],
      getSessionForFilePath: (filePath: string) => filePath === timePath ? timeSession : null
    };
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, context);
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, context);
    const mainSession = createAnalysisSession(mainSource, externalDeclarations, importedSymbolTypes);

    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'unknown' and 'unknown'"
    );
    expect(mainSession.semanticIssues.map((issue) => issue.message)).not.toContain(
      "Operator '+' is not defined for types 'TimeSpan' and 'TimeSpan'"
    );

  });

  it("resolves exported extension properties imported from another file in a virtual workspace", async () => {
    const mainPath = "/demo.vx";
    const timePath = "/time.vx";
    const timeSource = dedent`
      export class TimeSpan(val ms: number)
      export val number.seconds => TimeSpan(this * 1000.0)
      export val number.milliseconds => TimeSpan(this)
      fun TimeSpan.operator+(other: TimeSpan): TimeSpan => TimeSpan(ms + other.ms)
      `;
    const mainSource = dedent`
      import { TimeSpan, seconds, milliseconds, operator+ } from "./time"
      val duration = 0.25.seconds + 10.milliseconds
      `;
    const timeSession = createAnalysisSession(timeSource);
    const baseSession = createAnalysisSession(mainSource);
    const context = {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [],
      getSessionForFilePath: (filePath: string) => filePath === timePath ? timeSession : null
    };
    const externalDeclarations = await collectImportedTypeDeclarations(baseSession.ast!, context);
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, context);
    const mainSession = createAnalysisSession(mainSource, externalDeclarations, importedSymbolTypes);

    expect(mainSession.semanticIssues.map((issue) => issue.message)).toEqual([]);
    expect(mainSession.analysis!.getHoverAt(1, mainSource.split("\n")[1]!.indexOf("seconds") + 2)?.contents).toBe(
      "expression: TimeSpan"
    );
    expect(mainSession.analysis!.getHoverAt(1, mainSource.split("\n")[1]!.indexOf("milliseconds") + 2)?.contents).toBe(
      "expression: TimeSpan"
    );
  });

  it("resolves DOM member definitions to the virtual runtime model in a virtual workspace", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'const div = document.createElement("div")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, [], new Map(), ambientDeclarations);
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("createElement") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
  });

  it("resolves inherited DOM member definitions like querySelector in a virtual workspace", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'const app = document.querySelector("#app")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, [], new Map(), ambientDeclarations);
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("querySelector") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
  });

  it("resolves inherited DOM member definitions when the main file uses ambient DOM declarations but the runtime file session is standalone", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'const app = document.querySelector("#app")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, [], new Map(), ambientDeclarations);
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("querySelector") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
  });

  it("resolves top-level DOM function definitions to the virtual runtime model in a virtual workspace", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = 'fetch("https://example.com/data.json")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, [], new Map(), ambientDeclarations);
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("fetch") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
    const fetchLine = domSource.split("\n").findIndex((line) => line.includes("declare function fetch("));
    expect(location?.range.start.line).toBe(fetchLine);
  });

  it("resolves ambient global console symbol and members to their declaring .d.ts locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-console-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const dtsPath = join(nodeTypesDir, "index.d.ts");
    const source = 'console.log("hello")\n';
    const dtsSource = dedent`
      interface Console {
        log(...data: any[]): void;
      }

      declare var console: Console;
    `;

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(dtsPath, dtsSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
    const session = createAnalysisSession(
      source,
      [],
      new Map(),
      ambient.globalDeclarations,
      ambient.moduleDeclarations,
      ambient.moduleDeclarationLocations,
      new Map(),
      new Set(),
      ambient.globalDeclarationLocations
    );

    const consoleLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("console") + 2,
      session,
      sourceRoots: [root]
    });
    const logLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("log") + 2,
      session,
      sourceRoots: [root]
    });

    expect(consoleLocation?.uri).toBe(pathToUri(dtsPath));
    expect(consoleLocation?.range.start.line).toBe(4);
    expect(logLocation?.uri).toBe(pathToUri(dtsPath));
    expect(logLocation?.range.start.line).toBe(1);
  });

  it("navigates default-imported ambient module members to their declaration", async () => {
    const source = dedent`
      import util from "node:util"
      util.format("value")
    `;
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(`declare module "node:util" {
        export function format(value: string): string;
        export function inspect(value: unknown): string;
      }`, "node:util")]
    ]);
    const ambientModuleLocations = new Map([
      ["node:util", { filePath: "/virtual/@types/node/util.d.ts", line: 0, character: 0 }]
    ]);
    const baseSession = createAnalysisSession(
      source,
      [],
      new Map(),
      [],
      ambientModuleDeclarations,
      ambientModuleLocations
    );
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
      ambientModuleLocations,
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const location = await resolveDefinitionAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: 1,
      character: source.split("\n")[1]!.indexOf("format") + 2,
      session,
      sourceRoots: []
    });

    expect(location?.uri).toBe("file:///virtual/%40types/node/util.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("navigates namespace-imported ambient module members to their declaration", async () => {
    const source = dedent`
      import * as util from "node:util"
      util.format("value")
    `;
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(`declare module "node:util" {
        export function format(value: string): string;
        export function inspect(value: unknown): string;
      }`, "node:util")]
    ]);
    const ambientModuleLocations = new Map([
      ["node:util", { filePath: "/virtual/@types/node/util.d.ts", line: 0, character: 0 }]
    ]);
    const baseSession = createAnalysisSession(
      source,
      [],
      new Map(),
      [],
      ambientModuleDeclarations,
      ambientModuleLocations
    );
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
      ambientModuleLocations,
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );

    const location = await resolveDefinitionAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: 1,
      character: source.split("\n")[1]!.indexOf("format") + 2,
      session,
      sourceRoots: []
    });

    expect(location?.uri).toBe("file:///virtual/%40types/node/util.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("navigates namespace-imported node_modules exports to their declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-node-module-namespace-nav-"));
    const pkgDir = join(root, "node_modules", "three-like");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import * as THREE from "three-like"

      val camera = new THREE.PerspectiveCamera()
      camera.lookAt(new THREE.Vector3())
    `;
    const pkgSource = dedent`
      export class Vector3 {
      }

      export class PerspectiveCamera {
        lookAt(target: Vector3): void;
      }
    `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "three-like",
        types: "index.d.ts"
      }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), pkgSource, "utf8");
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
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
    const pkgLines = pkgSource.split("\n");
    const sourceLines = source.split("\n");
    const perspectiveLine = sourceLines.findIndex((line) => line.includes("PerspectiveCamera"));
    const vectorLine = sourceLines.findIndex((line) => line.includes("Vector3"));
    const perspectiveDefinitionLine = pkgLines.findIndex((line) => line.includes("export class PerspectiveCamera"));
    const vectorDefinitionLine = pkgLines.findIndex((line) => line.includes("export class Vector3"));

    const perspectiveLocation = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: perspectiveLine,
      character: sourceLines[perspectiveLine]!.indexOf("PerspectiveCamera") + 2,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const vectorLocation = await resolveDefinitionWithLocalFallback({
      uri: pathToFileURL(mainPath).toString(),
      line: vectorLine,
      character: sourceLines[vectorLine]!.indexOf("Vector3") + 2,
      session,
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });

    expect(perspectiveLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(perspectiveLocation?.range.start.line).toBe(perspectiveDefinitionLine);
    expect(vectorLocation?.uri).toBe(pathToFileURL(join(pkgDir, "index.d.ts")).toString());
    expect(vectorLocation?.range.start.line).toBe(vectorDefinitionLine);
  });

  it("prefers the receiver's ambient declaration file when duplicate global interface names exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-nav-console-pref-"));
    const nodeTypesDir = join(root, "node_modules", "@types", "node");
    const mainPath = join(root, "main.vx");
    const consoleDtsPath = join(nodeTypesDir, "console.d.ts");
    const globalsDtsPath = join(nodeTypesDir, "globals.d.ts");
    const indexDtsPath = join(nodeTypesDir, "index.d.ts");
    const source = 'console.log("hello")\n';
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const domDeclarations = (await ensureDomProgram()).body;
    const domDeclarationLocations = new Map(
      domDeclarations.map((statement) => [
        statement,
        {
          filePath: getDomDeclarationFilePath(),
          line: statement.firstToken?.range.start.line ?? 0,
          character: statement.firstToken?.range.start.column ?? 0
        }
      ])
    );

    await mkdir(nodeTypesDir, { recursive: true });
    await writeFile(
      join(nodeTypesDir, "package.json"),
      JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      consoleDtsPath,
      dedent`
        interface Console {
          log(...data: any[]): void;
        }
      `,
      "utf8"
    );
    await writeFile(
      globalsDtsPath,
      dedent`
        declare var console: Console;
      `,
      "utf8"
    );
    await writeFile(
      indexDtsPath,
      dedent`
        /// <reference path="./console.d.ts" />
        /// <reference path="./globals.d.ts" />
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
    const session = createAnalysisSession(
      source,
      [],
      new Map(),
      [...domDeclarations, ...ambient.globalDeclarations],
      ambient.moduleDeclarations,
      ambient.moduleDeclarationLocations,
      new Map(),
      new Set(),
      new Map([
        ...domDeclarationLocations,
        ...ambient.globalDeclarationLocations
      ])
    );

    const consoleLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("console") + 2,
      session,
      sourceRoots: [root]
    });
    const logLocation = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: source.indexOf("log") + 2,
      session,
      sourceRoots: [root]
    });

    expect(consoleLocation?.uri).toBe(pathToUri(globalsDtsPath));
    expect(logLocation?.uri).toBe(pathToUri(consoleDtsPath));
    expect(logLocation?.range.start.line).toBe(1);
    expect(logLocation?.uri).not.toBe(pathToUri(getDomDeclarationFilePath()));
    expect(domSource.length).toBeGreaterThan(0);
  });

  it("resolves top-level DOM constructor-like globals to the exact virtual runtime lines", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = "fetch(URL('hello'))\n";
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, [], new Map(), ambientDeclarations);
    const domSession = createAnalysisSession(domSource);

    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: 0,
      character: mainSource.indexOf("URL") + 2,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) {
          return mainSession;
        }
        if (filePath === virtualDomPath) {
          return domSession;
        }
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    const urlLine = domSource.split("\n").findIndex((line) => line.includes("interface URL {"));
    expect(location?.range.start.line).toBe(urlLine);
  });

  it("resolves implicit receiver method calls (bare method without this.) to the correct DOM file location", async () => {
    const mainPath = "/src/main.vx";
    const virtualDomPath = "/runtime/dom.d.ts";
    const mainSource = [
      "fun CanvasRenderingContext2D.myDraw(): void {",
      "  beginPath()",
      "}"
    ].join("\n");
    const domSource = await readFile(getDomDeclarationFilePath(), "utf8");
    const ambientDeclarations = (await ensureDomProgram()).body;
    const mainSession = createAnalysisSession(mainSource, [], new Map(), ambientDeclarations);
    const domSession = createAnalysisSession(domSource);

    const beginPathLine = 1;
    const beginPathChar = mainSource.split("\n")[1]!.indexOf("beginPath") + 2;
    const location = await resolveDefinitionAcrossFiles({
      uri: pathToFileURL(mainPath).toString(),
      line: beginPathLine,
      character: beginPathChar,
      session: mainSession,
      sourceRoots: [],
      vfs: new MyVfs(virtualDomPath, domSource),
      getSessionForFilePath: (filePath) => {
        if (filePath === mainPath) return mainSession;
        if (filePath === virtualDomPath) return domSession;
        return null;
      }
    });

    expect(location).not.toBeNull();
    expect(location?.uri).toBe(pathToFileURL(virtualDomPath).toString());
    expect(location?.range).toBeTruthy();
    const domLine = domSource.split("\n").findIndex((line) => line.includes("beginPath()"));
    expect(location?.range.start.line).toBe(domLine);
  });

  describe("resolveDefinitionWithLocalFallback", () => {
    it("navigates ambient node:path imports to the interface member declaration", async () => {
      const source = dedent`
        import { join } from "node:path"
        join("a", "b")
      `;
      const ambientModuleDeclarations = new Map<string, Statement[]>([
        ["node:path", parseAmbientModule(`declare module "node:path" { export = path; }`, "node:path")],
        ["path", parseAmbientModule(`declare module "path" {
          namespace path {
            interface PlatformPath {
              join(...paths: string[]): string;
            }
          }
          const path: path.PlatformPath;
          export = path;
        }`, "path")]
      ]);
      const ambientModuleLocations = new Map([
        ["node:path", { filePath: "/virtual/@types/node/path.d.ts", line: 0, character: 0 }],
        ["path", { filePath: "/virtual/@types/node/path.d.ts", line: 0, character: 0 }]
      ]);

      const baseSession = createAnalysisSession(
        source,
        [],
        new Map(),
        [],
        ambientModuleDeclarations,
        ambientModuleLocations
      );
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: "file:///virtual/main.vx",
        sourceRoots: [],
        ambientModuleDeclarations
      });
      const session = createAnalysisSession(
        source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        [],
        ambientModuleDeclarations,
        ambientModuleLocations,
        collected.importedSymbolDisplayTypes
      );

      const location = await resolveDefinitionWithLocalFallback({
        uri: "file:///virtual/main.vx",
        line: 1,
        character: 2,
        session,
        sourceRoots: []
      });

      expect(location).not.toBeNull();
      expect(location?.uri?.endsWith("/node/path.d.ts")).toBe(true);
      expect(location?.range.start.line).toBeGreaterThanOrEqual(0);
      expect(location?.range.start.character).toBeGreaterThanOrEqual(0);
    });

    it("navigates ambient node: module imports to the declared function definition", async () => {
      const source = dedent`
        import { readlink } from "node:fs/promises"
        readlink("demo")
      `;
      const ambientModuleDeclarations = new Map<string, Statement[]>([
        ["node:fs/promises", parseAmbientModule(`declare module "node:fs/promises" { export * from "fs/promises"; }`, "node:fs/promises")],
        ["fs/promises", parseAmbientModule(`declare module "fs/promises" { export function readlink(path: string): Promise<string>; }`, "fs/promises")]
      ]);
      const ambientModuleLocations = new Map([
        ["node:fs/promises", { filePath: "/virtual/@types/node/fs/promises.d.ts", line: 0, character: 0 }],
        ["fs/promises", { filePath: "/virtual/@types/node/fs/promises.d.ts", line: 0, character: 0 }]
      ]);

      const baseSession = createAnalysisSession(
        source,
        [],
        new Map(),
        [],
        ambientModuleDeclarations,
        ambientModuleLocations
      );
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: "file:///virtual/main.vx",
        sourceRoots: [],
        ambientModuleDeclarations
      });
      const session = createAnalysisSession(
        source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        [],
        ambientModuleDeclarations,
        ambientModuleLocations,
        collected.importedSymbolDisplayTypes
      );

      const location = await resolveDefinitionWithLocalFallback({
        uri: "file:///virtual/main.vx",
        line: 1,
        character: 2,
        session,
        sourceRoots: []
      });

      expect(location).not.toBeNull();
      expect(location?.uri?.endsWith("/node/fs/promises.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(0);
      expect(location?.range.start.character).toBeGreaterThanOrEqual(0);
    });

    it("hovers ambient readFile overloads without recursing forever on node typings", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-ambient-hover-"));
      const nodeTypesDir = join(root, "node_modules", "@types", "node");
      const mainPath = join(root, "main.vx");
      const source = dedent`
        import { readFile } from "fs/promises"
        await readFile("hello", { encoding: "utf-8" })
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
          export interface AbortSignal {
            parent?: AbortSignal;
          }
          export interface Abortable {
            signal?: AbortSignal;
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

        declare module "node:fs/promises" {
          export * from "fs/promises";
        }
        `,
        "utf8"
      );
      await writeFile(mainPath, source, "utf8");

      const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        ambientModuleDeclarations: ambient.moduleDeclarations
      });
      const session = createAnalysisSession(
        source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        ambient.globalDeclarations,
        ambient.moduleDeclarations,
        ambient.moduleDeclarationLocations,
        collected.importedSymbolDisplayTypes
      );

      const hover = session.analysis?.getHoverAt(1, source.split("\n")[1]!.indexOf("readFile") + 1);

      expect(hover).not.toBeNull();
      expect(hover?.contents).toContain("readFile");
      expect(hover?.contents).toContain("PathLike | FileHandle");
      expect(hover?.contents).not.toContain("string | Buffer | URL | object");
    });

    it("includes documentation when hovering directly imported ambient module functions", async () => {
      const source = dedent`
        import { readFile } from "node:fs/promises"
        await readFile("hello")
      `;
      const ambientModuleDeclarations = new Map<string, Statement[]>([
        ["node:fs/promises", parseAmbientModule(
          `declare module "node:fs/promises" {
            /**
             * Reads the entire contents of a file.
             */
            export function readFile(path: string): Promise<string>;
          }`,
          "node:fs/promises"
        )]
      ]);

      const baseSession = createAnalysisSession(source, [], new Map(), [], ambientModuleDeclarations);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: "file:///virtual/main.vx",
        sourceRoots: [],
        ambientModuleDeclarations
      });
      const session = createAnalysisSession(
        source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        [],
        ambientModuleDeclarations,
        new Map(),
        collected.importedSymbolDisplayTypes,
        collected.invalidImportedBindings
      );

      const hover = await resolveHoverWithLocalFallback({
        uri: "file:///virtual/main.vx",
        line: 1,
        character: source.split("\n")[1]!.indexOf("readFile") + 1,
        session,
        sourceRoots: []
      });

      expect(hover?.contents).toEqual({
        kind: "plaintext",
        value: "function readFile: (path: string) => Promise<string>\n\nReads the entire contents of a file."
      });
    });

    it("navigates ambient imported calls to the matched overload declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-ambient-overload-definition-"));
      const nodeTypesDir = join(root, "node_modules", "@types", "node");
      const mainPath = join(root, "main.vx");
      const { source, line, character } = sourceWithCursor(dedent`
        import { readFile } from "fs/promises"
        const file = "hello.txt"
        await readFi^^^le(file, "utf-8")
      `);
      const nodeTypesSource = dedent`
        declare module "node:events" {
          export interface AbortSignal {
            parent?: AbortSignal;
          }
          export interface Abortable {
            signal?: AbortSignal;
          }
        }

        declare module "node:fs" {
          export class Buffer {}
          export class URL {}
          export type PathLike = string | Buffer | URL;
          export type OpenMode = string | number;
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

        declare module "node:fs/promises" {
          export * from "fs/promises";
        }
      `;

      await mkdir(nodeTypesDir, { recursive: true });
      await writeFile(
        join(nodeTypesDir, "package.json"),
        JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
        "utf8"
      );
      await writeFile(join(nodeTypesDir, "index.d.ts"), nodeTypesSource, "utf8");
      await writeFile(mainPath, source, "utf8");

      const ambient = await loadAmbientTypesForProject(mainPath, ["node"]);
      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        ambientModuleDeclarations: ambient.moduleDeclarations
      });
      const session = createAnalysisSession(
        source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        ambient.globalDeclarations,
        ambient.moduleDeclarations,
        ambient.moduleDeclarationLocations,
        collected.importedSymbolDisplayTypes
      );

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line,
        character,
        session,
        sourceRoots: [root]
      });

      const overloadLines = nodeTypesSource
        .split("\n")
        .flatMap((text, index) => text.includes("export function readFile(") ? [index] : []);

      expect(overloadLines.length).toBe(2);
      expect(location).not.toBeNull();
      expect(location?.uri?.endsWith("/node/index.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(overloadLines[1]);
    });

    it("navigates imported symbol to source declaration, not import line", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-def-fallback-"));
      const fileA = join(root, "a.vx");
      const fileB = join(root, "b.vx");
      const sourceA = dedent`
        export fun greet(): string { return "hello" }
      `;
      const sourceB = dedent`
        import { greet } from "./a"
        fun demo() { greet() }
      `;
      await writeFile(fileA, sourceA, "utf8");
      await writeFile(fileB, sourceB, "utf8");

      const sessionA = createAnalysisSession(sourceA);
      const sessionB = createAnalysisSession(sourceB);
      const uriB = pathToFileURL(fileB).toString();

      // cursor on "greet" in the import specifier line (line 0, col 9)
      const importLocation = await resolveDefinitionWithLocalFallback({
        uri: uriB,
        line: 0,
        character: 9,
        session: sessionB,
        sourceRoots: [root],
        getSessionForFilePath: (p) => {
          if (p === fileA) return sessionA;
          if (p === fileB) return sessionB;
          return null;
        },
      });

      expect(importLocation).not.toBeNull();
      expect(importLocation?.uri).toBe(pathToFileURL(fileA).toString());
      expect(importLocation?.range.start.line).toBe(0);

      // cursor on the call "greet()" usage (line 1, col 13)
      const callLocation = await resolveDefinitionWithLocalFallback({
        uri: uriB,
        line: 1,
        character: 13,
        session: sessionB,
        sourceRoots: [root],
        getSessionForFilePath: (p) => {
          if (p === fileA) return sessionA;
          if (p === fileB) return sessionB;
          return null;
        },
      });

      expect(callLocation).not.toBeNull();
      expect(callLocation?.uri).toBe(pathToFileURL(fileA).toString());
      expect(callLocation?.range.start.line).toBe(0);
    });

  it("navigates node_modules named imports at call sites to the typings declaration", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const hooksDir = join(pkgDir, "hooks");
      const mainPath = join(root, "main.vx");
      const { source, line, character } = sourceWithCursor(dedent`
        import { useState } from "preact/hooks"
        const [count, setCount] = useSt^^^ate(0)
        setCount(count + 1)
      `);

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
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
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

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line,
        character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
    expect(location?.uri.endsWith("/node_modules/preact/hooks/src/index.d.ts")).toBe(true);
    expect(location?.range.start.line).toBe(2);
  });

    it("navigates node_modules member access through export-star barrels to the original declaration file", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const mainPath = join(root, "main.vx");
      const { source, line, character } = sourceWithCursor(dedent`
        import { Widget } from "preact"

        fun demo() {
          val widget = new Widget()
          widget.drawRoundedRe^^^ct(0, 0, 10, 20, 5)
        }
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "preact",
          types: "./src/index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "index.d.ts"),
        'export * from "./dom";\n',
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "dom.d.ts"),
        dedent`
          export declare class Widget {
            drawRoundedRect(x: number, y: number, width: number, height: number, radius: number): this;
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, source, "utf8");

      const baseSession = createAnalysisSession(source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
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

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line,
        character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
      expect(location?.uri.endsWith("/node_modules/preact/src/dom.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(1);
    });

    it("navigates members of imported generic classes that rely on default type arguments", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "pkg");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { Application } from "pkg"

        val app = Application()
        app.renderer.resi^^^ze(100, 200)
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "pkg",
          types: "./src/index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "index.d.ts"),
        dedent`
          export interface Renderer {
            resize(width: number, height: number): void;
          }

          export declare class Application<R = Renderer> {
            renderer: R;
            constructor();
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(
        marked.source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        [],
        new Map(),
        new Map(),
        collected.importedSymbolDisplayTypes,
        collected.invalidImportedBindings
      );

      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect((hover?.contents as { value?: string } | undefined)?.value).toContain("resize: (width: number, height: number) => void");
      expect(location?.uri.endsWith("/node_modules/pkg/src/index.d.ts")).toBe(true);
      expect(location?.range.start.line).toBe(1);
    });

    it("navigates type names and generic arguments inside extends clauses", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const mainPath = join(root, "main.vx");
      const baseMarked = sourceWithCursor(dedent`
        import { InputHTMLAttributes } from "preact"

        interface HTMLInputElement {
        }

        interface InputProperties extends InputHTMLAttr^^^ibutes<HTMLInputElement> {
          mySpecialProp: any
        }
      `);
      const genericMarked = sourceWithCursor(dedent`
        import { InputHTMLAttributes } from "preact"

        interface HTMLInputElement {
        }

        interface InputProperties extends InputHTMLAttributes<HTMLInputEleme^^^nt> {
          mySpecialProp: any
        }
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "preact",
          types: "src/index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "index.d.ts"),
        'export * from "./dom";\n',
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "dom.d.ts"),
        dedent`
          export interface HTMLAttributes<T> {
            style?: string;
          }

          export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
            value?: string;
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, baseMarked.source, "utf8");

      const baseSession = createAnalysisSession(baseMarked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(
        baseMarked.source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        [],
        new Map(),
        new Map(),
        collected.importedSymbolDisplayTypes,
        collected.invalidImportedBindings
      );

      const baseLocation = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: baseMarked.line,
        character: baseMarked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(baseLocation).not.toBeNull();
      expect(baseLocation?.uri.endsWith("/node_modules/preact/src/dom.d.ts")).toBe(true);
      expect(baseLocation?.range.start.line).toBe(4);

      const genericLocation = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: genericMarked.line,
        character: genericMarked.character,
        session: createAnalysisSession(
          genericMarked.source,
          collected.externalDeclarations,
          collected.importedSymbolTypes,
          [],
          new Map(),
          new Map(),
          collected.importedSymbolDisplayTypes,
          collected.invalidImportedBindings
        ),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(genericLocation).toEqual({
        uri: pathToFileURL(mainPath).toString(),
        range: {
          start: { line: 2, character: 10 },
          end: { line: 2, character: 26 }
        }
      });
    });

    it("navigates and hovers imported class names inside extends clauses for merged preact-style declarations", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-node-module-definition-"));
      const pkgDir = join(root, "node_modules", "preact");
      const mainPath = join(root, "main.vx");
      const marked = sourceWithCursor(dedent`
        import { Component } from "preact"

        class Clock extends Compo^^^nent<{ label: string }, { time: number }> {
          state: { time: number }

          constructor() {
            super()
            this.state = { time: Date.now() }
          }
        }
      `);

      await mkdir(join(pkgDir, "src"), { recursive: true });
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "preact",
          types: "src/index.d.ts"
        }),
        "utf8"
      );
      await writeFile(
        join(pkgDir, "src", "index.d.ts"),
        dedent`
          export interface Component<P = {}, S = {}> {
            state: Readonly<S>;
          }

          export abstract class Component<P, S> {
            constructor(props?: P, context?: any);
            state: Readonly<S>;
            static getDerivedStateFromProps?(props: Readonly<P>, state: Readonly<S>): Partial<S> | null;
            setState<K extends keyof S>(state: Pick<S, K> | Partial<S> | null, callback?: () => void): void;
          }
        `,
        "utf8"
      );
      await writeFile(mainPath, marked.source, "utf8");

      const baseSession = createAnalysisSession(marked.source);
      const collected = await collectAllImportedDeclarations(baseSession.ast!, {
        uri: pathToFileURL(mainPath).toString(),
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const session = createAnalysisSession(
        marked.source,
        collected.externalDeclarations,
        collected.importedSymbolTypes,
        [],
        new Map(),
        new Map(),
        collected.importedSymbolDisplayTypes,
        collected.invalidImportedBindings
      );

      const location = await resolveDefinitionWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });
      const hover = await resolveHoverWithLocalFallback({
        uri: pathToFileURL(mainPath).toString(),
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [root],
        getSessionForFilePath: () => null
      });

      expect(location).not.toBeNull();
      expect(location?.uri.endsWith("/node_modules/preact/src/index.d.ts")).toBe(true);
      expect((hover?.contents as { value?: string } | undefined)?.value).toContain("Component");
    });

    it("falls back to local definition when no cross-file resolution matches", async () => {
      const source = dedent`
        fun localFn(): int { return 42 }
        fun demo() { localFn() }
      `;
      const uri = "file:///virtual/test.vx";
      const session = createAnalysisSession(source);

      // cursor on "localFn" call (line 1, col 13)
      const location = await resolveDefinitionWithLocalFallback({
        uri,
        line: 1,
        character: 13,
        session,
        sourceRoots: [],
      });

      expect(location).not.toBeNull();
      expect(location?.uri).toBe(uri);
      expect(location?.range.start.line).toBe(0);
    });

    it("resolves the extension-property receiver type name to its local class definition", async () => {
      const marked = sourceWithCursor(dedent`
        class View(var x: number, var y: number)
        var Vie^^^w.point: Vec2 {
          get => Vec2(x, y)
        }
        class Vec2(val x: number, val y: number)
      `);
      const uri = "file:///virtual/test.vx";
      const session = createAnalysisSession(marked.source);

      const location = await resolveDefinitionWithLocalFallback({
        uri,
        line: marked.line,
        character: marked.character,
        session,
        sourceRoots: [],
      });

      expect(location).not.toBeNull();
      expect(location?.uri).toBe(uri);
      expect(location?.range.start.line).toBe(0);
      expect(location?.range.start.character).toBe(6);
    });
  });

  it("keeps the cross-file module layering acyclic", async () => {
    // crossFileNavigation.ts orchestrates the operations on top of the shared
    // helper modules; the helpers must never import back from it (or from each
    // other in the wrong direction), so they stay reusable in isolation.
    const contextSource = await readFile("compiler/lsp/crossFileContext.ts", "utf8");
    const typeResolutionSource = await readFile("compiler/lsp/crossFileTypeResolution.ts", "utf8");

    expect(contextSource.includes("./crossFileNavigation")).toBe(false);
    expect(contextSource.includes("./crossFileTypeResolution")).toBe(false);
    expect(typeResolutionSource.includes("./crossFileNavigation")).toBe(false);
    expect(typeResolutionSource.includes("./crossFileContext")).toBe(true);
  });

  describe("findAmbientNamedExportRange", () => {
    it("finds a directly declared symbol inside a declare module block", () => {
      const declarations = parseAmbientModule(
        `declare module "my-module" {
          export function readFile(path: string): string;
          export function writeFile(path: string, data: string): void;
        }`,
        "my-module"
      );

      const range = findAmbientNamedExportRange(declarations, "readFile");
      expect(range).not.toBeNull();
      expect(range?.start.line).toBeGreaterThanOrEqual(0);
      // "readFile" appears after "function " on line 1 (0-indexed)
      const src = `declare module "my-module" {\n  export function readFile(path: string): string;\n  export function writeFile(path: string, data: string): void;\n}`;
      const lineText = src.split("\n")[range?.start.line ?? -1] ?? "";
      expect(lineText).toContain("readFile");
    });

    it("finds a symbol via the export = namespace body pattern", () => {
      // Mirrors the node:path / path pattern used in real @types/node
      const declarations = parseAmbientModule(
        `declare module "path" {
          namespace path {
            interface PlatformPath {
              join(...paths: string[]): string;
              resolve(...paths: string[]): string;
            }
          }
          const path: path.PlatformPath;
          export = path;
        }`,
        "path"
      );

      const range = findAmbientNamedExportRange(declarations, "join");
      expect(range).not.toBeNull();
      // The range must point to the "join" member inside the PlatformPath interface
      const src = `declare module "path" {\n  namespace path {\n    interface PlatformPath {\n      join(...paths: string[]): string;\n      resolve(...paths: string[]): string;\n    }\n  }\n  const path: path.PlatformPath;\n  export = path;\n}`;
      const lineText = src.split("\n")[range?.start.line ?? -1] ?? "";
      expect(lineText).toContain("join");
    });

    it("returns null for a name not present in the declarations", () => {
      const declarations = parseAmbientModule(
        `declare module "my-module" {
          export function knownExport(): void;
        }`,
        "my-module"
      );

      const range = findAmbientNamedExportRange(declarations, "unknownExport");
      expect(range).toBeNull();
    });

    it("finds a symbol declared inside a global {} block within a module", () => {
      // When declarations are assembled directly (not via ambientTypesLoader which
      // flattens global blocks), a declare global {} NamespaceStatement inside the
      // module body should be searched as a fallback.
      const declarations = parseAmbientModule(
        `declare module "augmenting-module" {
          export function moduleExport(): void;
          global {
            function globalHelper(): void;
          }
        }`,
        "augmenting-module"
      );

      // The module export should resolve directly.
      const moduleRange = findAmbientNamedExportRange(declarations, "moduleExport");
      expect(moduleRange).not.toBeNull();

      // The global {} member should be found via the global block search.
      const globalRange = findAmbientNamedExportRange(declarations, "globalHelper");
      expect(globalRange).not.toBeNull();
    });
  });

  describe("rename and prepareRename for runtime/ambient symbols", () => {
    it("resolveRenameAcrossFiles returns null for a built-in ECMAScript runtime symbol", async () => {
      // parseInt is declared in the ECMAScript runtime (es2025.d.ts), so
      // renaming it would only patch usage sites while leaving the declaration
      // untouched — a half-working rename that must be blocked.
      await ensureEcmaScriptRuntimeProgram();
      const runtimeDeclarations = getEcmaScriptRuntimeProgram().body;

      const { source, line, character } = sourceWithCursor(dedent`
        val result = par^^^seInt("42", 10)
      `);

      const root = await mkdtemp(join(tmpdir(), "vexa-rename-runtime-"));
      const file = join(root, "main.vx");
      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source, [], new Map(), runtimeDeclarations);
      const edit = await resolveRenameAcrossFiles(
        {
          uri: pathToFileURL(file).toString(),
          line,
          character,
          session,
          sourceRoots: [root]
        },
        "parseInteger"
      );

      expect(edit).toBeNull();
    });

    it("resolveRenameAcrossFiles succeeds for a local user-defined function", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-rename-local-"));
      const file = join(root, "main.vx");

      const { source, line, character } = sourceWithCursor(dedent`
        fun greet(name: string): string { return "Hello " + name }
        val msg = gre^^^et("World")
      `);

      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source);
      const edit = await resolveRenameAcrossFiles(
        {
          uri: pathToFileURL(file).toString(),
          line,
          character,
          session,
          sourceRoots: [root]
        },
        "sayHello"
      );

      expect(edit).not.toBeNull();
      expect(edit?.changes?.[pathToFileURL(file).toString()]).toBeDefined();
    });

    it("resolvePrepareRenameAcrossFiles returns null for a built-in ECMAScript runtime symbol", async () => {
      // parseFloat lives in the ECMAScript runtime; prepareRename must refuse it.
      await ensureEcmaScriptRuntimeProgram();
      const runtimeDeclarations = getEcmaScriptRuntimeProgram().body;

      const { source, line, character } = sourceWithCursor(dedent`
        val n = parseF^^^loat("3.14")
      `);

      const root = await mkdtemp(join(tmpdir(), "vexa-prepare-rename-runtime-"));
      const file = join(root, "main.vx");
      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source, [], new Map(), runtimeDeclarations);
      const result = await resolvePrepareRenameAcrossFiles({
        uri: pathToFileURL(file).toString(),
        line,
        character,
        session,
        sourceRoots: [root]
      });

      expect(result).toBeNull();
    });

    it("resolvePrepareRenameAcrossFiles returns a valid result for a local symbol", async () => {
      const root = await mkdtemp(join(tmpdir(), "vexa-prepare-rename-local-"));
      const file = join(root, "main.vx");

      const { source, line, character } = sourceWithCursor(dedent`
        fun localFu^^^nction(): int { return 1 }
      `);

      await writeFile(file, source, "utf8");

      const session = createAnalysisSession(source);
      const result = await resolvePrepareRenameAcrossFiles({
        uri: pathToFileURL(file).toString(),
        line,
        character,
        session,
        sourceRoots: [root]
      });

      expect(result).not.toBeNull();
      expect((result as { placeholder?: string })?.placeholder).toBe("localFunction");
    });
  });
});
