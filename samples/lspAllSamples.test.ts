import { describe, expect, it, readFile, readdir, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { fileExists, isDirectory } from "../compiler/utils/fs";
import { openEntrypointInLspSession } from "./lspOpenSession";

interface SampleEntrypoint {
  sampleName: string;
  entrypoint: string;
}

const skippedSamples = new Set<string>();

async function resolveSampleEntrypoints(rootDir: string): Promise<SampleEntrypoint[]> {
  const sampleDirs = await readdir(rootDir);
  const results: SampleEntrypoint[] = [];

  for (const file of sampleDirs) {
    const sampleDir = `${rootDir}/${file}`;
    if (!(await isDirectory(sampleDir))) continue;

    const project = await resolveProjectForSource(sampleDir);
    const entrypoint = project?.bundleEntrypoint
      ?? ((await fileExists(`${sampleDir}/main.vx`)) ? resolve(sampleDir, "main.vx") : null);

    if (!entrypoint) continue;
    results.push({ sampleName: file, entrypoint });
  }

  return results;
}

describe("all sample LSP sessions", async () => {
  const workspaceRoot = process.cwd();
  const rootDir = resolve(workspaceRoot, "samples");
  const entrypoints = await resolveSampleEntrypoints(rootDir);

  for (const { sampleName, entrypoint } of entrypoints) {
    const testFn = skippedSamples.has(sampleName) ? it.skip : it;
    testFn(`opens ${sampleName} without LSP error diagnostics`, async () => {
      const project = await resolveProjectForSource(entrypoint);
      await ensureRuntimeDependencies(entrypoint, project);

      // Keep the full fake-VS Code request burst in this test. The extra calls
      // intentionally emulate what the editor asks for on open, so this suite
      // can catch hangs, infinite loops, and thrown errors a real user would see.
      let highlightProbes: Array<{ line: number; character: number }> = [];
      if (sampleName === "preact") {
        const source = await readFile(entrypoint, "utf8");
        const offset = source.indexOf("root");
        const before = source.slice(0, offset + 2);
        const lines = before.split("\n");
        highlightProbes = [{ line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }];
      }
      const result = await openEntrypointInLspSession(
        entrypoint,
        project?.projectDir ?? workspaceRoot,
        highlightProbes
      );
      const errors = [...result.documentDiagnostics, ...result.workspaceDiagnostics]
        .filter((diagnostic) => diagnostic.severity === 1)
        .map((diagnostic) => diagnostic.message);

      if (errors.length > 0) {
        throw new Error(`Unexpected LSP error diagnostics for ${sampleName}:\n${errors.join("\n")}`);
      }
      if (sampleName === "preact") {
        expect(result.documentHighlights[0]).toHaveLength(2);
        expect(result.documentHighlights[0]?.every((highlight) => highlight.kind === 3)).toBe(true);
      }
      if (sampleName === "question-kingdom") {
        expect(result.workMetrics.openSessionBuilds).toBeLessThanOrEqual(2);
        expect(result.workMetrics.importedAnalysisBuilds).toBeLessThanOrEqual(55);
        expect(result.workMetrics.diskSessionBuilds).toBeLessThanOrEqual(55);
        expect(result.workMetrics.sessionRequests).toBeLessThanOrEqual(500);
        expect(result.workMetrics.importedAnalysisCacheHits).toBeGreaterThan(0);
        expect(result.workMetrics.selectiveTypingsBuilds).toBeLessThanOrEqual(12);
        expect(result.workMetrics.selectiveTypingsSupersetCacheHits).toBeGreaterThan(0);
        expect(result.workMetrics.typingsFileIndexBuilds).toBeLessThanOrEqual(730);
        expect(result.workMetrics.typingsFileIndexEdgeResolutions).toBeLessThanOrEqual(2652);
        expect(result.workMetrics.typingsFileIndexCacheHits).toBeGreaterThan(0);
      }
    });
  }
});
