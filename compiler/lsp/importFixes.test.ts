import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import {
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
