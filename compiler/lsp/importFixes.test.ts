import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import {
  buildAmbientModuleSymbolExports,
  buildAutoImportSuggestions,
  buildExtensionAutoImportSuggestions,
  createAutoImportCodeActions
} from "./importFixes";

function missingMemberDiagnostic(name: string, typeName: string): Diagnostic {
  return { severity: 1, source: "vexa-sema", message: `Property '${name}' does not exist on type '${typeName}'`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
}

function undefinedVariableDiagnostic(name: string): Diagnostic {
  return {
    severity: 1,
    source: "vexa-sema",
    message: `Undefined variable '${name}'`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

function unknownTypeDiagnostic(typeName: string): Diagnostic {
  return {
    severity: 1,
    source: "vexa-sema",
    message: `Unknown type '${typeName}'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

function operatorNotDefinedDiagnostic(operator: string, leftType: string, rightType: string): Diagnostic {
  return {
    severity: 1,
    source: "vexa-sema",
    message: `Operator '${operator}' is not defined for types '${leftType}' and '${rightType}'`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
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

describe("import quick fixes", () => {
  it("suggests import from another .vx file in source roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Point\n", "utf8");
    await writeFile(fileB, "fun demo() {\n  return new Point()\n}\n", "utf8");

    const sourceB = "fun demo() {\n  return new Point()\n}\n";
    const sessionB = createAnalysisSession(sourceB);
    const actions = await createAutoImportCodeActions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      diagnostics: [undefinedVariableDiagnostic("Point")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'Point' from './a.vx'");
    expect(actions[0]?.edit?.changes?.[pathToFileURL(fileB).toString()]?.[0]?.newText).toBe(
      "import { Point } from \"./a.vx\"\n"
    );
  });

  it("suggests import from virtual exported symbols without source roots", async () => {
    const source = "fun demo() {\n  return new Point()\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createAutoImportCodeActions({
      uri: "file:///consumer.vx",
      ast: session.ast,
      diagnostics: [undefinedVariableDiagnostic("Point")],
      sourceRoots: [],
      getExportedSymbols: async () => [
        { name: "Point", filePath: "/models/point.vx", kind: "class" },
      ],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'Point' from './models/point.vx'");
  });

  it("merges import into existing import from the same file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Point\nclass Vector\n", "utf8");
    const sourceB = 'import { Point } from "./a.vx"\nfun demo() {\n  return new Vector()\n}\n';
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const actions = await createAutoImportCodeActions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      diagnostics: [undefinedVariableDiagnostic("Vector")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'Vector' from './a.vx'");
    const edit = actions[0]?.edit?.changes?.[pathToFileURL(fileB).toString()]?.[0];
    expect(edit?.newText).toBe('import { Point, Vector } from "./a.vx"');
    expect(edit?.range.start).toEqual({ line: 0, character: 0 });
  });

  it("does not suggest duplicate import when symbol is already imported", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Point\n", "utf8");
    const sourceB = "import { Point } from \"./a.vx\"\nfun demo() {\n  return new Point()\n}\n";
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const actions = await createAutoImportCodeActions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      diagnostics: [undefinedVariableDiagnostic("Point")],
      sourceRoots: [root]
    });

    expect(actions).toEqual([]);
  });

  it("suggests import for a class used in a type annotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    await writeFile(worldFile, "class TimeSpan(val ms: number)\n", "utf8");
    const sourceHello = "fun delay(time: TimeSpan) => time.ms\n";
    await writeFile(helloFile, sourceHello, "utf8");

    const sessionHello = createAnalysisSession(sourceHello);
    const actions = await createAutoImportCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: sessionHello.ast,
      diagnostics: [unknownTypeDiagnostic("TimeSpan")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'TimeSpan' from './world.vx'");
    expect(actions[0]?.edit?.changes?.[pathToFileURL(helloFile).toString()]?.[0]?.newText).toBe(
      'import { TimeSpan } from "./world.vx"\n'
    );
  });

  it("suggests importing an extension operator overload for an undefined operator", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const fileA = join(root, "other.vx");
    const fileB = join(root, "sample.vx");

    await writeFile(
      fileA,
      "class Point(val x: number, val y: number)\nfun Point.operator+(other: Point): Point => Point(x + other.x, y + other.y)\n",
      "utf8"
    );
    const sourceB = 'import { Point } from "./other.vx"\nval p = Point(1, 2) + Point(3, 4)\n';
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const actions = await createAutoImportCodeActions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      diagnostics: [operatorNotDefinedDiagnostic("+", "Point", "Point")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'operator+' from './other.vx'");
    const edit = actions[0]?.edit?.changes?.[pathToFileURL(fileB).toString()]?.[0];
    expect(edit?.newText).toBe('import { Point, operator+ } from "./other.vx"');
  });

  it("builds completion-friendly auto-import suggestions filtered by prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(fileA, "class Point\ninterface PointReader {}\ntype PointId = string\nclass Vector\n", "utf8");
    const sourceB = "fun demo() {\n  return Poi\n}\n";
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const suggestions = await buildAutoImportSuggestions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      sourceRoots: [root],
      prefix: "Poi",
      excludeSymbols: new Set()
    });

    expect(suggestions.map((suggestion) => suggestion.symbol.name)).toEqual(["Point", "PointId", "PointReader"]);
    expect(suggestions.find((suggestion) => suggestion.symbol.name === "Point")?.symbol.kind).toBe("class");
    expect(suggestions.find((suggestion) => suggestion.symbol.name === "PointId")?.symbol.kind).toBe("type");
    expect(suggestions.find((suggestion) => suggestion.symbol.name === "PointReader")?.symbol.kind).toBe("interface");
    expect(suggestions[0]?.importPath).toBe("./a.vx");
  });

  it("builds auto-import suggestions from virtual exported symbols", async () => {
    const source = "fun demo() {\n  return Poi\n}\n";
    const session = createAnalysisSession(source);
    const suggestions = await buildAutoImportSuggestions({
      uri: "file:///consumer.vx",
      ast: session.ast,
      sourceRoots: [],
      prefix: "Poi",
      excludeSymbols: new Set(),
      getExportedSymbols: async () => [
        { name: "Point", filePath: "/models/point.vx", kind: "class" },
        { name: "Vector", filePath: "/models/vector.vx", kind: "class" },
      ],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.symbol.name).toBe("Point");
    expect(suggestions[0]?.importPath).toBe("./models/point.vx");
  });

  it("builds ambient module symbol exports for direct functions and export-equals interface members", () => {
    const exports = buildAmbientModuleSymbolExports({
      moduleDeclarations: new Map<string, Statement[]>([
        ["my-lib", parseAmbientModule(`declare module "my-lib" { export function greet(): string; }`, "my-lib")],
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
      ])
    });

    expect(exports.find((item) => item.name === "greet" && item.importPath === "my-lib")?.kind).toBe("function");
    expect(exports.find((item) => item.name === "join" && item.importPath === "node:path")?.kind).toBe("function");
  });

  it("builds auto-import suggestions for ambient module exports using the module specifier", async () => {
    const source = "fun demo() {\n  return gre\n}\n";
    const session = createAnalysisSession(source);
    const suggestions = await buildAutoImportSuggestions({
      uri: "file:///consumer.vx",
      ast: session.ast,
      sourceRoots: [],
      prefix: "gre",
      excludeSymbols: new Set(),
      getExportedSymbols: async () => [
        { name: "greet", filePath: "/virtual/@types/my-lib/index.d.ts", importPath: "my-lib", kind: "function" }
      ],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.symbol.name).toBe("greet");
    expect(suggestions[0]?.importPath).toBe("my-lib");
  });

  it("builds type auto-import suggestions from named exports of an already imported node_modules module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const packageDir = join(root, "node_modules", "preact");
    const packageJson = join(packageDir, "package.json");
    const typings = join(packageDir, "index.d.ts");
    const consumerFile = join(root, "consumer.vx");

    await mkdir(packageDir, { recursive: true });
    await writeFile(packageJson, JSON.stringify({ name: "preact", types: "index.d.ts" }), "utf8");
    await writeFile(typings, 'export function h(): void;\nexport type ComponentChildren = string | number;\n', "utf8");
    await writeFile(consumerFile, 'import { h } from "preact"\nfun demo() {\n  return Comp\n}\n', "utf8");

    const session = createAnalysisSession('import { h } from "preact"\nfun demo() {\n  return Comp\n}\n');
    const suggestions = await buildAutoImportSuggestions({
      uri: pathToFileURL(consumerFile).toString(),
      ast: session.ast,
      sourceRoots: [root],
      prefix: "Comp",
      excludeSymbols: new Set()
    });

    expect(suggestions.map((suggestion) => suggestion.symbol.name)).toContain("ComponentChildren");
    expect(suggestions.find((suggestion) => suggestion.symbol.name === "ComponentChildren")?.symbol.typeOnly).toBe(true);
    expect(suggestions.find((suggestion) => suggestion.symbol.name === "ComponentChildren")?.importPath).toBe("preact");
  });

  it("creates auto-import code actions for ambient module exports using the module specifier", async () => {
    const source = "fun demo() {\n  greet()\n}\n";
    const session = createAnalysisSession(source);
    const uri = "file:///consumer.vx";
    const actions = await createAutoImportCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [undefinedVariableDiagnostic("greet")],
      sourceRoots: [],
      getExportedSymbols: async () => [
        { name: "greet", filePath: "/virtual/@types/my-lib/index.d.ts", importPath: "my-lib", kind: "function" }
      ]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'greet' from 'my-lib'");
    expect(actions[0]?.edit?.changes?.[uri]?.[0]?.newText).toBe('import { greet } from "my-lib"\n');
  });

  it("creates type-only auto-import code actions for named exports of an already imported node_modules module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const packageDir = join(root, "node_modules", "preact");
    const packageJson = join(packageDir, "package.json");
    const typings = join(packageDir, "index.d.ts");
    const consumerFile = join(root, "consumer.vx");
    const source = 'import { h } from "preact"\nfun demo(props: { children: ComponentChildren }) {\n  return h()\n}\n';

    await mkdir(packageDir, { recursive: true });
    await writeFile(packageJson, JSON.stringify({ name: "preact", types: "index.d.ts" }), "utf8");
    await writeFile(typings, 'export function h(): void;\nexport type ComponentChildren = string | number;\n', "utf8");
    await writeFile(consumerFile, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(consumerFile).toString();
    const actions = await createAutoImportCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [unknownTypeDiagnostic("ComponentChildren")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'ComponentChildren' from 'preact'");
    expect(actions[0]?.edit?.changes?.[uri]?.[0]?.newText).toBe('import { h, type ComponentChildren } from "preact"');
  });

  it("creates one auto-import code action per matching module when names collide", async () => {
    const source = "fun demo() {\n  greet()\n}\n";
    const session = createAnalysisSession(source);
    const uri = "file:///consumer.vx";
    const actions = await createAutoImportCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [undefinedVariableDiagnostic("greet")],
      sourceRoots: [],
      getExportedSymbols: async () => [
        { name: "greet", filePath: "/virtual/@types/alpha/index.d.ts", importPath: "alpha", kind: "function" },
        { name: "greet", filePath: "/virtual/@types/beta/index.d.ts", importPath: "beta", kind: "function" }
      ]
    });

    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.title)).toEqual([
      "Import 'greet' from 'alpha'",
      "Import 'greet' from 'beta'"
    ]);
  });

  it("prioritizes auto-import code actions from modules already imported in the file", async () => {
    const source = 'import { existing } from "beta"\nfun demo() {\n  greet()\n}\n';
    const session = createAnalysisSession(source);
    const uri = "file:///consumer.vx";
    const actions = await createAutoImportCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [undefinedVariableDiagnostic("greet")],
      sourceRoots: [],
      getExportedSymbols: async () => [
        { name: "greet", filePath: "/virtual/@types/alpha/index.d.ts", importPath: "alpha", kind: "function" },
        { name: "greet", filePath: "/virtual/@types/beta/index.d.ts", importPath: "beta", kind: "function" }
      ]
    });

    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.title)).toEqual([
      "Import 'greet' from 'beta'",
      "Import 'greet' from 'alpha'"
    ]);
  });

  it("suggests importing an exported extension property for a missing member", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const durationFile = join(root, "duration.vx");
    const consumerFile = join(root, "consumer.vx");
    await writeFile(durationFile, "export val number.milliseconds => this\n", "utf8");
    const source = "val duration = 10.milliseconds\n";
    await writeFile(consumerFile, source, "utf8");
    const session = createAnalysisSession(source);

    const actions = await createAutoImportCodeActions({
      uri: pathToFileURL(consumerFile).toString(),
      ast: session.ast,
      diagnostics: [missingMemberDiagnostic("milliseconds", "int")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'milliseconds' from './duration.vx'");
    expect(actions[0]?.edit?.changes?.[pathToFileURL(consumerFile).toString()]?.[0]?.newText).toBe(
      'import { milliseconds } from "./duration.vx"\n'
    );
  });

  it("filters extension auto-import suggestions by receiver type", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-import-fix-"));
    const durationFile = join(root, "duration.vx");
    const consumerFile = join(root, "consumer.vx");
    await writeFile(
      durationFile, dedent`
      export val number.milliseconds => this
      export val string.milliseconds => this
      export fun number.ms(): int { return this }
      `,
      "utf8"
    );
    const source = "10.\n";
    await writeFile(consumerFile, source, "utf8");
    const session = createAnalysisSession(source);

    const suggestions = await buildExtensionAutoImportSuggestions({
      uri: pathToFileURL(consumerFile).toString(),
      ast: session.ast,
      sourceRoots: [root],
      receiverType: "int",
      prefix: "m",
      excludeSymbols: new Set()
    });

    expect(suggestions.map((suggestion) => suggestion.symbol.name)).toEqual(["milliseconds", "ms"]);
    expect(suggestions.every((suggestion) => suggestion.symbol.receiverType === "number")).toBe(true);
  });

});
