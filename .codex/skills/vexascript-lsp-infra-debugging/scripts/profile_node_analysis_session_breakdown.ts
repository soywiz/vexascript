import { readFile } from "node:fs/promises";
import { resolve as resolveNodePath } from "node:path";
import "cli/localVfs";
import { TextDocument } from "vscode-languageserver-textdocument";
import { AnalysisSessionCache, createAnalysisSession } from "compiler/lsp/analysisSession";
import { collectAllImportedDeclarations } from "compiler/lsp/importedDeclarations";
import { loadAmbientTypesForProject } from "compiler/lsp/ambientTypesLoader";
import { getProjectIndex } from "compiler/lsp/projectAnalysis";
import { uriToFilePath } from "compiler/lsp/importFixes";
import { getNodeModuleTypings } from "compiler/lsp/nodeModulesTypings";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadProject } from "compiler/project";
import { resolve as resolvePath } from "compiler/utils/path";

function nowMs(): number {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

async function timeStep<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  const startedAt = nowMs();
  const result = await run();
  const durationMs = nowMs() - startedAt;
  process.stdout.write(`${label}: ${durationMs.toFixed(1)}ms\n`);
  return result;
}

async function main(): Promise<void> {
  const workspaceRoot = resolveNodePath(process.cwd(), "samples/node");
  const entrypoint = resolveNodePath(workspaceRoot, "main.vx");
  const source = await readFile(entrypoint, "utf8");
  const document = TextDocument.create(`file://${entrypoint}`, "vexa", 1, source);
  const projectIndex = getProjectIndex([workspaceRoot]);
  await projectIndex.upsertOpenDocument(entrypoint, source);

  async function getSessionForFilePath(filePath: string) {
    return projectIndex.getSessionForFilePath(resolvePath(filePath));
  }

  const baseSession = await timeStep("base createAnalysisSession", () => createAnalysisSession(source));
  const filePath = uriToFilePath(document.uri);
  const project = await timeStep("loadProject", () => filePath ? loadProject(filePath) : null);
  const ambientTypes = await timeStep("loadAmbientTypesForProject", () =>
    loadAmbientTypesForProject(filePath, project?.types ?? [])
  );
  const domDeclarations = await timeStep("ensureDomProgram", async () =>
    (project?.libs ?? []).some((lib) => lib.toLowerCase() === "dom")
      ? (await ensureDomProgram()).body
      : []
  );
  const domDeclarationLocations = domDeclarations.length === 0
    ? new Map()
    : new Map(domDeclarations.map((statement) => [
        statement,
        {
          filePath: getDomDeclarationFilePath(),
          line: statement.firstToken?.range.start.line ?? 0,
          character: statement.firstToken?.range.start.column ?? 0
        }
      ]));

  for (const statement of baseSession.ast?.body ?? []) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importPath = statement.from.value;
    await timeStep(`getNodeModuleTypings ${importPath}`, async () => {
      const typings = await getNodeModuleTypings(filePath, importPath);
      process.stdout.write(`  declarations(${importPath}): ${typings?.declarations.length ?? 0}\n`);
      return typings;
    });
  }

  const collected = await timeStep("collectAllImportedDeclarations", () =>
    collectAllImportedDeclarations(baseSession.ast!, {
      uri: document.uri,
      sourceRoots: [workspaceRoot],
      getSessionForFilePath,
      ambientModuleDeclarations: ambientTypes.moduleDeclarations,
      ambientGlobalDeclarations: ambientTypes.globalDeclarations
    })
  );

  await timeStep("enriched createAnalysisSession", () =>
    createAnalysisSession(
      source,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [...domDeclarations, ...ambientTypes.globalDeclarations],
      ambientTypes.moduleDeclarations,
      ambientTypes.moduleDeclarationLocations,
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings,
      new Map([
        ...domDeclarationLocations,
        ...ambientTypes.globalDeclarationLocations
      ])
    )
  );

  const analysisSessions = new AnalysisSessionCache(async (_document, session) => {
    const collectedExternals = await collectAllImportedDeclarations(session.ast!, {
      uri: document.uri,
      sourceRoots: [workspaceRoot],
      getSessionForFilePath,
      ambientModuleDeclarations: ambientTypes.moduleDeclarations,
      ambientGlobalDeclarations: ambientTypes.globalDeclarations
    });
    return {
      externalDeclarations: collectedExternals.externalDeclarations,
      importedSymbolTypes: collectedExternals.importedSymbolTypes,
      importedSymbolDisplayTypes: collectedExternals.importedSymbolDisplayTypes,
      invalidImportedBindings: collectedExternals.invalidImportedBindings,
      ambientDeclarations: [...domDeclarations, ...ambientTypes.globalDeclarations],
      ambientDeclarationLocations: new Map([
        ...domDeclarationLocations,
        ...ambientTypes.globalDeclarationLocations
      ]),
      ambientModuleDeclarations: ambientTypes.moduleDeclarations,
      ambientModuleLocations: ambientTypes.moduleDeclarationLocations
    };
  });

  await timeStep("AnalysisSessionCache.getForDocumentAsync (cold)", () =>
    analysisSessions.getForDocumentAsync(document)
  );
  await timeStep("AnalysisSessionCache.getForDocumentAsync (warm)", () =>
    analysisSessions.getForDocumentAsync(document)
  );
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
