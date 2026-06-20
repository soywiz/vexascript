import { describe, it, readdir, resolve } from "../compiler/test/expect";
import { ensureCompilerRuntimePrograms, ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { fileExists, isDirectory } from "../compiler/utils/fs";
import { openEntrypointInLspSession } from "./lspOpenSession";

interface SampleEntrypoint {
  sampleName: string;
  entrypoint: string;
}

const skippedSamples = new Set([
  "preact",
  "syntax-tour"
]);

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

  await ensureCompilerRuntimePrograms();

  for (const { sampleName, entrypoint } of entrypoints) {
    const testFn = skippedSamples.has(sampleName) ? it.skip : it;
    testFn(`opens ${sampleName} without LSP error diagnostics`, async () => {
      const project = await resolveProjectForSource(entrypoint);
      await ensureRuntimeDependencies(entrypoint, project);

      const result = await openEntrypointInLspSession(entrypoint, workspaceRoot);
      const errors = [...result.documentDiagnostics, ...result.workspaceDiagnostics]
        .filter((diagnostic) => diagnostic.severity === 1)
        .map((diagnostic) => diagnostic.message);

      if (errors.length > 0) {
        throw new Error(`Unexpected LSP error diagnostics for ${sampleName}:\n${errors.join("\n")}`);
      }
    });
  }
});
