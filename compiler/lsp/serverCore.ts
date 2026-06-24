/**
 * Shared LSP request-handler core.
 *
 * Registers every document-lifecycle and request handler that the Node stdio
 * server (`server.ts`) and the browser Web Worker server (`server-browser.ts`)
 * have in common, so the two transports cannot drift apart. Environment
 * differences (workspace source roots, project index lookups, watched-file
 * invalidation, workspace-wide diagnostics/symbols) are injected through
 * {@link LspServerEnvironment}; cross-file feature collectors degrade to
 * single-file behavior when the environment provides no source roots.
 *
 * Protocol constants are inlined (same approach as `diagnostics.ts`) and
 * `vscode-languageserver` is only imported for types, so this module stays
 * loadable from both Node and browser bundles.
 */
import type {
  Connection,
  Diagnostic,
  InitializeParams,
  Range,
  SemanticTokens,
  TextDocuments,
  TextEdit
} from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ProjectSessionLike } from "compiler/analysis/projectIndex";
import { COMPILER_VERSION } from "compiler/compilerVersion";
import { AnalysisSessionCache, createAnalysisSession } from "./analysisSession";
import type { AnalysisSession } from "./analysisSession";
import { collectCodeActions } from "./codeActionsAggregate";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "./formatting";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";
import { collectCrossFileTypeDiagnostics, collectModuleNotFoundDiagnostics } from "./crossFileTypeDiagnostics";
import { buildAmbientModuleSymbolExports, buildAutoImportSuggestions, buildSymbolExports, uriToFilePath } from "./importFixes";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import {
  resolveDefinitionWithLocalFallback,
  resolveHoverWithLocalFallback,
  resolvePrepareRenameAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import {
  candidateCharacters,
  createRenameWorkspaceEdit
} from "./navigation";
import { createSignatureHelp } from "./signatureHelp";
import { createInlayHints } from "./inlayHints";
import { clearAmbientTypesCache } from "./ambientTypesLoader";
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";
export { candidateCharacters } from "./navigation";
import {
  createSemanticTokens,
  sliceSemanticTokensByRange,
  VEXA_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";
import { collectDeprecatedSemanticTokenModifiers } from "./deprecatedSemanticTokens";
import { clearNodeModuleTypingsCache } from "./nodeModulesTypings";
import {
  createDocumentHighlights,
  createFoldingRanges,
  createOnTypeFormattingEdits,
  createReferenceCodeLenses,
  createSelectionRanges,
  prepareCallHierarchy,
  createIncomingCalls,
  createOutgoingCalls
} from "./documentFeatures";

// Inlined protocol constants so this module never needs runtime imports from
// the environment-specific vscode-languageserver entrypoints.
const TextDocumentSyncKind = { Incremental: 2 } as const;
const DocumentDiagnosticReportKind = { Full: "full" } as const;

export type GetSessionForFilePath = (
  filePath: string
) => ProjectSessionLike | null | Promise<ProjectSessionLike | null>;

/** Workspace-wide capabilities only available when a file-system workspace exists. */
export interface LspWorkspaceFeatures {
  /** Command id advertised via executeCommandProvider that re-publishes diagnostics. */
  refreshDiagnosticsCommand: string;
  /** Invalidates a changed/removed on-disk file in the workspace index. */
  onWatchedFileChanged: (filePath: string) => void;
}

export interface LspServerEnvironment {
  /** Workspace folders used by cross-file features; empty in browser workers. */
  getSourceRoots(): string[];
  /** Resolves the analysis session for a project file; `() => null` without a workspace. */
  getSessionForFilePath: GetSessionForFilePath;
  /** Called with the raw initialize params before capabilities are computed. */
  onInitialize?(params: InitializeParams): void;
  /** Keeps a workspace index in sync with the open editor documents. */
  onDocumentOpenedOrChanged?(document: TextDocument): void;
  onDocumentClosed?(document: TextDocument): void;
  /** Present when the environment supports workspace diagnostics/symbols (Node server). */
  workspace?: LspWorkspaceFeatures;
}

export function completionPrefixAt(text: string, offset: number): string {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i > 0) {
    const ch = text[i - 1] ?? "";
    if (!/[A-Za-z0-9_]/.test(ch)) {
      break;
    }
    i -= 1;
  }
  return text.slice(i, offset);
}

export interface LspServerOptions {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  analysisSessions: AnalysisSessionCache;
  environment: LspServerEnvironment;
}

export function startLspServer(options: LspServerOptions): void {
  const { connection, documents, analysisSessions, environment } = options;
  const workspace = environment.workspace;
  let inlayHintsParameters = false;
  let inlayHintsTypes = false;
  let referenceCodeLensEnabled = false;
  let lspTimingsEnabled = false;
  let lspTimingCacheEventsEnabled = false;
  const documentDiagnosticCache = new Map<string, { version: number; promise: Promise<{ items: Diagnostic[]; resultId: string }> }>();
  const workspaceDiagnosticCache = new Map<string, { version: number; promise: Promise<Diagnostic[]> }>();
  const crossFileTypeDiagnosticsCache = new Map<string, { version: number; promise: Promise<Diagnostic[]> }>();
  const deprecatedSemanticTokenModifiersCache = new Map<string, { version: number; promise: Promise<Map<string, number>> }>();
  const workspaceMemberDiagnosticsCache = new Map<string, { version: number; promise: Promise<Diagnostic[]> }>();
  const semanticTokensCache = new Map<string, { version: number; promise: Promise<SemanticTokens> }>();
  const codeActionCache = new Map<string, { version: number; promise: Promise<ReturnType<typeof deferCodeActions>> }>();

  function nowMs(): number {
    return typeof globalThis.performance?.now === "function"
      ? globalThis.performance.now()
      : Date.now();
  }

  function formatDurationMs(durationMs: number): string {
    return durationMs >= 10 ? durationMs.toFixed(1) : durationMs.toFixed(2);
  }

  function logTimingMessage(message: string): void {
    if (lspTimingsEnabled) {
      connection.console.info(`[Timing] ${message}`);
    }
  }

  async function logTimedOperation<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    const startedAt = nowMs();
    try {
      return await run();
    } finally {
      logTimingMessage(`${name} took ${formatDurationMs(nowMs() - startedAt)}ms`);
    }
  }

  function logTimedOperationSync<T>(name: string, run: () => T): T {
    const startedAt = nowMs();
    try {
      return run();
    } finally {
      logTimingMessage(`${name} took ${formatDurationMs(nowMs() - startedAt)}ms`);
    }
  }

  async function logTimedPhase<T>(operationName: string, phaseName: string, run: () => Promise<T> | T): Promise<T> {
    const startedAt = nowMs();
    try {
      return await run();
    } finally {
      logTimingMessage(`${operationName}::${phaseName} took ${formatDurationMs(nowMs() - startedAt)}ms`);
    }
  }

  function logCacheState(operationName: string, state: "hit" | "miss", version: number): void {
    if (lspTimingCacheEventsEnabled) {
      logTimingMessage(`${operationName} cache ${state} v${version}`);
    }
  }

  function refreshDiagnostics(): void {
    connection.languages.diagnostics.refresh();
  }

  function invalidateDocumentCaches(uri: string): void {
    documentDiagnosticCache.delete(uri);
    workspaceDiagnosticCache.delete(uri);
    crossFileTypeDiagnosticsCache.delete(uri);
    deprecatedSemanticTokenModifiersCache.delete(uri);
    workspaceMemberDiagnosticsCache.delete(uri);
    for (const key of codeActionCache.keys()) {
      if (key.startsWith(`${uri}|`)) {
        codeActionCache.delete(key);
      }
    }
    for (const key of semanticTokensCache.keys()) {
      if (key.startsWith(`${uri}|`)) {
        semanticTokensCache.delete(key);
      }
    }
  }

  function invalidateAllCaches(): void {
    documentDiagnosticCache.clear();
    workspaceDiagnosticCache.clear();
    crossFileTypeDiagnosticsCache.clear();
    deprecatedSemanticTokenModifiersCache.clear();
    workspaceMemberDiagnosticsCache.clear();
    semanticTokensCache.clear();
    codeActionCache.clear();
  }

  function featureContext(uri: string) {
    return {
      uri,
      sourceRoots: environment.getSourceRoots(),
      getSessionForFilePath: environment.getSessionForFilePath
    };
  }

  async function getExportedSymbolsForSession(session: AnalysisSession) {
    return [
      ...await buildSymbolExports(environment.getSourceRoots()),
      ...buildAmbientModuleSymbolExports({
        moduleDeclarations: session.ambientModuleDeclarations,
        moduleLocations: session.ambientModuleLocations
      })
    ];
  }

  async function collectWorkspaceDiagnosticsForDocument(doc: TextDocument): Promise<Diagnostic[]> {
    const session = await analysisSessions.getForDocumentAsync(doc);
    const [crossFileDiagnostics, crossFileTypeDiagnostics] = await Promise.all([
      getWorkspaceMemberDiagnosticsForDocument(doc, session),
      getCrossFileTypeDiagnosticsForDocument(doc, session)
    ]);
    const sameFileKeys = new Set(
      session.semanticIssues.map((issue) => {
        const token = issue.node.firstToken;
        if (!token) {
          return issue.message;
        }
        return `${token.range.start.line}:${token.range.start.column}:${issue.message}`;
      })
    );
    return [...crossFileDiagnostics, ...crossFileTypeDiagnostics].filter((diagnostic) => {
      const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
      return !sameFileKeys.has(key);
    });
  }

  async function getCrossFileTypeDiagnosticsForDocument(
    doc: TextDocument,
    session?: AnalysisSession
  ): Promise<Diagnostic[]> {
    const cached = crossFileTypeDiagnosticsCache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      logCacheState("crossFileTypeDiagnostics", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("crossFileTypeDiagnostics", "miss", doc.version);
    const promise = (async () => {
      const resolvedSession = session ?? await logTimedPhase("crossFileTypeDiagnostics", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      return logTimedPhase("crossFileTypeDiagnostics", "collect", () =>
        collectCrossFileTypeDiagnostics({
          ...featureContext(doc.uri),
          session: resolvedSession
        })
      );
    })();
    crossFileTypeDiagnosticsCache.set(doc.uri, { version: doc.version, promise });
    return promise;
  }

  async function getWorkspaceMemberDiagnosticsForDocument(
    doc: TextDocument,
    session?: AnalysisSession
  ): Promise<Diagnostic[]> {
    const cached = workspaceMemberDiagnosticsCache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      logCacheState("workspaceMemberDiagnostics", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("workspaceMemberDiagnostics", "miss", doc.version);
    const promise = (async () => {
      const resolvedSession = session ?? await logTimedPhase("workspaceMemberDiagnostics", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      return logTimedPhase("workspaceMemberDiagnostics", "collect", () =>
        collectCrossFileMemberDiagnostics({
          ...featureContext(doc.uri),
          session: resolvedSession
        })
      );
    })();
    workspaceMemberDiagnosticsCache.set(doc.uri, { version: doc.version, promise });
    return promise;
  }

  async function getDeprecatedSemanticTokenModifiers(
    doc: TextDocument,
    session?: AnalysisSession
  ): Promise<Map<string, number>> {
    const cached = deprecatedSemanticTokenModifiersCache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      logCacheState("deprecatedSemanticTokenModifiers", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("deprecatedSemanticTokenModifiers", "miss", doc.version);
    const promise = (async () => {
      const resolvedSession = session ?? await logTimedPhase("deprecatedSemanticTokenModifiers", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      return logTimedPhase("deprecatedSemanticTokenModifiers", "collect", () =>
        collectDeprecatedSemanticTokenModifiers({
          ...featureContext(doc.uri),
          session: resolvedSession
        })
      );
    })();
    deprecatedSemanticTokenModifiersCache.set(doc.uri, { version: doc.version, promise });
    return promise;
  }

  async function getDocumentDiagnosticArtifacts(doc: TextDocument): Promise<{ items: Diagnostic[]; resultId: string }> {
    const cached = documentDiagnosticCache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      logCacheState("textDocument/diagnostic", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("textDocument/diagnostic", "miss", doc.version);
    const promise = logTimedOperation("textDocument/diagnostic", async () => {
      const session = await logTimedPhase("textDocument/diagnostic", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      const [moduleNotFoundDiagnostics, crossFileTypeDiagnostics] = await Promise.all([
        logTimedPhase("textDocument/diagnostic", "moduleNotFoundDiagnostics", () =>
          collectModuleNotFoundDiagnostics({
            uri: doc.uri,
            session,
            getSessionForFilePath: environment.getSessionForFilePath
          })
        ),
        logTimedPhase("textDocument/diagnostic", "crossFileTypeDiagnostics", () =>
          getCrossFileTypeDiagnosticsForDocument(doc, session)
        )
      ]);
      const syncDiagnostics = await logTimedPhase("textDocument/diagnostic", "localDiagnostics", () =>
        collectDiagnosticsFromSession(session, doc.getText(), (offset) => doc.positionAt(offset))
      );
      return {
        items: [...syncDiagnostics, ...moduleNotFoundDiagnostics, ...crossFileTypeDiagnostics],
        resultId: String(doc.version)
      };
    });
    documentDiagnosticCache.set(doc.uri, { version: doc.version, promise });
    return promise;
  }

  async function getWorkspaceDiagnosticsForDocument(doc: TextDocument): Promise<Diagnostic[]> {
    const cached = workspaceDiagnosticCache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      logCacheState("workspace/diagnostic", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("workspace/diagnostic", "miss", doc.version);
    const promise = collectWorkspaceDiagnosticsForDocument(doc);
    workspaceDiagnosticCache.set(doc.uri, { version: doc.version, promise });
    return promise;
  }

  connection.onInitialize((params) =>
    logTimedOperationSync("initialize", () => {
      environment.onInitialize?.(params);
      referenceCodeLensEnabled = params.initializationOptions?.enableReferenceCodeLens === true;
      inlayHintsParameters = params.initializationOptions?.enableInlayHintsParameters !== false;
      inlayHintsTypes = params.initializationOptions?.enableInlayHintsTypes !== false;
      lspTimingsEnabled = params.initializationOptions?.enableLspTimings === true;
      lspTimingCacheEventsEnabled =
        lspTimingsEnabled && params.initializationOptions?.enableLspTimingCacheEvents === true;
      return {
        serverInfo: {
          name: "VexaScript",
          version: COMPILER_VERSION
        },
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Incremental,
          completionProvider: {
            resolveProvider: false,
            triggerCharacters: [".", "@", ":"]
          },
          codeActionProvider: {
            resolveProvider: true
          },
          ...(workspace
            ? { executeCommandProvider: { commands: [workspace.refreshDiagnosticsCommand] } }
            : {}),
          documentFormattingProvider: true,
          documentRangeFormattingProvider: true,
          definitionProvider: true,
          declarationProvider: true,
          typeDefinitionProvider: true,
          implementationProvider: true,
          documentHighlightProvider: true,
          ...(referenceCodeLensEnabled ? { codeLensProvider: { resolveProvider: false } } : {}),
          foldingRangeProvider: true,
          selectionRangeProvider: true,
          linkedEditingRangeProvider: true,
          callHierarchyProvider: true,
          diagnosticProvider: {
            interFileDependencies: workspace !== undefined,
            workspaceDiagnostics: workspace !== undefined
          },
          documentOnTypeFormattingProvider: {
            firstTriggerCharacter: "\n",
            moreTriggerCharacter: ["}"]
          },
          hoverProvider: true,
          referencesProvider: true,
          signatureHelpProvider: {
            triggerCharacters: ["(", ","],
            retriggerCharacters: [","]
          },
          documentSymbolProvider: true,
          ...(workspace ? { workspaceSymbolProvider: true } : {}),
          semanticTokensProvider: {
            legend: VEXA_SEMANTIC_TOKENS_LEGEND,
            full: true,
            range: true
          },
          inlayHintProvider: true,
          renameProvider: {
            prepareProvider: true
          }
        }
      };
    })
  );

  connection.onInitialized(() => {
    connection.console.info(`VexaScript compiler version: ${COMPILER_VERSION}`);
  });

  documents.onDidOpen((event) => {
    logTimedOperationSync("textDocument/didOpen", () => {
      invalidateDocumentCaches(event.document.uri);
      environment.onDocumentOpenedOrChanged?.(event.document);
      refreshDiagnostics();
    });
  });
  documents.onDidChangeContent((event) => {
    logTimedOperationSync("textDocument/didChange", () => {
      invalidateDocumentCaches(event.document.uri);
      environment.onDocumentOpenedOrChanged?.(event.document);
      refreshDiagnostics();
    });
  });
  documents.onDidClose((event) => {
    logTimedOperationSync("textDocument/didClose", () => {
      invalidateDocumentCaches(event.document.uri);
      analysisSessions.delete(event.document.uri);
      environment.onDocumentClosed?.(event.document);
      refreshDiagnostics();
    });
  });

  connection.onCompletion((params) => logTimedOperation("textDocument/completion", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return createKeywordOnlyCompletionItems();
    }

    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.ast) {
      return createKeywordOnlyCompletionItems();
    }
    const text = doc.getText();
    const prefix = completionPrefixAt(text, doc.offsetAt(params.position));
    const visibleSymbols = session.analysis?.getVisibleSymbolsAt(
      params.position.line,
      params.position.character
    ) ?? [];
    const autoImportSuggestions = await buildAutoImportSuggestions({
      uri: doc.uri,
      ast: session.ast,
      sourceRoots: environment.getSourceRoots(),
      getExportedSymbols: () => getExportedSymbolsForSession(session),
      prefix,
      excludeSymbols: new Set(visibleSymbols.map((symbol) => symbol.name))
    });

    return createCompletionItemsForPosition(
      session.ast,
      params.position.line,
      params.position.character,
      session.analysis,
      autoImportSuggestions,
      {
        text,
        ...featureContext(doc.uri),
        ambientModuleDeclarations: session.ambientModuleDeclarations,
        recoverAnalysisSession: (source) => createAnalysisSession(source, { externalDeclarations: session.externalDeclarations, ambientDeclarations: session.ambientDeclarations, ambientModuleDeclarations: session.ambientModuleDeclarations, ambientModuleLocations: session.ambientModuleLocations, invalidImportedBindings: session.invalidImportedBindings, ambientDeclarationLocations: session.ambientDeclarationLocations, importedSymbols: session.importedSymbols })
      }
    );
  }));

  connection.onCodeAction(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }
    const key = [
      doc.uri,
      params.range.start.line,
      params.range.start.character,
      params.range.end.line,
      params.range.end.character,
      ...params.context.diagnostics.map((diagnostic) => [
        String(diagnostic.code ?? ""),
        diagnostic.message,
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.range.end.line,
        diagnostic.range.end.character
      ].join(":"))
    ].join("|");
    const cached = codeActionCache.get(key);
    if (cached && cached.version === doc.version) {
      logCacheState("textDocument/codeAction", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("textDocument/codeAction", "miss", doc.version);
    const promise = logTimedOperation("textDocument/codeAction", async () => {
      const session = await logTimedPhase("textDocument/codeAction", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      if (!session.ast) {
        return [];
      }

      const actions = await logTimedPhase("textDocument/codeAction", "collect", () =>
        collectCodeActions({
          ...featureContext(params.textDocument.uri),
          text: doc.getText(),
          ast: session.ast,
          analysis: session.analysis,
          range: params.range,
          diagnostics: params.context.diagnostics,
          getExportedSymbols: () => getExportedSymbolsForSession(session),
          ...(workspace ? { refreshDiagnosticsCommand: workspace.refreshDiagnosticsCommand } : {})
        })
      );

      return deferCodeActions(actions);
    });
    codeActionCache.set(key, { version: doc.version, promise });
    return promise;
  });

  connection.onCodeActionResolve((action) =>
    logTimedOperationSync("codeAction/resolve", () => resolveDeferredCodeAction(action))
  );

  if (workspace) {
    connection.onExecuteCommand((params) => {
      return logTimedOperationSync("workspace/executeCommand", () => {
        if (params.command === workspace.refreshDiagnosticsCommand) {
          refreshDiagnostics();
        }
      });
    });
  }

  connection.onDocumentFormatting((params): TextEdit[] => logTimedOperationSync("textDocument/formatting", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }

    return [createFullDocumentFormatEdit(doc.getText())];
  }));

  connection.onDocumentRangeFormatting((params): TextEdit[] => logTimedOperationSync("textDocument/rangeFormatting", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }

    return [createRangeFormatEdit(doc.getText(), params.range)];
  }));

  async function resolveDefinition(uri: string, line: number, character: number) {
    const doc = documents.get(uri);
    if (!doc) return null;
    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.analysis || !session.ast) return null;
    return await resolveDefinitionWithLocalFallback({
      ...featureContext(uri),
      line,
      character,
      session
    });
  }

  connection.onDefinition((params) =>
    logTimedOperation("textDocument/definition", () => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character))
  );
  connection.onDeclaration((params) =>
    logTimedOperation("textDocument/declaration", () => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character))
  );
  connection.onTypeDefinition((params) =>
    logTimedOperation("textDocument/typeDefinition", () => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character))
  );
  connection.onImplementation((params) =>
    logTimedOperation("textDocument/implementation", () => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character))
  );

  connection.onDocumentHighlight((params) => logTimedOperation("textDocument/documentHighlight", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = await analysisSessions.getForDocumentAsync(doc);
    return session.analysis
      ? createDocumentHighlights(session.analysis, params.position.line, params.position.character, session.ast ?? undefined)
      : [];
  }));

  connection.onHover((params) => logTimedOperation("textDocument/hover", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }

    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.analysis || !session.ast) {
      return null;
    }

    return resolveHoverWithLocalFallback({
      ...featureContext(params.textDocument.uri),
      line: params.position.line,
      character: params.position.character,
      session
    });
  }));

  connection.onPrepareRename((params) => logTimedOperation("textDocument/prepareRename", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }

    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.analysis) {
      return null;
    }

    return resolvePrepareRenameAcrossFiles({
      ...featureContext(params.textDocument.uri),
      line: params.position.line,
      character: params.position.character,
      session
    });
  }));

  connection.onRenameRequest((params) => logTimedOperation("textDocument/rename", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }

    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.analysis || !session.ast) {
      return null;
    }

    for (const character of candidateCharacters(params.position.character)) {
      const edit = await resolveRenameAcrossFiles(
        {
          ...featureContext(params.textDocument.uri),
          line: params.position.line,
          character,
          session
        },
        params.newName
      );
      if (edit) {
        return edit;
      }
    }
    return null;
  }));

  connection.languages.diagnostics.on(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return {
        kind: DocumentDiagnosticReportKind.Full,
        items: [] as Diagnostic[]
      };
    }
    const { items, resultId } = await getDocumentDiagnosticArtifacts(doc);
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items,
      resultId
    };
  });

  if (workspace) {
    connection.languages.diagnostics.onWorkspace(async () => {
      const docs = documents.all();
      const staleDocs = docs.filter((doc) => {
        const cached = workspaceDiagnosticCache.get(doc.uri);
        return !cached || cached.version !== doc.version;
      });
      if (staleDocs.length > 0) {
        await logTimedOperation("workspace/diagnostic", async () => {
          await Promise.all(staleDocs.map((doc) => getWorkspaceDiagnosticsForDocument(doc)));
        });
      }
      const items = await Promise.all(docs.map(async (doc) => ({
        kind: DocumentDiagnosticReportKind.Full,
        items: await getWorkspaceDiagnosticsForDocument(doc),
        uri: doc.uri,
        version: doc.version,
        resultId: String(doc.version)
      })));

      return { items };
    });
  }

  connection.onReferences((params) => logTimedOperation("textDocument/references", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }

    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis || !session.ast) {
      return [];
    }
    return resolveReferencesAcrossFiles(
      {
        ...featureContext(params.textDocument.uri),
        line: params.position.line,
        character: params.position.character,
        session
      },
      params.context.includeDeclaration
    );
  }));

  connection.onSignatureHelp((params) => logTimedOperation("textDocument/signatureHelp", async () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }

    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis || !session.ast) {
      return null;
    }

    return createSignatureHelp(
      session.ast,
      session.analysis,
      params.position.line,
      params.position.character,
      {
        ...featureContext(params.textDocument.uri),
        ambientModuleDeclarations: session.ambientModuleDeclarations,
        externalDeclarations: session.externalDeclarations
      }
    );
  }));

  connection.onDocumentSymbol((params) => logTimedOperationSync("textDocument/documentSymbol", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }

    const session = analysisSessions.getForDocument(doc);
    if (!session.ast) {
      return [];
    }

    return createDocumentSymbols(session.ast);
  }));

  if (workspace) {
    connection.onWorkspaceSymbol((params) => logTimedOperation("workspace/symbol", () => {
      return createWorkspaceSymbols({
        sourceRoots: environment.getSourceRoots(),
        query: params.query ?? ""
      });
    }));
  }

  connection.languages.inlayHint.on((params) => logTimedOperation("textDocument/inlayHint", async () => {
    if (!inlayHintsParameters && !inlayHintsTypes) return [];

    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }

    const session = analysisSessions.getForDocument(doc);
    if (!session.ast || !session.analysis) {
      return [];
    }

    return createInlayHints(
      session.ast,
      session.analysis,
      params.range,
      featureContext(params.textDocument.uri),
      { parameters: inlayHintsParameters, types: inlayHintsTypes }
    );
  }));

  connection.onCodeLens((params) => logTimedOperationSync("textDocument/codeLens", () => {
    if (!referenceCodeLensEnabled) return [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = analysisSessions.getForDocument(doc);
    return session.ast && session.analysis ? createReferenceCodeLenses(session.ast, session.analysis, doc.uri) : [];
  }));

  // Custom request: the editor asks for the lines that receive an implicit `await` so it can render
  // gutter icons (similar to Kotlin's suspend-call markers). Not part of the standard LSP protocol.
  connection.onRequest("vexa/autoAwaitDecorations", (params: { textDocument: { uri: string }; range?: Range }) =>
    logTimedOperationSync("vexa/autoAwaitDecorations", () => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return [];
      const session = analysisSessions.getForDocument(doc);
      if (!session.ast || !session.analysis) return [];
      return createAutoAwaitDecorations(session.ast, session.analysis, params.range);
    })
  );

  connection.onFoldingRanges((params) => logTimedOperationSync("textDocument/foldingRange", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const ast = analysisSessions.getForDocument(doc).ast;
    return ast ? createFoldingRanges(ast) : [];
  }));

  connection.onSelectionRanges((params) => logTimedOperationSync("textDocument/selectionRange", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const ast = analysisSessions.getForDocument(doc).ast;
    return ast ? createSelectionRanges(ast, params.positions) : [];
  }));

  connection.languages.onLinkedEditingRange((params) => logTimedOperationSync("textDocument/linkedEditingRange", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const analysis = analysisSessions.getForDocument(doc).analysis;
    if (!analysis) return null;
    const session = analysisSessions.getForDocument(doc);
    const edit = session.analysis && session.ast
      ? createRenameWorkspaceEdit(session.analysis, doc.uri, params.position.line, params.position.character, "__linked__", session.ast)
      : null;
    const ranges = edit?.changes?.[doc.uri]?.map((entry) => entry.range) ?? [];
    return ranges.length > 1 ? { ranges, wordPattern: "[A-Za-z_][A-Za-z0-9_]*" } : null;
  }));

  connection.onDocumentOnTypeFormatting((params) =>
    logTimedOperationSync("textDocument/onTypeFormatting", () => {
      const doc = documents.get(params.textDocument.uri);
      return doc ? createOnTypeFormattingEdits(doc.getText(), params.position, params.ch) : [];
    })
  );

  connection.onDidChangeConfiguration((() => logTimedOperation("workspace/didChangeConfiguration", async () => {
    const config = await connection.workspace.getConfiguration("vexa");
    const newParameters = config?.inlayHints?.parameters !== false;
    const newTypes = config?.inlayHints?.types !== false;
    if (newParameters !== inlayHintsParameters || newTypes !== inlayHintsTypes) {
      inlayHintsParameters = newParameters;
      inlayHintsTypes = newTypes;
      connection.languages.inlayHint.refresh();
    }
    const newCodeLensEnabled = config?.referenceCodeLens?.enabled === true;
    if (newCodeLensEnabled !== referenceCodeLensEnabled) {
      referenceCodeLensEnabled = newCodeLensEnabled;
      connection.sendRequest("workspace/codeLens/refresh");
    }
    lspTimingsEnabled = config?.lsp?.timings?.enabled === true;
    lspTimingCacheEventsEnabled = lspTimingsEnabled && config?.lsp?.timings?.cacheEvents?.enabled === true;
  })) as () => void);

  if (workspace) {
    connection.onDidChangeWatchedFiles((params) => {
      return logTimedOperationSync("workspace/didChangeWatchedFiles", () => {
        invalidateAllCaches();
        analysisSessions.clear();
        clearNodeModuleTypingsCache();
        clearAmbientTypesCache();
        for (const change of params.changes) {
          const filePath = uriToFilePath(change.uri);
          if (filePath) workspace.onWatchedFileChanged(filePath);
        }
        refreshDiagnostics();
      });
    });
  }

  connection.languages.callHierarchy.onPrepare((params) => logTimedOperationSync("textDocument/prepareCallHierarchy", () => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const ast = analysisSessions.getForDocument(doc).ast;
    return ast ? prepareCallHierarchy(ast, doc.uri, params.position) : null;
  }));

  connection.languages.callHierarchy.onIncomingCalls((params) => logTimedOperationSync("callHierarchy/incomingCalls", () => {
    const doc = documents.get(params.item.uri);
    if (!doc) return [];
    const ast = analysisSessions.getForDocument(doc).ast;
    return ast ? createIncomingCalls(ast, doc.uri, params.item) : [];
  }));

  connection.languages.callHierarchy.onOutgoingCalls((params) => logTimedOperationSync("callHierarchy/outgoingCalls", () => {
    const doc = documents.get(params.item.uri);
    if (!doc) return [];
    const ast = analysisSessions.getForDocument(doc).ast;
    return ast ? createOutgoingCalls(ast, doc.uri, params.item) : [];
  }));

  connection.languages.semanticTokens.on(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return { data: [] };
    }
    const cacheKey = `${doc.uri}|full`;
    const cached = semanticTokensCache.get(cacheKey);
    if (cached && cached.version === doc.version) {
      logCacheState("textDocument/semanticTokens/full", "hit", doc.version);
      return cached.promise;
    }
    logCacheState("textDocument/semanticTokens/full", "miss", doc.version);
    const promise = logTimedOperation("textDocument/semanticTokens/full", async () => {
      const session = await logTimedPhase("textDocument/semanticTokens/full", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      const tokenModifiersByRangeKey = await logTimedPhase("textDocument/semanticTokens/full", "deprecatedSemanticTokenModifiers", () =>
        getDeprecatedSemanticTokenModifiers(doc, session)
      );
      return logTimedPhase("textDocument/semanticTokens/full", "buildTokens", () =>
        createSemanticTokens({
          text: doc.getText(),
          ast: session.ast,
          analysis: session.analysis,
          tokenModifiersByRangeKey
        })
      );
    });
    semanticTokensCache.set(cacheKey, { version: doc.version, promise });
    return promise;
  });

  connection.languages.semanticTokens.onRange(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return { data: [] };
    }
    const cacheKey = `${doc.uri}|range:${params.range.start.line}:${params.range.start.character}:${params.range.end.line}:${params.range.end.character}`;
    const cached = semanticTokensCache.get(cacheKey);
    if (cached && cached.version === doc.version) {
      logCacheState("textDocument/semanticTokens/range", "hit", doc.version);
      return cached.promise;
    }
    const fullCacheKey = `${doc.uri}|full`;
    const cachedFull = semanticTokensCache.get(fullCacheKey);
    if (cachedFull && cachedFull.version === doc.version) {
      logCacheState("textDocument/semanticTokens/range", "hit", doc.version);
      const promise = cachedFull.promise.then((tokens) => sliceSemanticTokensByRange(tokens, params.range));
      semanticTokensCache.set(cacheKey, { version: doc.version, promise });
      return promise;
    }
    logCacheState("textDocument/semanticTokens/range", "miss", doc.version);
    const promise = logTimedOperation("textDocument/semanticTokens/range", async () => {
      const session = await logTimedPhase("textDocument/semanticTokens/range", "analysisSession", () =>
        analysisSessions.getForDocumentAsync(doc)
      );
      const tokenModifiersByRangeKey = await logTimedPhase("textDocument/semanticTokens/range", "deprecatedSemanticTokenModifiers", () =>
        getDeprecatedSemanticTokenModifiers(doc, session)
      );
      return logTimedPhase("textDocument/semanticTokens/range", "buildTokens", () =>
        createSemanticTokens({
          text: doc.getText(),
          ast: session.ast,
          analysis: session.analysis,
          range: params.range,
          tokenModifiersByRangeKey
        })
      );
    });
    semanticTokensCache.set(cacheKey, { version: doc.version, promise });
    return promise;
  });

  documents.listen(connection);
  connection.listen();
}
