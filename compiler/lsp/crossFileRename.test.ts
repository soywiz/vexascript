import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import {
  resolvePrepareRenameAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileRename";

describe("crossFileRename", () => {
  it("returns null for built-in ECMAScript runtime symbols", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-rename-runtime-"));
    const file = join(root, "main.vx");
    const source = "const result = parseFloat(\"1.5\")\n";

    await writeFile(file, source, "utf8");

    const result = await resolvePrepareRenameAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 0,
      character: source.indexOf("parseFloat") + 1,
      session: createAnalysisSession(source),
      sourceRoots: [root]
    });

    expect(result).toBe(null);
  });

  it("renames symbols across declaration and importer usages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-rename-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint {}\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  return new MyPoint()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const edit = await resolveRenameAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 2,
        character: 16,
        session: createAnalysisSession(sourceB),
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
});
