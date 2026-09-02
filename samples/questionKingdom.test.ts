import { describe, expect, it, resolve } from "../compiler/test/expect";
import {
  createBundledModuleArtifacts,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "../cli/cliShared";
import type { ModuleGraphProfileEvent } from "../compiler/runtime/moduleGraphModel";

describe("Question Kingdom sample", () => {
  it("bundles main.vx and its transitive game modules without diagnostics", async () => {
    const sampleRoot = resolve(process.cwd(), "samples/question-kingdom");
    const sourcePath = resolve(sampleRoot, "src/main.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);
    const profileEvents: ModuleGraphProfileEvent[] = [];
    const result = await createBundledModuleArtifacts(sourcePath, "optimized", project, {}, {
      profile: (event) => profileEvents.push(event)
    });

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);

    const watchedFiles = new Set(result.watchedFiles);
    expect(watchedFiles.has(sourcePath)).toBe(true);
    expect(watchedFiles.has(resolve(sampleRoot, "src/game/PlatformGame.vx"))).toBe(true);
    expect(watchedFiles.has(resolve(sampleRoot, "src/game/scripts/PlayerController.vx"))).toBe(true);
    expect(watchedFiles.has(resolve(sampleRoot, "src/game/render/KenneyAtlas.vx"))).toBe(true);

    const bundledGameModules = [...watchedFiles].filter((path) =>
      path.startsWith(`${sampleRoot}/src/`) && path.endsWith(".vx")
    );
    expect(bundledGameModules.length).toBeGreaterThan(40);
    expect(result.code).toContain("LEVEL COMPLETE!");

    const work = profileEvents.find((event) => event.phase === "analysis")!;
    expect(work.analyzedModuleCount).toBeLessThanOrEqual(55);
    expect(work.emittedModuleCount).toBeLessThanOrEqual(55);
    expect(work.ambientDeclarationVisitCount).toBeLessThanOrEqual(55 * 2494);
    expect(work.nodeModuleImportResolutionCount).toBeLessThanOrEqual(24);
    expect(work.nodeModuleImportCacheHitCount).toBeGreaterThan(0);
    expect(work.selectiveTypingsBuilds).toBeLessThanOrEqual(12);
    expect(work.selectiveTypingsSupersetCacheHits).toBeGreaterThan(0);
    expect(work.typingsFileIndexBuilds).toBeLessThanOrEqual(730);
    expect(work.typingsFileIndexEdgeResolutions).toBeLessThanOrEqual(2652);
    expect(work.typingsFileIndexCacheHits).toBeGreaterThan(0);
  });
});
