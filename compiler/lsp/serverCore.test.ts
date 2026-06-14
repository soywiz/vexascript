import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection, TextDocuments } from "vscode-languageserver/node.js";
import { AnalysisSessionCache } from "./analysisSession";
import { sourceWithCursor } from "compiler/test/sourceWithCursor";
import {
  candidateCharacters,
  completionPrefixAt,
  startLspServer,
  type LspServerEnvironment
} from "./serverCore";

type Handler = (...args: unknown[]) => unknown;

interface FakeConnection {
  connection: Connection;
  handlers: Map<string, Handler>;
  diagnosticsRefreshes: () => number;
  inlayHintRefreshes: () => number;
  sentRequests: string[];
  listened: () => boolean;
  setConfiguration: (value: unknown) => void;
}

function createFakeConnection(): FakeConnection {
  const handlers = new Map<string, Handler>();
  const sentRequests: string[] = [];
  let diagnosticsRefreshes = 0;
  let inlayHintRefreshes = 0;
  let listened = false;
  let configuration: unknown = {};

  const register = (name: string) => (handler: Handler) => {
    handlers.set(name, handler);
  };

  const connection = {
    onInitialize: register("initialize"),
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
    sendRequest: (method: string) => {
      sentRequests.push(method);
      return Promise.resolve(undefined);
    },
    workspace: {
      getConfiguration: () => Promise.resolve(configuration)
    },
    languages: {
      diagnostics: {
        on: register("diagnostics"),
        onWorkspace: register("workspaceDiagnostics"),
        refresh: () => {
          diagnosticsRefreshes += 1;
          return Promise.resolve();
        }
      },
      inlayHint: {
        on: register("inlayHint"),
        refresh: () => {
          inlayHintRefreshes += 1;
          return Promise.resolve();
        }
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
    listen: () => {
      listened = true;
    }
  };

  return {
    connection: connection as unknown as Connection,
    handlers,
    diagnosticsRefreshes: () => diagnosticsRefreshes,
    inlayHintRefreshes: () => inlayHintRefreshes,
    sentRequests,
    listened: () => listened,
    setConfiguration: (value) => {
      configuration = value;
    }
  };
}

interface FakeDocuments {
  documents: TextDocuments<TextDocument>;
  open: (document: TextDocument) => void;
  change: (document: TextDocument) => void;
  close: (document: TextDocument) => void;
  listened: () => boolean;
}

function createFakeDocuments(): FakeDocuments {
  const byUri = new Map<string, TextDocument>();
  const openHandlers: Handler[] = [];
  const changeHandlers: Handler[] = [];
  const closeHandlers: Handler[] = [];
  let listened = false;

  const documents = {
    get: (uri: string) => byUri.get(uri),
    all: () => [...byUri.values()],
    onDidOpen: (handler: Handler) => {
      openHandlers.push(handler);
    },
    onDidChangeContent: (handler: Handler) => {
      changeHandlers.push(handler);
    },
    onDidClose: (handler: Handler) => {
      closeHandlers.push(handler);
    },
    listen: () => {
      listened = true;
    }
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
    },
    close: (document) => {
      byUri.delete(document.uri);
      for (const handler of closeHandlers) handler({ document });
    },
    listened: () => listened
  };
}

const WORKSPACE_ONLY_HANDLERS = new Set([
  "executeCommand",
  "workspaceSymbol",
  "workspaceDiagnostics",
  "didChangeWatchedFiles"
]);

interface StartedServer {
  fakeConnection: FakeConnection;
  fakeDocuments: FakeDocuments;
  environmentEvents: string[];
}

function startServer(withWorkspace: boolean): StartedServer {
  const fakeConnection = createFakeConnection();
  const fakeDocuments = createFakeDocuments();
  const environmentEvents: string[] = [];
  const environment: LspServerEnvironment = {
    getSourceRoots: () => [],
    getSessionForFilePath: () => null,
    onDocumentOpenedOrChanged: (document) => {
      environmentEvents.push(`open-or-change:${document.uri}`);
    },
    onDocumentClosed: (document) => {
      environmentEvents.push(`close:${document.uri}`);
    },
    ...(withWorkspace
      ? {
          workspace: {
            refreshDiagnosticsCommand: "vexa.refreshDiagnostics",
            onWatchedFileChanged: (filePath: string) => {
              environmentEvents.push(`watched:${filePath}`);
            }
          }
        }
      : {})
  };

  startLspServer({
    connection: fakeConnection.connection,
    documents: fakeDocuments.documents,
    analysisSessions: new AnalysisSessionCache(),
    environment
  });

  return { fakeConnection, fakeDocuments, environmentEvents };
}

function openedDocument(server: StartedServer, source: string, uri = "file:///workspace/main.vx"): TextDocument {
  const document = TextDocument.create(uri, "vexa", 1, source);
  server.fakeDocuments.open(document);
  return document;
}

describe("LSP server core", () => {
  it("registers the same shared handler set for both server environments", () => {
    const node = startServer(true);
    const browser = startServer(false);

    const nodeHandlers = new Set(node.fakeConnection.handlers.keys());
    const browserHandlers = new Set(browser.fakeConnection.handlers.keys());

    for (const name of WORKSPACE_ONLY_HANDLERS) {
      assert.equal(nodeHandlers.has(name), true, `workspace server should register ${name}`);
      assert.equal(browserHandlers.has(name), false, `workspace-less server should not register ${name}`);
    }

    const sharedNodeHandlers = [...nodeHandlers].filter((name) => !WORKSPACE_ONLY_HANDLERS.has(name)).sort();
    assert.deepEqual([...browserHandlers].sort(), sharedNodeHandlers);
    assert.equal(sharedNodeHandlers.includes("request:vexa/autoAwaitDecorations"), true);
    assert.equal(node.fakeConnection.listened(), true);
    assert.equal(node.fakeDocuments.listened(), true);
  });

  it("advertises workspace capabilities only when a workspace environment exists", () => {
    const node = startServer(true);
    const browser = startServer(false);
    const initializeParams = { initializationOptions: { enableReferenceCodeLens: true } };

    const nodeResult = node.fakeConnection.handlers.get("initialize")!(initializeParams) as {
      capabilities: Record<string, unknown>;
    };
    const browserResult = browser.fakeConnection.handlers.get("initialize")!(initializeParams) as {
      capabilities: Record<string, unknown>;
    };

    assert.deepEqual(nodeResult.capabilities["executeCommandProvider"], { commands: ["vexa.refreshDiagnostics"] });
    assert.equal(nodeResult.capabilities["workspaceSymbolProvider"], true);
    assert.deepEqual(nodeResult.capabilities["diagnosticProvider"], {
      interFileDependencies: true,
      workspaceDiagnostics: true
    });

    assert.equal(browserResult.capabilities["executeCommandProvider"], undefined);
    assert.equal(browserResult.capabilities["workspaceSymbolProvider"], undefined);
    assert.deepEqual(browserResult.capabilities["diagnosticProvider"], {
      interFileDependencies: false,
      workspaceDiagnostics: false
    });

    assert.deepEqual(nodeResult.capabilities["codeLensProvider"], { resolveProvider: false });
    const sharedCapabilities = Object.keys(nodeResult.capabilities).filter(
      (capability) => !["executeCommandProvider", "workspaceSymbolProvider"].includes(capability)
    );
    assert.deepEqual(Object.keys(browserResult.capabilities).sort(), sharedCapabilities.sort());
  });

  it("serves completion and hover through the shared handlers", async () => {
    const server = startServer(false);
    const { source, line, character } = sourceWithCursor([
      "function add(a: number, b: number): number {",
      "  return a + b",
      "}",
      "val total = ad^^^d(1, 2)",
      ""
    ].join("\n"));
    const document = openedDocument(server, source);

    const completionItems = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    }) as Array<{ label: string }>;
    assert.equal(completionItems.some((item) => item.label === "add"), true);

    // Guards the full hover chain: the async import-path hover must be awaited
    // (a missing await here used to short-circuit every non-import hover).
    const hover = await server.fakeConnection.handlers.get("hover")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    }) as { contents: { value: string } } | null;
    assert.equal(hover?.contents.value.includes("add"), true);
  });

  it("reports full diagnostics for open documents", async () => {
    const server = startServer(false);
    const document = openedDocument(server, "val broken: number = \"text\"\n");

    const report = await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    }) as { kind: string; items: Array<{ message: string }> };

    assert.equal(report.kind, "full");
    assert.equal(report.items.length > 0, true);
  });

  it("notifies the environment about document lifecycle changes", () => {
    const server = startServer(true);
    const document = openedDocument(server, "val answer = 42\n");
    const refreshesAfterOpen = server.fakeConnection.diagnosticsRefreshes();

    server.fakeDocuments.close(document);

    assert.deepEqual(server.environmentEvents, [
      `open-or-change:${document.uri}`,
      `close:${document.uri}`
    ]);
    assert.equal(refreshesAfterOpen >= 1, true);
    assert.equal(server.fakeConnection.diagnosticsRefreshes() > refreshesAfterOpen, true);
  });

  it("refreshes diagnostics through the workspace execute command and watched files", () => {
    const server = startServer(true);
    const before = server.fakeConnection.diagnosticsRefreshes();

    server.fakeConnection.handlers.get("executeCommand")!({ command: "vexa.refreshDiagnostics" });
    assert.equal(server.fakeConnection.diagnosticsRefreshes(), before + 1);

    server.fakeConnection.handlers.get("didChangeWatchedFiles")!({
      changes: [{ uri: "file:///workspace/util.vx" }, { uri: "untitled:not-a-file" }]
    });
    assert.deepEqual(server.environmentEvents, ["watched:/workspace/util.vx"]);
    assert.equal(server.fakeConnection.diagnosticsRefreshes(), before + 2);
  });

  it("applies inlay hint and code lens configuration changes on both transports", async () => {
    for (const withWorkspace of [true, false]) {
      const server = startServer(withWorkspace);
      server.fakeConnection.setConfiguration({
        inlayHints: { parameters: true, types: true },
        referenceCodeLens: { enabled: true }
      });

      await server.fakeConnection.handlers.get("didChangeConfiguration")!({});

      assert.equal(server.fakeConnection.inlayHintRefreshes(), 1);
      assert.deepEqual(server.fakeConnection.sentRequests, ["workspace/codeLens/refresh"]);
    }
  });

  it("refreshes inlay hints independently when only one sub-setting changes", async () => {
    const server = startServer(false);

    server.fakeConnection.setConfiguration({ inlayHints: { parameters: false, types: true } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    assert.equal(server.fakeConnection.inlayHintRefreshes(), 1);

    server.fakeConnection.setConfiguration({ inlayHints: { parameters: true, types: false } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    assert.equal(server.fakeConnection.inlayHintRefreshes(), 2);

    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    assert.equal(server.fakeConnection.inlayHintRefreshes(), 2, "no refresh when config is unchanged");
  });

  it("derives completion prefixes and candidate characters consistently", () => {
    assert.equal(completionPrefixAt("val to = tot", 12), "tot");
    assert.equal(completionPrefixAt("a.b", 2), "");
    assert.equal(completionPrefixAt("abc", 0), "");
    assert.deepEqual(candidateCharacters(0), [0, 1]);
    assert.deepEqual(candidateCharacters(3), [3, 2, 4]);
  });
});
