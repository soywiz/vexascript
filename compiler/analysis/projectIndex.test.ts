import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "../../vitest";
import { getProjectIndex } from "./projectIndex";

describe("ProjectIndex", () => {
  it("indexes top-level declarations and importer bindings across project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-project-index-"));
    const fileA = join(root, "a.my");
    const fileB = join(root, "b.my");

    await writeFile(
      fileA,
      "class Point\ninterface Readable {}\ntype PointList = Point[]\nfun make(): Point { return new Point() }\n",
      "utf8"
    );
    await writeFile(fileB, "import { Point } from \"./a\"\nfun demo() { return new Point() }\n", "utf8");

    const index = getProjectIndex([root]);
    const declaration = index.findTopLevelDeclaration(fileA, "Point");
    expect(declaration?.kind).toBe("class");
    const interfaceDeclaration = index.findTopLevelDeclaration(fileA, "Readable");
    expect(interfaceDeclaration?.kind).toBe("class");

    const typeAliasDeclaration = index.findTopLevelDeclaration(fileA, "PointList");
    expect(typeAliasDeclaration?.kind).toBe("class");

    const importers = index.findFilesImportingSymbol(fileA, "Point");
    expect(importers).toHaveLength(1);
    expect(importers[0]?.importerFilePath).toBe(fileB);
  });

  it("prefers open-document overrides for sessions and indexed declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-project-index-"));
    const file = join(root, "override.my");
    await writeFile(file, "class Point\n", "utf8");

    const index = getProjectIndex([root]);
    expect(index.findTopLevelDeclaration(file, "Point")).toBeTruthy();

    index.upsertOpenDocument(file, "class UpdatedPoint\n");
    expect(index.findTopLevelDeclaration(file, "UpdatedPoint")).toBeTruthy();
    expect(index.findTopLevelDeclaration(file, "Point")).toBeFalsy();

    index.clearOpenDocument(file);
    expect(index.findTopLevelDeclaration(file, "Point")).toBeTruthy();
  });
});
