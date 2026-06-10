import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { getProjectIndex } from "./projectIndex";

describe("ProjectIndex", () => {
  it("indexes top-level declarations and importer bindings across project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-project-index-"));
    const fileA = join(root, "a.vx");
    const fileB = join(root, "b.vx");

    await writeFile(
      fileA,
      "class Point\ninterface Readable {}\ntype PointList = Point[]\nfun make(): Point { return new Point() }\n",
      "utf8"
    );
    await writeFile(fileB, "import { Point } from \"./a\"\nfun demo() { return new Point() }\n", "utf8");

    const index = getProjectIndex([root]);
    const declaration = await index.findTopLevelDeclaration(fileA, "Point");
    expect(declaration?.kind).toBe("class");
    const interfaceDeclaration = await index.findTopLevelDeclaration(fileA, "Readable");
    expect(interfaceDeclaration?.kind).toBe("interface");

    const typeAliasDeclaration = await index.findTopLevelDeclaration(fileA, "PointList");
    expect(typeAliasDeclaration?.kind).toBe("type");

    const importers = await index.findFilesImportingSymbol(fileA, "Point");
    expect(importers).toHaveLength(1);
    expect(importers[0]?.importerFilePath).toBe(fileB);
  });

  it("prefers open-document overrides for sessions and indexed declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-project-index-"));
    const file = join(root, "override.vx");
    await writeFile(file, "class Point\n", "utf8");

    const index = getProjectIndex([root]);
    expect(await index.findTopLevelDeclaration(file, "Point")).toBeTruthy();

    await index.upsertOpenDocument(file, "class UpdatedPoint\n");
    expect(await index.findTopLevelDeclaration(file, "UpdatedPoint")).toBeTruthy();
    expect(await index.findTopLevelDeclaration(file, "Point")).toBeFalsy();

    index.clearOpenDocument(file);
    expect(await index.findTopLevelDeclaration(file, "Point")).toBeTruthy();
  });
});
