import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { resolveReferencesAcrossFiles } from "./crossFileReferences";

describe("crossFileReferences", () => {
  it("finds references across importer files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-refs-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");
    const fileC = join(root, "c.vx");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun first() {\n  return new Point()\n}\n";
    const sourceC = "import { Point } from \"./a\"\nfun second() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");
    await writeFile(fileC, sourceC, "utf8");

    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 2,
        character: 15,
        session: createAnalysisSession(sourceB),
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
    const root = await mkdtemp(join(tmpdir(), "vexa-cross-member-refs-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const locations = await resolveReferencesAcrossFiles(
      {
        uri: pathToFileURL(fileB).toString(),
        line: 3,
        character: 8,
        session: createAnalysisSession(sourceB),
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
});
