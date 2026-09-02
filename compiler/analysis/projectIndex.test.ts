import { describe, expect, it, join, mkdtemp, tmpdir, writeFile } from "../test/expect";
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

  it("does not rebuild an open-document session when the source is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-project-index-open-cache-"));
    const file = join(root, "cached-open.vx");
    const source = "class CachedOpen\n";
    await writeFile(file, source, "utf8");

    const index = getProjectIndex([root]);
    await index.upsertOpenDocument(file, source);
    await index.upsertOpenDocument(file, source);

    expect(index.getMetrics().openSessionBuilds).toBeLessThanOrEqual(1);
  });

  it("deduplicates concurrent builds for the same open document", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-project-index-open-pending-"));
    const file = join(root, "pending-open.vx");
    const source = "class PendingOpen\n";
    await writeFile(file, source, "utf8");
    const index = getProjectIndex([root]);

    await Promise.all([
      index.upsertOpenDocument(file, source),
      index.upsertOpenDocument(file, source),
      index.upsertOpenDocument(file, source)
    ]);

    expect(index.getMetrics().openSessionBuilds).toBeLessThanOrEqual(1);
    expect(index.getMetrics().pendingOpenSessionReuses).toBeGreaterThanOrEqual(1);
  });

  it("exposes reusable disk-session work without repeated filesystem probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-project-index-metrics-"));
    const file = join(root, "cached.vx");
    await writeFile(file, "class Cached\n", "utf8");

    const index = getProjectIndex([root]);
    const [first, concurrent] = await Promise.all([
      index.getSessionForFilePath(file),
      index.getSessionForFilePath(file)
    ]);
    const warm = await index.getSessionForFilePath(file);

    expect(first === concurrent).toBe(true);
    expect(warm === first).toBe(true);
    expect(index.getMetrics()).toMatchObject({
      sessionRequests: 3,
      diskSessionCacheHits: 1,
      pendingDiskSessionReuses: 1,
      diskSessionCacheMisses: 1,
      diskStatCalls: 1,
      diskReadCalls: 1,
      diskSessionBuilds: 1
    });

    const missingFile = join(root, "missing.vx");
    const [missingFirst, missingConcurrent] = await Promise.all([
      index.getSessionForFilePath(missingFile),
      index.getSessionForFilePath(missingFile)
    ]);
    const missingWarm = await index.getSessionForFilePath(missingFile);
    expect(missingFirst).toBeNull();
    expect(missingConcurrent).toBeNull();
    expect(missingWarm).toBeNull();
    expect(index.getMetrics()).toMatchObject({
      sessionRequests: 6,
      diskSessionCacheHits: 2,
      pendingDiskSessionReuses: 2,
      diskSessionCacheMisses: 2,
      diskStatCalls: 2,
      diskReadCalls: 1,
      diskSessionBuilds: 1
    });

    index.invalidateFile(file);
    await index.getSessionForFilePath(file);
    expect(index.getMetrics()).toMatchObject({
      sessionRequests: 7,
      diskSessionCacheMisses: 3,
      diskStatCalls: 3,
      diskReadCalls: 2,
      diskSessionBuilds: 2
    });
  });

  it("reuses the project index for an empty root set", () => {
    const first = getProjectIndex([]);
    const second = getProjectIndex([]);

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });
});
