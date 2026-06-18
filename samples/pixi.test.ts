import { describe, expect, it, resolve } from "../compiler/test/expect";
import {
  createBundledModuleArtifacts,
  ensureCompilerRuntimePrograms,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "../cli/cliShared";

describe("pixi sample", () => {
  it("bundles the browser entry without diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/pixi/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);
    await ensureCompilerRuntimePrograms();

    const result = await createBundledModuleArtifacts(sourcePath, "optimized", project);

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("pixi-ready");
    expect(/"@pixi\/[^"]+":null/.test(result.code)).toBe(false);
  });
});
