import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { expect } from "../../vitest";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import {
  buildAutoImportSuggestions,
  createAutoImportCodeActions
} from "./importFixes";

function missingMemberDiagnostic(name: string, typeName: string): Diagnostic {
  return { severity: 1, source: "mylang-sema", message: `Property '${name}' does not exist on type '${typeName}'`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
}

function undefinedVariableDiagnostic(name: string): Diagnostic {
  return {
    severity: 1,
    source: "mylang-sema",
    message: `Undefined variable '${name}'`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

describe("import quick fixes", () => {
  it("suggests import from another .my file in source roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-import-fix-"));
    const fileA = join(root, "a.my");
    const fileB = join(root, "b.my");

    await writeFile(fileA, "class Point\n", "utf8");
    await writeFile(fileB, "fun demo() {\n  return new Point()\n}\n", "utf8");

    const sourceB = "fun demo() {\n  return new Point()\n}\n";
    const sessionB = createAnalysisSession(sourceB);
    const actions = createAutoImportCodeActions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      diagnostics: [undefinedVariableDiagnostic("Point")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'Point' from './a'");
    expect(actions[0]?.edit?.changes?.[pathToFileURL(fileB).toString()]?.[0]?.newText).toBe(
      "import { Point } from \"./a\"\n"
    );
  });

  it("does not suggest duplicate import when symbol is already imported", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-import-fix-"));
    const fileA = join(root, "a.my");
    const fileB = join(root, "b.my");

    await writeFile(fileA, "class Point\n", "utf8");
    const sourceB = "import { Point } from \"./a\"\nfun demo() {\n  return new Point()\n}\n";
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const actions = createAutoImportCodeActions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      diagnostics: [undefinedVariableDiagnostic("Point")],
      sourceRoots: [root]
    });

    expect(actions).toEqual([]);
  });

  it("builds completion-friendly auto-import suggestions filtered by prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-import-fix-"));
    const fileA = join(root, "a.my");
    const fileB = join(root, "b.my");

    await writeFile(fileA, "class Point\nclass Vector\n", "utf8");
    const sourceB = "fun demo() {\n  return Poi\n}\n";
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const suggestions = buildAutoImportSuggestions({
      uri: pathToFileURL(fileB).toString(),
      ast: sessionB.ast,
      sourceRoots: [root],
      prefix: "Poi",
      excludeSymbols: new Set()
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.symbol.name).toBe("Point");
    expect(suggestions[0]?.importPath).toBe("./a");
  });
  it("suggests importing an exported extension property for a missing member", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-import-fix-"));
    const durationFile = join(root, "duration.my");
    const consumerFile = join(root, "consumer.my");
    await writeFile(durationFile, "export val number.milliseconds => this\n", "utf8");
    const source = "val duration = 10.milliseconds\n";
    await writeFile(consumerFile, source, "utf8");
    const session = createAnalysisSession(source);

    const actions = createAutoImportCodeActions({
      uri: pathToFileURL(consumerFile).toString(),
      ast: session.ast,
      diagnostics: [missingMemberDiagnostic("milliseconds", "int")],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Import 'milliseconds' from './duration'");
    expect(actions[0]?.edit?.changes?.[pathToFileURL(consumerFile).toString()]?.[0]?.newText).toBe(
      'import { milliseconds } from "./duration"\n'
    );
  });

});
