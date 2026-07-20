import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import {
  createBundledModuleArtifacts,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "../cli/cliShared";
import { openEntrypointInLspSession } from "./lspOpenSession";

describe("pixi sample", () => {
  it("bundles the browser entry without diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/pixi/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);

    const result = await createBundledModuleArtifacts(sourcePath, "optimized", project);

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("pixi-ready");
    expect(result.code).toContain("Container$$addTo");
    expect(result.code).toContain("Container$$position$set");
    expect(/"@pixi\/[^"]+":null/.test(result.code)).toBe(false);
  });

  it("opens the browser entry in an LSP session without document error diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/pixi/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);

    const result = await openEntrypointInLspSession(sourcePath);

    const errors = [...result.documentDiagnostics, ...result.workspaceDiagnostics]
      .filter((diagnostic) => diagnostic.severity === 1);

    expect(errors).toEqual([]);
  });

  it("resolves and types implicit receiver members in the Pixi receiver block", async () => {
    const sourcePath = resolve(process.cwd(), "samples/pixi/html.vx");
    const source = await readFile(sourcePath, "utf8");
    const lines = source.split("\n");
    const receiverBlockLine = lines.findIndex((text) => text.startsWith("val orb = Graphics(). {"));
    const probeFor = (name: string) => {
      const line = lines.findIndex((text, index) => index > receiverBlockLine && text.startsWith(`    ${name}`));
      return { line, character: lines[line]!.indexOf(name) + 2 };
    };

    const result = await openEntrypointInLspSession(
      sourcePath,
      process.cwd(),
      [probeFor("circle"), probeFor("addTo")]
    );
    const firstLocation = (definition: typeof result.definitions[number]) =>
      Array.isArray(definition) ? definition[0] : definition;
    const hoverText = (index: number) => JSON.stringify(result.hovers[index]?.contents ?? "");

    expect(firstLocation(result.definitions[0])?.uri).toContain("Graphics.d.ts");
    expect(firstLocation(result.definitions[1])?.uri).toContain("samples/pixi/utils.vx");
    expect(hoverText(0)).toContain("circle");
    expect(hoverText(1)).toContain("(other: Container)");
    expect(hoverText(1)).not.toContain("unknown");
  });
});
