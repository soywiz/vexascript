import "../../../../cli/localVfs";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection, Diagnostic, Range, TextDocuments } from "vscode-languageserver/node.js";
import { AnalysisSessionCache } from "../../../../compiler/lsp/analysisSession";
import { collectAllImportedDeclarations } from "../../../../compiler/lsp/importedDeclarations";
import { ensureDomProgram, getDomDeclarationFilePath } from "../../../../compiler/runtime/domDeclarations";
import { loadAmbientTypesForProject } from "../../../../compiler/lsp/ambientTypesLoader";
import { getProjectIndex, type ProjectIndex } from "../../../../compiler/lsp/projectAnalysis";
import { uriToFilePath } from "../../../../compiler/lsp/importFixes";
import { startLspServer, type LspServerEnvironment } from "../../../../compiler/lsp/serverCore";
import { resolve as resolvePath } from "../../../../compiler/utils/path";
import { loadProject } from "../../../../compiler/project";
import { vfs } from "../../../../compiler/vfs";
import { collectDiagnosticsFromSession } from "../../../../compiler/lsp/diagnostics";
import { collectModuleNotFoundDiagnostics, collectCrossFileTypeDiagnostics } from "../../../../compiler/lsp/crossFileTypeDiagnostics";
import { createInlayHints } from "../../../../compiler/lsp/inlayHints";

type Handler = (...args: unknown[]) => unknown;

interface FakeConnection {
  connection: Connection;
  handlers: Map<string, Handler>;
  setConfiguration: (value: unknown) => void;
}

interface FakeDocuments {
  documents: TextDocuments<TextDocument>;
  open: (document: TextDocument) => void;
  change: (document: TextDocument) => void;
}

interface StartedWorkspaceServer {
  fakeConnection: FakeConnection;
  fakeDocuments: FakeDocuments;
  projectIndex: ProjectIndex;
  analysisSessions: AnalysisSessionCache;
}

interface TimedResult<T> {
  durationMs: number;
  value: T;
}

interface SessionFactoryBreakdown {
  loadProjectMs: number;
  ambientTypesMs: number;
  ensureDomMs: number;
  importedDeclarationsMs: number;
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

function fullDocumentRange(document: TextDocument): Range {
  const lines = document.getText().split(/\r?\n/);
  const lastLine = Math.max(lines.length - 1, 0);
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: lines[lastLine]?.length ?? 0 }
  };
}

function createFakeConnection(): FakeConnection {
  const handlers = new Map<string, Handler>();
  let configuration: unknown = {};

  const register = (name: string) => (handler: Handler) => {
    handlers.set(name, handler);
  };

  const connection = {
    onInitialize: register("initialize"),
    onInitialized: register("initialized"),
    onCompletion: register("completion"),
    onCodeAction: register("codeAction"),
    onCodeActionResolve: register("codeActionResolve"),
    onExecuteCommand: register("executeCommand"),
    onDocumentFormatting: register("documentFormatting"),
    onDocumentRangeFormatting: register("documentRangeFormatting"),
    onDefinition: register("definition"),
    onDeclaration: register("declaration"),
    onTypeDefinition: register("typeDefinition"),
    onImplementation: register("implementation"),
    onDocumentHighlight: register("documentHighlight"),
    onHover: register("hover"),
    onPrepareRename: register("prepareRename"),
    onRenameRequest: register("renameRequest"),
    onReferences: register("references"),
    onSignatureHelp: register("signatureHelp"),
    onDocumentSymbol: register("documentSymbol"),
    onWorkspaceSymbol: register("workspaceSymbol"),
    onCodeLens: register("codeLens"),
    onFoldingRanges: register("foldingRanges"),
    onSelectionRanges: register("selectionRanges"),
    onDocumentOnTypeFormatting: register("documentOnTypeFormatting"),
    onDidChangeConfiguration: register("didChangeConfiguration"),
    onDidChangeWatchedFiles: register("didChangeWatchedFiles"),
    onRequest: (method: string, handler: Handler) => {
      handlers.set(`request:${method}`, handler);
    },
    sendRequest: () => Promise.resolve(undefined),
    workspace: {
      getConfiguration: () => Promise.resolve(configuration)
    },
    console: {
      info: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    languages: {
      diagnostics: {
        on: register("diagnostics"),
        onWorkspace: register("workspaceDiagnostics"),
        refresh: () => Promise.resolve()
      },
      inlayHint: {
        on: register("inlayHint"),
        refresh: () => Promise.resolve()
      },
      onLinkedEditingRange: register("linkedEditingRange"),
      callHierarchy: {
        onPrepare: register("callHierarchyPrepare"),
        onIncomingCalls: register("callHierarchyIncomingCalls"),
        onOutgoingCalls: register("callHierarchyOutgoingCalls")
      },
      semanticTokens: {
        on: register("semanticTokens"),
        onRange: register("semanticTokensRange")
      }
    },
    listen: () => undefined
  };

  return {
    connection: connection as unknown as Connection,
    handlers,
    setConfiguration: (value) => {
      configuration = value;
    }
  };
}

function createFakeDocuments(): FakeDocuments {
  const byUri = new Map<string, TextDocument>();
  const openHandlers: Handler[] = [];
  const changeHandlers: Handler[] = [];

  const documents = {
    get: (uri: string) => byUri.get(uri),
    all: () => [...byUri.values()],
    onDidOpen: (handler: Handler) => {
      openHandlers.push(handler);
    },
    onDidChangeContent: (handler: Handler) => {
      changeHandlers.push(handler);
    },
    onDidClose: () => undefined,
    listen: () => undefined
  };

  return {
    documents: documents as unknown as TextDocuments<TextDocument>,
    open: (document) => {
      byUri.set(document.uri, document);
      for (const handler of openHandlers) handler({ document });
    },
    change: (document) => {
      byUri.set(document.uri, document);
      for (const handler of changeHandlers) handler({ document });
    }
  };
}

async function createWorkspaceAnalysisSessionCache(workspaceRoot: string): Promise<{
  analysisSessions: AnalysisSessionCache;
  projectIndex: ProjectIndex;
  getSessionForFilePath: (filePath: string) => Promise<ReturnType<ProjectIndex["getSessionForFilePath"]> extends Promise<infer T> ? T : never>;
  lastBreakdown: () => SessionFactoryBreakdown | null;
}> {
  const projectIndex = getProjectIndex([workspaceRoot]);
  let latestBreakdown: SessionFactoryBreakdown | null = null;

  async function getSessionForFilePath(filePath: string) {
    return projectIndex.getSessionForFilePath(resolvePath(filePath));
  }

  const analysisSessions = new AnalysisSessionCache(async (document, baseSession) => {
    if (!baseSession.ast) {
      latestBreakdown = null;
      return {
        externalDeclarations: [],
        importedSymbolTypes: new Map(),
        importedSymbolDisplayTypes: new Map(),
        ambientDeclarations: [],
        ambientModuleDeclarations: new Map()
      };
    }

    const filePath = uriToFilePath(document.uri);
    const projectTimed = await time(async () => filePath ? loadProject(filePath) : null);
    const project = projectTimed.value;

    const ambientTypesTimed = await time(async () =>
      loadAmbientTypesForProject(filePath, project?.types ?? [])
    );
    const ambientTypes = ambientTypesTimed.value;

    const ensureDomTimed = await time(async () =>
      (project?.libs ?? []).some((lib) => lib.toLowerCase() === "dom")
        ? (await ensureDomProgram()).body
        : []
    );
    const domDeclarations = ensureDomTimed.value;

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
      sourceRoots: [workspaceRoot],
      getSessionForFilePath,
      ambientModuleDeclarations: ambientTypes.moduleDeclarations,
      ambientGlobalDeclarations: ambientTypes.globalDeclarations
    };

    const importedTimed = await time(async () => collectAllImportedDeclarations(baseSession.ast, context));
    const {
      externalDeclarations,
      importedSymbolTypes,
      importedSymbolDisplayTypes,
      invalidImportedBindings
    } = importedTimed.value;

    latestBreakdown = {
      loadProjectMs: projectTimed.durationMs,
      ambientTypesMs: ambientTypesTimed.durationMs,
      ensureDomMs: ensureDomTimed.durationMs,
      importedDeclarationsMs: importedTimed.durationMs
    };

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
    projectIndex,
    getSessionForFilePath,
    lastBreakdown: () => latestBreakdown
  };
}

async function startWorkspaceServer(workspaceRoot: string): Promise<StartedWorkspaceServer & {
  lastBreakdown: () => SessionFactoryBreakdown | null;
}> {
  const fakeConnection = createFakeConnection();
  const fakeDocuments = createFakeDocuments();
  const {
    analysisSessions,
    projectIndex,
    getSessionForFilePath,
    lastBreakdown
  } = await createWorkspaceAnalysisSessionCache(workspaceRoot);

  const environment: LspServerEnvironment = {
    getSourceRoots: () => [workspaceRoot],
    getSessionForFilePath,
    onInitialize: () => undefined,
    onDocumentOpenedOrChanged: (document) => {
      const filePath = uriToFilePath(document.uri);
      if (filePath) {
        projectIndex.upsertOpenDocument(filePath, document.getText()).catch(() => undefined);
      }
    },
    onDocumentClosed: (document) => {
      const filePath = uriToFilePath(document.uri);
      if (filePath) {
        projectIndex.clearOpenDocument(filePath);
        projectIndex.invalidateFile(filePath);
      }
    },
    workspace: {
      refreshDiagnosticsCommand: "vexa.refreshDiagnostics",
      onWatchedFileChanged: (filePath: string) => projectIndex.invalidateFile(filePath)
    }
  };

  startLspServer({
    connection: fakeConnection.connection,
    documents: fakeDocuments.documents,
    analysisSessions,
    environment
  });

  return { fakeConnection, fakeDocuments, projectIndex, analysisSessions, lastBreakdown };
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const entrypointArg = process.argv[2];
  const entrypoint = resolvePath(entrypointArg ?? "samples/node/main.vx");
  const uri = toFileUri(entrypoint);
  const source = await vfs().readFile(entrypoint);

  const startup = await time(async () => startWorkspaceServer(workspaceRoot));
  const server = startup.value;

  const initialize = await time(async () => {
    server.fakeConnection.handlers.get("initialize")!({
      workspaceFolders: [{ uri: toFileUri(workspaceRoot), name: workspaceRoot.split("/").at(-1) ?? "workspace" }],
      initializationOptions: {
        enableInlayHintsParameters: true,
        enableInlayHintsTypes: true,
        enableLspTimings: true
      }
    });
    server.fakeConnection.handlers.get("initialized")!();
  });

  const openedDocument = TextDocument.create(uri, "vexa", 1, source);
  const open = await time(async () => {
    server.fakeDocuments.open(openedDocument);
    await server.projectIndex.upsertOpenDocument(entrypoint, source);
  });

  const changedDocument = TextDocument.create(uri, "vexa", 2, source);
  const change = await time(async () => {
    server.fakeDocuments.change(changedDocument);
    await server.projectIndex.upsertOpenDocument(entrypoint, source);
  });

  const configure = await time(async () => {
    server.fakeConnection.setConfiguration({
      inlayHints: { parameters: true, types: true },
      lsp: { timings: { enabled: true } }
    });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
  });

  const coldSession = await time(async () => server.analysisSessions.getForDocumentAsync(changedDocument));
  const coldBreakdown = server.lastBreakdown();
  const session = coldSession.value;
  const range = fullDocumentRange(changedDocument);
  const directSyncDiagnostics = await time(async () =>
    collectDiagnosticsFromSession(session, source, (offset) => changedDocument.positionAt(offset))
  );
  const directModuleNotFound = await time(async () =>
    collectModuleNotFoundDiagnostics({
      uri,
      session,
      getSessionForFilePath: (filePath) => server.projectIndex.getSessionForFilePath(resolvePath(filePath))
    })
  );
  const directCrossFileTypeDiagnostics = await time(async () =>
    collectCrossFileTypeDiagnostics({
      uri,
      session,
      sourceRoots: [workspaceRoot],
      getSessionForFilePath: (filePath) => server.projectIndex.getSessionForFilePath(resolvePath(filePath))
    })
  );
  const directInlayHints = await time(async () =>
    createInlayHints(
      session.ast,
      session.analysis,
      range,
      {
        uri,
        sourceRoots: [workspaceRoot],
        getSessionForFilePath: (filePath) => server.projectIndex.getSessionForFilePath(resolvePath(filePath)),
        ambientModuleDeclarations: session.ambientModuleDeclarations
      },
      { types: true, parameters: true }
    )
  );

  const autoAwait = await time(async () =>
    server.fakeConnection.handlers.get("request:vexa/autoAwaitDecorations")!({
      textDocument: { uri },
      range
    })
  );
  const inlayHints = await time(async () =>
    server.fakeConnection.handlers.get("inlayHint")!({
      textDocument: { uri },
      range
    })
  );
  const foldingRanges = await time(async () =>
    server.fakeConnection.handlers.get("foldingRanges")!({
      textDocument: { uri }
    })
  );
  const documentSymbols = await time(async () =>
    server.fakeConnection.handlers.get("documentSymbol")!({
      textDocument: { uri }
    })
  );
  const documentDiagnostics = await time(async () =>
    server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri }
    }) as Promise<{ items: Diagnostic[] }>
  );
  const codeActions = await time(async () =>
    server.fakeConnection.handlers.get("codeAction")!({
      textDocument: { uri },
      range,
      context: {
        diagnostics: documentDiagnostics.value.items,
        only: []
      }
    })
  );
  const semanticTokens = await time(async () =>
    server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri }
    })
  );
  const semanticTokensRange = await time(async () =>
    server.fakeConnection.handlers.get("semanticTokensRange")!({
      textDocument: { uri },
      range
    })
  );
  const workspaceDiagnostics = await time(async () =>
    server.fakeConnection.handlers.get("workspaceDiagnostics")!({})
  );

  const burst = autoAwait.durationMs
    + inlayHints.durationMs
    + foldingRanges.durationMs
    + documentSymbols.durationMs
    + documentDiagnostics.durationMs
    + codeActions.durationMs
    + semanticTokens.durationMs
    + semanticTokensRange.durationMs
    + workspaceDiagnostics.durationMs;

  const lines = [
    `entrypoint: ${entrypoint}`,
    `server startup: ${formatMs(startup.durationMs)}ms`,
    `initialize: ${formatMs(initialize.durationMs)}ms`,
    `open: ${formatMs(open.durationMs)}ms`,
    `change: ${formatMs(change.durationMs)}ms`,
    `didChangeConfiguration: ${formatMs(configure.durationMs)}ms`,
    `cold analysis session: ${formatMs(coldSession.durationMs)}ms`,
    `  loadProject: ${formatMs(coldBreakdown?.loadProjectMs ?? 0)}ms`,
    `  loadAmbientTypesForProject: ${formatMs(coldBreakdown?.ambientTypesMs ?? 0)}ms`,
    `  ensureDomProgram: ${formatMs(coldBreakdown?.ensureDomMs ?? 0)}ms`,
    `  collectAllImportedDeclarations: ${formatMs(coldBreakdown?.importedDeclarationsMs ?? 0)}ms`,
    `direct sync diagnostics helper: ${formatMs(directSyncDiagnostics.durationMs)}ms (${directSyncDiagnostics.value.length} items)`,
    `direct module-not-found helper: ${formatMs(directModuleNotFound.durationMs)}ms (${directModuleNotFound.value.length} items)`,
    `direct cross-file type diagnostics helper: ${formatMs(directCrossFileTypeDiagnostics.durationMs)}ms (${directCrossFileTypeDiagnostics.value.length} items)`,
    `direct inlay hints helper: ${formatMs(directInlayHints.durationMs)}ms (${directInlayHints.value.length} hints)`,
    `autoAwaitDecorations: ${formatMs(autoAwait.durationMs)}ms`,
    `inlayHints: ${formatMs(inlayHints.durationMs)}ms`,
    `foldingRanges: ${formatMs(foldingRanges.durationMs)}ms`,
    `documentSymbols: ${formatMs(documentSymbols.durationMs)}ms`,
    `documentDiagnostics: ${formatMs(documentDiagnostics.durationMs)}ms`,
    `codeActions: ${formatMs(codeActions.durationMs)}ms`,
    `semanticTokens: ${formatMs(semanticTokens.durationMs)}ms`,
    `semanticTokensRange: ${formatMs(semanticTokensRange.durationMs)}ms`,
    `workspaceDiagnostics: ${formatMs(workspaceDiagnostics.durationMs)}ms`,
    `sequential VS Code burst subtotal: ${formatMs(burst)}ms`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
