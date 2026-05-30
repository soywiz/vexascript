import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import { createAutoImportCodeActions } from "./importFixes";

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
});
