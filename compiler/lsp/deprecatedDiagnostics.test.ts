import dedent from "compiler/utils/dedent";
import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "compiler/test/expect";
import { createAnalysisSession } from "./analysisSession";
import { collectDeprecatedDiagnostics } from "./deprecatedDiagnostics";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";

describe("deprecated diagnostics", () => {
  it("tags deprecated node_modules members so editors can render strikethrough", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-deprecated-diagnostics-"));
    const pkgDir = join(root, "node_modules", "pixi.js");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Graphics } from "pixi.js"

      val badge = Graphics()
      badge.beginFill(0xffb635)
      badge.fill(0xffb635)
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
        export class Graphics {
          /** @deprecated since 8.0.0 Use fill instead */
          beginFill(color: number): this;
          fill(color: number): this;
        }
      `,
      "utf8"
    );

    const uri = pathToFileURL(mainPath).toString();
    const baseSession = createAnalysisSession(source);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri,
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
    const diagnostics = await collectDeprecatedDiagnostics({
      uri,
      sourceRoots: [root],
      session,
      getSessionForFilePath: () => null
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(VEXA_DIAGNOSTIC_CODES.STYLE_DEPRECATED_MEMBER);
    expect(diagnostics[0]?.severity).toBe(2);
    expect(diagnostics[0]?.tags).toEqual([2]);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 3, character: 6 },
      end: { line: 3, character: 15 }
    });
  });
});
