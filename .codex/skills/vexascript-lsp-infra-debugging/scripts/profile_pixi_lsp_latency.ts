import { readFile } from "node:fs/promises";
import { resolve as resolveNodePath } from "node:path";
import "cli/localVfs";
import { TextDocument } from "vscode-languageserver-textdocument";
import { AnalysisSessionCache, createAnalysisSession } from "compiler/lsp/analysisSession";
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
import { collectCrossFileMemberDiagnostics } from "compiler/lsp/memberDiagnostics";
import { collectDeprecatedDiagnostics } from "compiler/lsp/deprecatedDiagnostics";
import { collectDeprecatedSemanticTokenModifiers } from "compiler/lsp/deprecatedSemanticTokens";
import { createSemanticTokens } from "compiler/lsp/semanticTokens";
import { collectDiagnosticsFromSession } from "compiler/lsp/diagnostics";

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

async function createPixiAnalysisSessionCache(sourceRoots: string[]): Promise<{
  analysisSessions: AnalysisSessionCache;
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
        importedSymbolTypes: new Map(),
        importedSymbolDisplayTypes: new Map(),
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
      importedSymbolTypes,
      importedSymbolDisplayTypes,
      invalidImportedBindings
    } = await collectAllImportedDeclarations(baseSession.ast, context);

    return {
      externalDeclarations,
      importedSymbolTypes,
      importedSymbolDisplayTypes,
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

  return {
    analysisSessions,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    projectIndex
  };
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const sampleRoot = resolveNodePath(workspaceRoot, "samples/pixi");
  const sourceRoots = [sampleRoot];
  const filePath = resolveNodePath(sampleRoot, "html.vx");
  const uri = toFileUri(filePath);
  const source = await readFile(filePath, "utf8");
  const document = TextDocument.create(uri, "vexa", 1, source);

  const { analysisSessions, getSessionForFilePath, projectIndex } = await createPixiAnalysisSessionCache(sourceRoots);
  await projectIndex.upsertOpenDocument(filePath, source);

  const featureContext = {
    uri,
    sourceRoots,
    getSessionForFilePath
  };

  const coldSession = await time(async () => analysisSessions.getForDocumentAsync(document));
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
  const deprecatedDiagnostics = await time(async () =>
    collectDeprecatedDiagnostics({
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
  const deprecatedSemanticTokenModifiers = await time(async () =>
    collectDeprecatedSemanticTokenModifiers({
      ...featureContext,
      session
    })
  );
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
        collectCrossFileTypeDiagnostics({ ...featureContext, session: sharedSession }),
        collectDeprecatedDiagnostics({ ...featureContext, session: sharedSession })
      ]),
      Promise.all([
        collectCrossFileMemberDiagnostics({ ...featureContext, session: sharedSession }),
        collectCrossFileTypeDiagnostics({ ...featureContext, session: sharedSession }),
        collectDeprecatedDiagnostics({ ...featureContext, session: sharedSession })
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

  const lines = [
    `sample: ${filePath}`,
    `cold session: ${formatMs(coldSession.durationMs)}ms`,
    `document diagnostics sync-only: ${formatMs(syncDiagnostics.durationMs)}ms (${syncDiagnostics.value.length} items)`,
    `module-not-found diagnostics: ${formatMs(moduleNotFoundDiagnostics.durationMs)}ms (${moduleNotFoundDiagnostics.value.length} items)`,
    `cross-file type diagnostics: ${formatMs(crossFileTypeDiagnostics.durationMs)}ms (${crossFileTypeDiagnostics.value.length} items)`,
    `deprecated diagnostics: ${formatMs(deprecatedDiagnostics.durationMs)}ms (${deprecatedDiagnostics.value.length} items)`,
    `workspace-only member diagnostics: ${formatMs(crossFileMemberDiagnostics.durationMs)}ms (${crossFileMemberDiagnostics.value.length} items)`,
    `deprecated semantic modifiers: ${formatMs(deprecatedSemanticTokenModifiers.durationMs)}ms (${deprecatedSemanticTokenModifiers.value.size} entries)`,
    `semantic tokens full: ${formatMs(semanticTokensFull.durationMs)}ms (${semanticTokensFull.value.data.length} ints)`,
    `semantic tokens range: ${formatMs(semanticTokensRange.durationMs)}ms (${semanticTokensRange.value.data.length} ints)`,
    `approx concurrent diagnostic+workspace+semantic burst: ${formatMs(concurrent.durationMs)}ms`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
