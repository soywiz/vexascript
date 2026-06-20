import { readFile } from "node:fs/promises";
import { resolve as resolveNodePath } from "node:path";
import "cli/localVfs";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection, Range, TextDocuments } from "vscode-languageserver/node.js";
import { AnalysisSessionCache } from "compiler/lsp/analysisSession";
import { collectAllImportedDeclarations } from "compiler/lsp/importedDeclarations";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadAmbientTypesForProject } from "compiler/lsp/ambientTypesLoader";
import { getProjectIndex, type ProjectIndex } from "compiler/lsp/projectAnalysis";
import { uriToFilePath } from "compiler/lsp/importFixes";
import { startLspServer, type LspServerEnvironment } from "compiler/lsp/serverCore";
import { resolve as resolvePath } from "compiler/utils/path";
import { loadProject } from "compiler/project";

type Handler = (...args: unknown[]) => unknown;

interface FakeConnection {
  connection: Connection;
  handlers: Map<string, Handler>;
  infoMessages: string[];
  setConfiguration: (value: unknown) => void;
}

interface FakeDocuments {
  documents: TextDocuments<TextDocument>;
  open: (document: TextDocument) => void;
  change: (document: TextDocument) => void;
}

function createFakeConnection(): FakeConnection {
  const handlers = new Map<string, Handler>();
  const infoMessages: string[] = [];
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
      info: (message: string) => {
        infoMessages.push(message);
      },
      log: (message: string) => {
        infoMessages.push(message);
      },
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
    infoMessages,
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
      for (const handler of openHandlers) {
        handler({ document });
      }
    },
    change: (document) => {
      byUri.set(document.uri, document);
      for (const handler of changeHandlers) {
        handler({ document });
      }
    }
  };
}

async function createWorkspaceAnalysisSessionCache(workspaceRoot: string): Promise<{
  analysisSessions: AnalysisSessionCache;
  projectIndex: ProjectIndex;
  getSessionForFilePath: (filePath: string) => Promise<ReturnType<ProjectIndex["getSessionForFilePath"]> extends Promise<infer T> ? T : never>;
}> {
  const projectIndex = getProjectIndex([workspaceRoot]);

  async function getSessionForFilePath(filePath: string) {
    return projectIndex.getSessionForFilePath(resolvePath(filePath));
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
      sourceRoots: [workspaceRoot],
      getSessionForFilePath,
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
    projectIndex,
    getSessionForFilePath
  };
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

async function main(): Promise<void> {
  const workspaceRoot = resolveNodePath(process.cwd(), "samples/pixi");
  const entrypoint = resolveNodePath(workspaceRoot, "html.vx");
  const source = await readFile(entrypoint, "utf8");
  const fakeConnection = createFakeConnection();
  const fakeDocuments = createFakeDocuments();
  const { analysisSessions, projectIndex, getSessionForFilePath } = await createWorkspaceAnalysisSessionCache(workspaceRoot);

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
    onDocumentClosed: () => undefined,
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

  const uri = toFileUri(entrypoint);
  fakeConnection.handlers.get("initialize")!({
    workspaceFolders: [{ uri: toFileUri(workspaceRoot), name: "pixi" }],
    initializationOptions: {
      enableInlayHintsParameters: true,
      enableInlayHintsTypes: true,
      enableLspTimings: true,
      enableLspTimingCacheEvents: true
    }
  });
  fakeConnection.handlers.get("initialized")!({});

  const openedDocument = TextDocument.create(uri, "vexa", 1, source);
  fakeDocuments.open(openedDocument);
  await projectIndex.upsertOpenDocument(entrypoint, source);

  const changedDocument = TextDocument.create(uri, "vexa", 2, source);
  fakeDocuments.change(changedDocument);
  await projectIndex.upsertOpenDocument(entrypoint, source);
  const range = fullDocumentRange(changedDocument);

  fakeConnection.setConfiguration({
    inlayHints: { parameters: true, types: true },
    lsp: { timings: { enabled: true, cacheEvents: { enabled: true } } }
  });
  await fakeConnection.handlers.get("didChangeConfiguration")!({});

  await fakeConnection.handlers.get("diagnostics")!({
    textDocument: { uri }
  });
  await fakeConnection.handlers.get("inlayHint")!({
    textDocument: { uri },
    range
  });
  await fakeConnection.handlers.get("semanticTokens")!({
    textDocument: { uri }
  });
  await fakeConnection.handlers.get("semanticTokensRange")!({
    textDocument: { uri },
    range
  });
  await fakeConnection.handlers.get("workspaceDiagnostics")!({});

  process.stdout.write(`${fakeConnection.infoMessages.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
