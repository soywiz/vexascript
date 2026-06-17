import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectImportedTypeDeclarations } from "./importedDeclarations";
import {
  resolveExtensionMemberDefinitionAcrossFiles,
  resolveNodeModulesMemberDefinition
} from "./crossFileMemberDefinitionSources";

describe("crossFileMemberDefinitionSources", () => {
  it("resolves cross-file extension member definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-def-src-"));
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

    const location = await resolveExtensionMemberDefinitionAcrossFiles({
      uri,
      line: 1,
      character: mainSource.split("\n")[1]!.indexOf(".seconds") + 2,
      session,
      sourceRoots: [root]
    }, "number", "seconds");

    expect(location).toEqual({
      uri: pathToFileURL(other).toString(),
      range: {
        start: { line: 1, character: 11 },
        end: { line: 1, character: 18 }
      }
    });
  });

  it("resolves node_modules member definitions from bare imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-def-node-"));
    const pkgDir = join(root, "node_modules", "demo-pkg");
    const main = join(root, "main.vx");
    const source = 'import { Box } from "demo-pkg"\n';

    await mkdir(join(pkgDir, "src"), { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "demo-pkg", types: "src/index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "src", "index.d.ts"),
      dedent`
        export interface Box {
          value: string;
        }
      `,
      "utf8"
    );
    await writeFile(main, source, "utf8");

    const location = await resolveNodeModulesMemberDefinition({
      uri: pathToFileURL(main).toString(),
      line: 0,
      character: 10,
      session: createAnalysisSession(source),
      sourceRoots: [root]
    }, "Box", "value");

    expect(location?.uri).toBe(pathToFileURL(join(pkgDir, "src", "index.d.ts")).toString());
    expect(location?.range.start.line).toBe(1);
  });
});
