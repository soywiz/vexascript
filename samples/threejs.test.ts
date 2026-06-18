import { describe, expect, it, resolve } from "../compiler/test/expect";
import {
  createBundledModuleArtifacts,
  ensureCompilerRuntimePrograms,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "../cli/cliShared";

describe("threejs sample", () => {
  it("bundles the browser entry without diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/threejs/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);
    await ensureCompilerRuntimePrograms();

    const result = await createBundledModuleArtifacts(sourcePath, "optimized", project);

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("three-scene-ready");
    expect(result.code).toContain(".position.set(4, 3, 7)");
    expect(result.code).toContain(".rotation.set(");
    expect(result.code).not.toContain("declare class ThreeVector3");
  });
});
