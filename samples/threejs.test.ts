import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import {
  createBundledModuleArtifacts,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "../cli/cliShared";
import { openEntrypointInLspSession } from "./lspOpenSession";

describe("threejs sample", () => {
  it("bundles the browser entry without diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/threejs/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);

    const result = await createBundledModuleArtifacts(sourcePath, "optimized", project);

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("three-scene-ready");
    expect(result.code).toContain(".position.set(4, 3, 7)");
    expect(result.code).toContain(".rotation.set(");
    expect(result.code).not.toContain("declare class ThreeVector3");
  });

  it("opens the browser entry in an LSP session without document error diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/threejs/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);

    const result = await openEntrypointInLspSession(sourcePath);

    expect(result.documentDiagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
  });

  it("treats the imported Box3 constructor as static-only while preserving definition navigation", async () => {
    const sourcePath = resolve(process.cwd(), "samples/threejs/html.vx");
    const project = await resolveProjectForSource(sourcePath);
    await ensureRuntimeDependencies(sourcePath, project);

    const originalSource = await readFile(sourcePath, "utf8");
    const source = `${originalSource.replace("import {", "import { Box3,")}\nBox3.min\n`;
    const line = source.split("\n").findIndex((sourceLine) => sourceLine === "Box3.min");
    const result = await openEntrypointInLspSession(
      sourcePath,
      process.cwd(),
      [{ line, character: "Box3.min".length }],
      [{ line, character: "Box3.".length }],
      source
    );
    const labels = result.completions[0]?.map((item) => item.label) ?? [];
    const definition = Array.isArray(result.definitions[0])
      ? result.definitions[0][0]
      : result.definitions[0];

    expect(labels).toEqual([]);
    expect(result.documentDiagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Member 'min' is not static and cannot be accessed on class 'Box3'"
    );
    expect(definition?.uri.endsWith("/src/math/Box3.d.ts")).toBe(true);
  });
});
