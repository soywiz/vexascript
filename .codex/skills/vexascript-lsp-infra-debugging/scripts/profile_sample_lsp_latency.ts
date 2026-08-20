/** Profiles the real compiler/LSP workload for a package-backed sample. */
import { readFile } from "node:fs/promises";
import { resolve as resolveNodePath } from "node:path";
import "cli/localVfs";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  AnalysisSessionCache,
  createAnalysisSession,
  type AnalysisSessionCacheProfileEvent
} from "compiler/lsp/analysisSession";
import { collectAllImportedDeclarations } from "compiler/lsp/importedDeclarations";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadProject } from "compiler/project";
import { loadAmbientTypesForProject } from "compiler/lsp/ambientTypesLoader";
import { getProjectIndex, type ProjectIndex } from "compiler/lsp/projectAnalysis";
import { uriToFilePath } from "compiler/lsp/importFixes";
import {
  collectCrossFileTypeDiagnostics,
  collectModuleNotFoundDiagnostics
} from "compiler/lsp/crossFileTypeDiagnostics";
import {
  collectCrossFileMemberDiagnostics,
  getCrossFileMemberDiagnosticWorkMetrics,
  resetCrossFileMemberDiagnosticWorkMetrics
} from "compiler/lsp/memberDiagnostics";
import {
  collectDeprecatedSemanticTokenModifiers,
  getDeprecatedSemanticTokenWorkMetrics,
  resetDeprecatedSemanticTokenWorkMetrics
} from "compiler/lsp/deprecatedSemanticTokens";
import { createSemanticTokens } from "compiler/lsp/semanticTokens";
import { collectDiagnosticsFromSession } from "compiler/lsp/diagnostics";
import {
  getTypeComparisonCalls,
  getTypeRenderMetrics,
  resetTypeComparisonCalls,
  resetTypeRenderMetrics
} from "compiler/analysis/types";

interface TimedResult<T> {
  durationMs: number;
  value: T;
}

function nowMs(): number {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

async function time<T>(run: () => Promise<T> | T): Promise<TimedResult<T>> {
  const startedAt = nowMs();
  const value = await run();
  return {
    durationMs: nowMs() - startedAt,
    value
  };
}

function formatMs(value: number): string {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function toFileUri(filePath: string): string {
  return `file://${filePath}`;
}

async function createSampleAnalysisSessionCache(sourceRoots: string[]): Promise<{
  analysisSessions: AnalysisSessionCache;
  sessionProfileEvents: AnalysisSessionCacheProfileEvent[];
  getSessionForFilePath: (filePath: string) => Promise<ReturnType<ProjectIndex["getSessionForFilePath"]> extends Promise<infer T> ? T : never>;
  projectIndex: ProjectIndex;
}> {
  const projectIndex = getProjectIndex(sourceRoots);

  async function getSessionForFilePathFromOpenDocuments(filePath: string) {
    return projectIndex.getSessionForFilePath(resolveNodePath(filePath));
  }

  const analysisSessions = new AnalysisSessionCache(async (document, baseSession) => {
    if (!baseSession.ast) {
      return {
        externalDeclarations: [],
        importedSymbols: new Map(),
        ambientDeclarations: [],
        ambientModuleDeclarations: new Map()
      };
    }

    const filePath = uriToFilePath(document.uri);
    const project = filePath ? await loadProject(filePath) : null;
    const ambientTypes = await loadAmbientTypesForProject(filePath, project?.types ?? []);
    const domDeclarations = (project?.libs ?? []).some((lib) => lib.toLowerCase() === "dom")
      ? (await ensureDomProgram()).body
      : [];
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

    const context = {
      uri: document.uri,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
      ambientModuleDeclarations: ambientTypes.moduleDeclarations,
      ambientGlobalDeclarations: ambientTypes.globalDeclarations
    };
    const {
      externalDeclarations,
      externalDeclarationLocations,
      importedSymbols,
      invalidImportedBindings
    } = await collectAllImportedDeclarations(baseSession.ast, context);

    return {
      externalDeclarations,
      externalDeclarationLocations,
      importedSymbols,
      invalidImportedBindings,
      ambientDeclarations: [...domDeclarations, ...ambientTypes.globalDeclarations],
      ambientDeclarationLocations: new Map([
        ...domDeclarationLocations,
        ...ambientTypes.globalDeclarationLocations
      ]),
      ambientModuleDeclarations: ambientTypes.moduleDeclarations,
      ambientModuleLocations: ambientTypes.moduleDeclarationLocations
    };
  });
  const sessionProfileEvents: AnalysisSessionCacheProfileEvent[] = [];
  analysisSessions.setProfileObserver((event) => sessionProfileEvents.push(event));

  return {
    analysisSessions,
    sessionProfileEvents,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    projectIndex
  };
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const sampleName = process.argv[2] ?? "pixi";
  const editScenario = process.argv[3] ?? "newline";
  const entryFileName = process.argv[4] ?? "html.vx";
  const sampleRoot = resolveNodePath(workspaceRoot, `samples/${sampleName}`);
  const sourceRoots = [sampleRoot];
  const filePath = resolveNodePath(sampleRoot, entryFileName);
  const uri = toFileUri(filePath);
  const source = await readFile(filePath, "utf8");
  const document = TextDocument.create(uri, "vexa", 1, source);

  const {
    analysisSessions,
    sessionProfileEvents,
    getSessionForFilePath,
    projectIndex
  } = await createSampleAnalysisSessionCache(sourceRoots);
  await projectIndex.upsertOpenDocument(filePath, source);

  const featureContext = {
    uri,
    sourceRoots,
    getSessionForFilePath
  };

  resetTypeComparisonCalls();
  resetTypeRenderMetrics();
  const coldSession = await time(async () => analysisSessions.getForDocumentAsync(document));
  const coldTypeComparisonCalls = getTypeComparisonCalls();
  const coldTypeRenderMetrics = getTypeRenderMetrics();
  const coldSessionProfile = [...sessionProfileEvents];
  sessionProfileEvents.length = 0;
  const session = coldSession.value;

  const syncDiagnostics = await time(async () =>
    collectDiagnosticsFromSession(session, source, (offset) => document.positionAt(offset))
  );
  const moduleNotFoundDiagnostics = await time(async () =>
    collectModuleNotFoundDiagnostics({
      uri,
      session,
      getSessionForFilePath
    })
  );
  const crossFileTypeDiagnostics = await time(async () =>
    collectCrossFileTypeDiagnostics({
      ...featureContext,
      session
    })
  );
  const crossFileMemberDiagnostics = await time(async () =>
    collectCrossFileMemberDiagnostics({
      ...featureContext,
      session
    })
  );
  projectIndex.resetMetrics();
  resetDeprecatedSemanticTokenWorkMetrics();
  const deprecatedSemanticTokenModifiers = await time(async () =>
    collectDeprecatedSemanticTokenModifiers({
      ...featureContext,
      session
    })
  );
  const deprecatedSemanticTokenWork = projectIndex.getMetrics();
  const deprecatedSemanticTokenCounters = getDeprecatedSemanticTokenWorkMetrics();
  projectIndex.resetMetrics();
  resetDeprecatedSemanticTokenWorkMetrics();
  const warmDeprecatedSemanticTokenModifiers = await time(async () =>
    collectDeprecatedSemanticTokenModifiers({
      ...featureContext,
      session
    })
  );
  const warmDeprecatedSemanticTokenWork = projectIndex.getMetrics();
  const warmDeprecatedSemanticTokenCounters = getDeprecatedSemanticTokenWorkMetrics();
  const semanticTokensFull = await time(async () =>
    createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      tokenModifiersByRangeKey: deprecatedSemanticTokenModifiers.value
    })
  );
  const semanticTokensRange = await time(async () =>
    createSemanticTokens({
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      range: {
        start: { line: 21, character: 0 },
        end: { line: 33, character: 0 }
      },
      tokenModifiersByRangeKey: deprecatedSemanticTokenModifiers.value
    })
  );

  const concurrent = await time(async () => {
    const sharedSession = await analysisSessions.getForDocumentAsync(document);
    return Promise.all([
      Promise.all([
        collectDiagnosticsFromSession(sharedSession, source, (offset) => document.positionAt(offset)),
        collectModuleNotFoundDiagnostics({ uri, session: sharedSession, getSessionForFilePath }),
        collectCrossFileTypeDiagnostics({ ...featureContext, session: sharedSession })
      ]),
      Promise.all([
        collectCrossFileMemberDiagnostics({ ...featureContext, session: sharedSession }),
        collectCrossFileTypeDiagnostics({ ...featureContext, session: sharedSession })
      ]),
      (async () => {
        const modifiers = await collectDeprecatedSemanticTokenModifiers({ ...featureContext, session: sharedSession });
        return createSemanticTokens({
          text: source,
          ast: sharedSession.ast,
          analysis: sharedSession.analysis,
          tokenModifiersByRangeKey: modifiers
        });
      })(),
      (async () => {
        const modifiers = await collectDeprecatedSemanticTokenModifiers({ ...featureContext, session: sharedSession });
        return createSemanticTokens({
          text: source,
          ast: sharedSession.ast,
          analysis: sharedSession.analysis,
          range: {
            start: { line: 21, character: 0 },
            end: { line: 33, character: 0 }
          },
          tokenModifiersByRangeKey: modifiers
        });
      })()
    ]);
  });

  const editedSource = editScenario === "incomplete-member"
    ? source.replace(
        "const trend = line<Reading>()\n  .x((reading)",
        "const trend = line<Reading>()\n  .x\n  .x((reading)"
      )
    : editScenario === "extra-argument"
      ? source.replace("delay(1000)", "delay(1000, x)")
      : `${source}\n`;
  if (editedSource === source) {
    throw new Error(`Edit scenario '${editScenario}' did not change ${filePath}`);
  }
  const editedDocument = TextDocument.create(uri, "vexa", 2, editedSource);
  await projectIndex.upsertOpenDocument(filePath, editedSource);
  analysisSessions.resetMetrics();
  resetTypeComparisonCalls();
  resetTypeRenderMetrics();
  const editedSession = await time(async () => analysisSessions.getForDocumentAsync(editedDocument));
  const editedTypeComparisonCalls = getTypeComparisonCalls();
  const editedTypeRenderMetrics = getTypeRenderMetrics();
  const editedSessionProfile = [...sessionProfileEvents];
  projectIndex.resetMetrics();
  resetDeprecatedSemanticTokenWorkMetrics();
  const editedDeprecatedSemanticTokenModifiers = await time(async () =>
    collectDeprecatedSemanticTokenModifiers({
      ...featureContext,
      session: editedSession.value
    })
  );
  const editedDeprecatedSemanticTokenWork = projectIndex.getMetrics();
  const editedDeprecatedSemanticTokenCounters = getDeprecatedSemanticTokenWorkMetrics();
  projectIndex.resetMetrics();
  resetCrossFileMemberDiagnosticWorkMetrics();
  const editedWorkspaceMemberDiagnostics = await time(async () =>
    collectCrossFileMemberDiagnostics({
      ...featureContext,
      session: editedSession.value
    })
  );
  const editedWorkspaceMemberDiagnosticWork = projectIndex.getMetrics();
  const editedWorkspaceMemberDiagnosticCounters = getCrossFileMemberDiagnosticWorkMetrics();
  const editedAnalysisSessionWork = analysisSessions.getMetrics();

  const lines = [
    `sample: ${filePath}`,
    `cold session: ${formatMs(coldSession.durationMs)}ms`,
    `cold session self profile: ${JSON.stringify(coldSessionProfile)}`,
    `cold session type comparisons: ${coldTypeComparisonCalls}`,
    `cold session type rendering: ${JSON.stringify(coldTypeRenderMetrics)}`,
    `document diagnostics sync-only: ${formatMs(syncDiagnostics.durationMs)}ms (${syncDiagnostics.value.length} items)`,
    `module-not-found diagnostics: ${formatMs(moduleNotFoundDiagnostics.durationMs)}ms (${moduleNotFoundDiagnostics.value.length} items)`,
    `cross-file type diagnostics: ${formatMs(crossFileTypeDiagnostics.durationMs)}ms (${crossFileTypeDiagnostics.value.length} items)`,
    `workspace-only member diagnostics: ${formatMs(crossFileMemberDiagnostics.durationMs)}ms (${crossFileMemberDiagnostics.value.length} items)`,
    `deprecated semantic modifiers: ${formatMs(deprecatedSemanticTokenModifiers.durationMs)}ms (${deprecatedSemanticTokenModifiers.value.size} entries)`,
    `deprecated semantic modifier project work: ${JSON.stringify(deprecatedSemanticTokenWork)}`,
    `deprecated semantic modifier counters: ${JSON.stringify(deprecatedSemanticTokenCounters)}`,
    `warm deprecated semantic modifiers: ${formatMs(warmDeprecatedSemanticTokenModifiers.durationMs)}ms (${warmDeprecatedSemanticTokenModifiers.value.size} entries)`,
    `warm deprecated semantic modifier project work: ${JSON.stringify(warmDeprecatedSemanticTokenWork)}`,
    `warm deprecated semantic modifier counters: ${JSON.stringify(warmDeprecatedSemanticTokenCounters)}`,
    `semantic tokens full: ${formatMs(semanticTokensFull.durationMs)}ms (${semanticTokensFull.value.data.length} ints)`,
    `semantic tokens range: ${formatMs(semanticTokensRange.durationMs)}ms (${semanticTokensRange.value.data.length} ints)`,
    `approx concurrent diagnostic+workspace+semantic burst: ${formatMs(concurrent.durationMs)}ms`,
    `edited session: ${formatMs(editedSession.durationMs)}ms`,
    `edited session self profile: ${JSON.stringify(editedSessionProfile)}`,
    `edited session type comparisons: ${editedTypeComparisonCalls}`,
    `edited session type rendering: ${JSON.stringify(editedTypeRenderMetrics)}`,
    `edited session work: ${JSON.stringify(editedAnalysisSessionWork)}`,
    `edited deprecated semantic modifiers: ${formatMs(editedDeprecatedSemanticTokenModifiers.durationMs)}ms (${editedDeprecatedSemanticTokenModifiers.value.size} entries)`,
    `edited deprecated semantic modifier project work: ${JSON.stringify(editedDeprecatedSemanticTokenWork)}`,
    `edited deprecated semantic modifier counters: ${JSON.stringify(editedDeprecatedSemanticTokenCounters)}`,
    `edited workspace-only member diagnostics: ${formatMs(editedWorkspaceMemberDiagnostics.durationMs)}ms (${editedWorkspaceMemberDiagnostics.value.length} items)`,
    `edited workspace-only member diagnostic project work: ${JSON.stringify(editedWorkspaceMemberDiagnosticWork)}`,
    `edited workspace-only member diagnostic counters: ${JSON.stringify(editedWorkspaceMemberDiagnosticCounters)}`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
