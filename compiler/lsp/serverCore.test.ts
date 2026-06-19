import { assert, describe, it } from "../test/expect";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection, TextDocuments } from "vscode-languageserver/node.js";
import { COMPILER_VERSION } from "compiler/compilerVersion";
import { AnalysisSessionCache, createAnalysisSession } from "./analysisSession";
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
  infoMessages: string[];
  listened: () => boolean;
  setConfiguration: (value: unknown) => void;
}

function createFakeConnection(): FakeConnection {
  const handlers = new Map<string, Handler>();
  const sentRequests: string[] = [];
  const infoMessages: string[] = [];
  let diagnosticsRefreshes = 0;
  let inlayHintRefreshes = 0;
  let listened = false;
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
    sendRequest: (method: string) => {
      sentRequests.push(method);
      return Promise.resolve(undefined);
    },
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
    infoMessages,
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
      serverInfo: { name: string; version: string };
    };
    const browserResult = browser.fakeConnection.handlers.get("initialize")!(initializeParams) as {
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
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
    assert.deepEqual(nodeResult.serverInfo, { name: "VexaScript", version: COMPILER_VERSION });
    assert.deepEqual(browserResult.serverInfo, { name: "VexaScript", version: COMPILER_VERSION });

    assert.deepEqual(nodeResult.capabilities["codeLensProvider"], { resolveProvider: false });
    assert.deepEqual(nodeResult.capabilities["completionProvider"], {
      resolveProvider: false,
      triggerCharacters: [".", "@", ":"]
    });
    assert.deepEqual(browserResult.capabilities["completionProvider"], {
      resolveProvider: false,
      triggerCharacters: [".", "@", ":"]
    });
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

  it("reports deprecated member diagnostics through pull diagnostics", async () => {
    const server = startServer(false);
    const document = openedDocument(server, [
      "declare class Graphics {",
      "  /** @deprecated since 8.0.0 Use fill instead */",
      "  beginFill(color: number): Graphics",
      "  fill(color: number): Graphics",
      "}",
      "val badge = Graphics()",
      "badge.beginFill(1)",
      ""
    ].join("\n"));

    const report = await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    }) as { kind: string; items: Array<{ code?: string; tags?: number[]; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> };

    const deprecated = report.items.find((item) => item.code === "MYL3003");
    assert.equal(report.kind, "full");
    assert.deepEqual(deprecated?.tags, [2]);
    assert.deepEqual(deprecated?.range, {
      start: { line: 6, character: 6 },
      end: { line: 6, character: 15 }
    });
  });

  it("logs the compiler version when the LSP client finishes initialization", () => {
    const server = startServer(false);

    server.fakeConnection.handlers.get("initialized")!({});

    assert.equal(
      server.fakeConnection.infoMessages.some((message) => message.includes(COMPILER_VERSION)),
      true
    );
  });

  it("does not log operation timings by default", async () => {
    const server = startServer(false);
    const { source, line, character } = sourceWithCursor([
      "function add(a: number, b: number): number {",
      "  return a + b",
      "}",
      "val total = ad^^^d(1, 2)",
      ""
    ].join("\n"));
    const document = openedDocument(server, source);

    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });

    assert.equal(
      server.fakeConnection.infoMessages.some((message) =>
        /^\[Timing\] textDocument\/completion took \d+(?:\.\d+)?ms$/.test(message)
      ),
      false
    );
  });

  it("logs operation timings in the LSP output channel when enabled", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: { enableLspTimings: true }
    });
    const { source, line, character } = sourceWithCursor([
      "function add(a: number, b: number): number {",
      "  return a + b",
      "}",
      "val total = ad^^^d(1, 2)",
      ""
    ].join("\n"));
    const document = openedDocument(server, source);

    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });

    assert.equal(
      server.fakeConnection.infoMessages.some((message) =>
        /^\[Timing\] textDocument\/completion took \d+(?:\.\d+)?ms$/.test(message)
      ),
      true
    );
  });

  it("logs timing phases and cache states for expensive requests when enabled", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: {
        enableLspTimings: true,
        enableLspTimingCacheEvents: true
      }
    });
    const document = openedDocument(server, [
      "declare class Graphics {",
      "  /** @deprecated since 8.0.0 Use fill instead */",
      "  beginFill(color: number): Graphics",
      "  fill(color: number): Graphics",
      "}",
      "val badge = Graphics()",
      "badge.beginFill(1)",
      ""
    ].join("\n"));

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    await server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri: document.uri }
    });
    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message.startsWith("[Timing] textDocument/diagnostic cache miss v1")
    ), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message.startsWith("[Timing] textDocument/diagnostic cache hit v1")
    ), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] textDocument\/diagnostic::analysisSession took \d+(?:\.\d+)?ms$/.test(message)
    ), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] textDocument\/semanticTokens\/full::deprecatedSemanticTokenModifiers took \d+(?:\.\d+)?ms$/.test(message)
    ), true);
  });

  it("keeps cache hit/miss logs disabled when only timings are enabled", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: { enableLspTimings: true }
    });
    const document = openedDocument(server, "val answer = 42\n");

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message.includes("cache miss")
    ), false);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message.includes("cache hit")
    ), false);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] textDocument\/diagnostic took \d+(?:\.\d+)?ms$/.test(message)
    ), true);
  });

  it("reuses cached workspace diagnostics between repeated pulls for the same document version", async () => {
    const server = startServer(true);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: { enableLspTimings: true }
    });
    const document = openedDocument(server, "val answer = 42\n");

    await server.fakeConnection.handlers.get("workspaceDiagnostics")!({});
    const afterFirstPull = server.fakeConnection.infoMessages.filter((message) =>
      message.startsWith("[Timing] workspace/diagnostic took ")
    ).length;

    await server.fakeConnection.handlers.get("workspaceDiagnostics")!({});
    const afterSecondPull = server.fakeConnection.infoMessages.filter((message) =>
      message.startsWith("[Timing] workspace/diagnostic took ")
    ).length;

    assert.equal(afterFirstPull, 1);
    assert.equal(afterSecondPull, 1);
    assert.equal(document.version, 1);
  });

  it("awaits async analysis-session resolution before returning pull diagnostics", async () => {
    const fakeConnection = createFakeConnection();
    const fakeDocuments = createFakeDocuments();
    const badSession = createAnalysisSession("val broken: number = \"text\"\n");
    const goodSession = createAnalysisSession("val fixed: number = 10\n");
    const analysisSessions = {
      getForDocument: () => badSession,
      getForDocumentAsync: async () => goodSession,
      delete: () => undefined,
      clear: () => undefined
    } as unknown as AnalysisSessionCache;
    const environment: LspServerEnvironment = {
      getSourceRoots: () => [],
      getSessionForFilePath: () => null
    };

    startLspServer({
      connection: fakeConnection.connection,
      documents: fakeDocuments.documents,
      analysisSessions,
      environment
    });

    const document = TextDocument.create(
      "file:///workspace/main.vx",
      "vexa",
      1,
      "val fixed: number = 10\n"
    );
    fakeDocuments.open(document);

    const diagnosticsPromise = fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    }) as Promise<{ kind: string; items: Array<{ message: string }> }>;

    const report = await diagnosticsPromise;

    assert.equal(report.kind, "full");
    assert.deepEqual(report.items, []);
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
        referenceCodeLens: { enabled: true },
        lsp: { timings: { enabled: true, cacheEvents: { enabled: true } } }
      });

      await server.fakeConnection.handlers.get("didChangeConfiguration")!({});

      assert.equal(server.fakeConnection.inlayHintRefreshes(), 1);
      assert.deepEqual(server.fakeConnection.sentRequests, ["workspace/codeLens/refresh"]);
    }
  });

  it("toggles timing logs when the configuration changes", async () => {
    const server = startServer(false);
    const { source, line, character } = sourceWithCursor([
      "function add(a: number, b: number): number {",
      "  return a + b",
      "}",
      "val total = ad^^^d(1, 2)",
      ""
    ].join("\n"));
    const document = openedDocument(server, source);

    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });
    assert.equal(server.fakeConnection.infoMessages.some((message) => message.includes("[Timing]")), false);

    server.fakeConnection.setConfiguration({ lsp: { timings: { enabled: true } } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    assert.equal(server.fakeConnection.infoMessages.some((message) => message.startsWith("[Timing] workspace/didChangeConfiguration took ")), true);

    const enabledCount = server.fakeConnection.infoMessages.filter((message) =>
      /^\[Timing\] textDocument\/completion took \d+(?:\.\d+)?ms$/.test(message)
    ).length;
    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });
    assert.equal(
      server.fakeConnection.infoMessages.filter((message) =>
        /^\[Timing\] textDocument\/completion took \d+(?:\.\d+)?ms$/.test(message)
      ).length > enabledCount,
      true
    );

    server.fakeConnection.setConfiguration({ lsp: { timings: { enabled: false } } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    const disabledCount = server.fakeConnection.infoMessages.filter((message) =>
      /^\[Timing\] textDocument\/completion took \d+(?:\.\d+)?ms$/.test(message)
    ).length;
    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });
    assert.equal(
      server.fakeConnection.infoMessages.filter((message) =>
        /^\[Timing\] textDocument\/completion took \d+(?:\.\d+)?ms$/.test(message)
      ).length,
      disabledCount
    );
  });

  it("toggles cache hit/miss logs independently from timing durations", async () => {
    const server = startServer(false);
    server.fakeConnection.setConfiguration({ lsp: { timings: { enabled: true } } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    const document = openedDocument(server, "val answer = 42\n");

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    assert.equal(server.fakeConnection.infoMessages.some((message) => message.includes("cache hit")), false);

    server.fakeConnection.setConfiguration({ lsp: { timings: { enabled: true, cacheEvents: { enabled: true } } } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    await server.fakeDocuments.change(TextDocument.create(document.uri, "vexa", 2, "val answer = 43\n"));
    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    assert.equal(server.fakeConnection.infoMessages.some((message) => message.includes("cache miss")), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) => message.includes("cache hit")), true);
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
