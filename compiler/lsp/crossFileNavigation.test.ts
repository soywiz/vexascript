import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { collectImportedSymbolTypes, collectImportedTypeDeclarations } from "./importedDeclarations";
import {
  resolveDefinitionAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import { getEcmaScriptRuntimeDeclarationFilePath } from "compiler/runtime/ecmascriptDeclarations";

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
      value: "valueOf: () => number"
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
      value: "className: string"
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

    const { resolveImportPathHover } = await import("./crossFileNavigation");
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

});
