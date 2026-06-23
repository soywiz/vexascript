import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { resolveContextualObjectLiteralPropertyDefinition } from "./objectLiteralCompletion";

describe("object-literal property definition through node_modules barrel", () => {
  it("lands in the source file, not the package barrel", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-objlit-barrel-"));
    const pkgDir = join(root, "node_modules", "text-pkg");
    const textDir = join(pkgDir, "text");
    await mkdir(textDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "text-pkg", types: "./index.d.ts", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), `export * from "./text";\n`, "utf8");
    await writeFile(
      join(textDir, "index.d.ts"),
      `export interface TextOptions {\n  fontSize: number;\n}\nexport declare function makeText(options: TextOptions): void;\n`,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const mainSource = dedent`
      import { makeText } from "text-pkg"
      fun demo() {
        makeText({ fontSize: 24 })
      }
    `;
    await writeFile(mainPath, mainSource, "utf8");

    const uri = pathToFileURL(mainPath).toString();
    const baseSession = createAnalysisSession(mainSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, { uri, sourceRoots: [root] });
    const session = createAnalysisSession(mainSource, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols
    });

    const line = 2;
    const character = mainSource.split("\n")[2]!.indexOf("fontSize") + 2;
    const location = await resolveContextualObjectLiteralPropertyDefinition({
      uri,
      line,
      character,
      session,
      sourceRoots: [root]
    });

    // `fontSize` is declared on TextOptions in text/index.d.ts, reached through
    // the package's `export *` barrel. Definition must land in that source file,
    // not the barrel index.d.ts.
    expect(location).toBeTruthy();
    expect(location!.uri).toContain("text/index.d.ts");
  });
});
