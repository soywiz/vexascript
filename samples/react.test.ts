import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import {
  createBundledModuleArtifacts,
  ensureCompilerRuntimePrograms,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "../cli/cliShared";
import { openEntrypointInLspSession } from "./lspOpenSession";

describe("react sample", () => {
  it("declares a single bundled React runtime instead of relying on CDN globals", async () => {
    const packageJsonPath = resolve(process.cwd(), "samples/react/package.json");
    const indexHtmlPath = resolve(process.cwd(), "samples/react/index.html");

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const indexHtml = await readFile(indexHtmlPath, "utf8");

    expect(packageJson.dependencies?.react).toBe("18.3.1");
    expect(packageJson.dependencies?.["react-dom"]).toBe("18.3.1");
    expect(indexHtml).not.toContain("https://esm.sh/react");
    expect(indexHtml).not.toContain("globalThis.React");
    expect(indexHtml).not.toContain("globalThis.ReactDOM");
  });

  it("bundles the browser entry without diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/react/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);
    await ensureCompilerRuntimePrograms();

    const result = await createBundledModuleArtifacts(sourcePath, "optimized", project);

    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("react-sample-ready");
    expect(result.code).toContain("React + VexaScript");
    expect(result.code).not.toContain("\"react-dom/client\":null");
    expect(result.code).toContain('const process = globalThis.process ?? { env: { NODE_ENV: "production" } };');
  });

  it.skip("opens the browser entry in an LSP session without document error diagnostics", async () => {
    const sourcePath = resolve(process.cwd(), "samples/react/html.vx");
    const project = await resolveProjectForSource(sourcePath);

    await ensureRuntimeDependencies(sourcePath, project);
    await ensureCompilerRuntimePrograms();

    const result = await openEntrypointInLspSession(sourcePath);

    expect(result.documentDiagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
  });
});
