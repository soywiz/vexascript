import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createAnalysisSession } from "./analysisSession";
import {
  resolveDefinitionAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";

describe("cross-file navigation", () => {
  it("resolves go-to-definition from imported symbol usage to original declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "a.my");
    const fileB = join(root, "b.my");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun demo() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = resolveDefinitionAcrossFiles({
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

  it("resolves go-to-definition from member access to class member declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "world.my");
    const fileB = join(root, "hello.my");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const location = resolveDefinitionAcrossFiles({
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

  it("provides hover info for primary constructor members", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const file = join(root, "world.my");
    const source = "class MyPoint(const x: number, const y: number) { }\n";

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const hover = resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(file).toString(),
      line: 0,
      character: 20,
      session,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "member MyPoint.x: number"
    });
    expect(hover?.range).toEqual({
      start: { line: 0, character: 20 },
      end: { line: 0, character: 21 }
    });
  });

  it("provides hover info for imported class member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "world.my");
    const fileB = join(root, "hello.my");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const hover = resolveMemberHoverAcrossFiles({
      uri: pathToFileURL(fileB).toString(),
      line: 3,
      character: 8,
      session: sessionB,
      sourceRoots: [root]
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "member MyPoint.y: number"
    });
    expect(hover?.range).toEqual({
      start: { line: 3, character: 8 },
      end: { line: 3, character: 9 }
    });
  });

  it("finds references across importer files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "a.my");
    const fileB = join(root, "b.my");
    const fileC = join(root, "c.my");

    const sourceA = "class Point\n";
    const sourceB = "import { Point } from \"./a\"\nfun first() {\n  return new Point()\n}\n";
    const sourceC = "import { Point } from \"./a\"\nfun second() {\n  return new Point()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");
    await writeFile(fileC, sourceC, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = resolveReferencesAcrossFiles(
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
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "world.my");
    const fileB = join(root, "hello.my");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n  point.y\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const locations = resolveReferencesAcrossFiles(
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
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "world.my");
    const fileB = join(root, "hello.my");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionA = createAnalysisSession(sourceA);
    const locations = resolveReferencesAcrossFiles(
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

  it("renames symbol across declaration and importer usages", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const fileA = join(root, "world.my");
    const fileB = join(root, "hello.my");

    const sourceA = "class MyPoint {}\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  return new MyPoint()\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const sessionB = createAnalysisSession(sourceB);
    const edit = resolveRenameAcrossFiles(
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
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const file = join(root, "local.my");
    const source = `fun demo(arg: number) {
  return arg + arg
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const edit = resolveRenameAcrossFiles(
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
    const root = await mkdtemp(join(tmpdir(), "mylang-cross-nav-"));
    const file = join(root, "decl.my");
    const source = `fun test3(a: string, b: int, arg3: int, arg4: int) {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const edit = resolveRenameAcrossFiles(
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
});
