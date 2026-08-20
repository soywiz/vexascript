import {
  assert,
  describe,
  fileURLToPath,
  it,
  join,
  mkdir,
  mkdtemp,
  pathToFileURL,
  tmpdir,
  writeFile
} from "../test/expect";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection, TextDocuments } from "vscode-languageserver/node.js";
import { COMPILER_VERSION } from "compiler/compilerVersion";
import { AnalysisSessionCache, createAnalysisSession } from "./analysisSession";
import { sourceWithCursor } from "compiler/test/sourceWithCursor";
import { parseSource } from "compiler/pipeline/parse";
import { VEXA_SEMANTIC_TOKENS_LEGEND } from "./semanticTokens";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import {
  getDeprecatedSemanticTokenWorkMetrics,
  resetDeprecatedSemanticTokenWorkMetrics
} from "./deprecatedSemanticTokens";
import {
  getCrossFileMemberDiagnosticWorkMetrics,
  resetCrossFileMemberDiagnosticWorkMetrics
} from "./memberDiagnostics";
import { getProjectIndex, type ProjectIndex } from "./projectAnalysis";
import { resolve as resolvePath } from "compiler/utils/path";
import {
  candidateCharacters,
  slowLspTimingWarning,
  startLspServer,
  type LspServerEnvironment
} from "./serverCore";

type Handler = (...args: unknown[]) => unknown;

interface FakeConnection {
  connection: Connection;
  handlers: Map<string, Handler>;
  diagnosticsRefreshes: () => number;
  inlayHintRefreshes: () => number;
  sentNotifications: Array<{ method: string; params: unknown }>;
  sentRequests: string[];
  infoMessages: string[];
  listened: () => boolean;
  setConfiguration: (value: unknown) => void;
}

function createFakeConnection(): FakeConnection {
  const handlers = new Map<string, Handler>();
  const sentRequests: string[] = [];
  const sentNotifications: Array<{ method: string; params: unknown }> = [];
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
    sendNotification: (method: string, params: unknown) => {
      sentNotifications.push({ method, params });
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
    sentNotifications,
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
  analysisSessions: AnalysisSessionCache;
  environmentEvents: string[];
}

function startServer(
  withWorkspace: boolean,
  waitForDocumentDiagnosticIdle: () => Promise<void> = async () => undefined
): StartedServer {
  const fakeConnection = createFakeConnection();
  const fakeDocuments = createFakeDocuments();
  const environmentEvents: string[] = [];
  const analysisSessions = new AnalysisSessionCache();
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
    analysisSessions,
    waitForDocumentDiagnosticIdle,
    environment
  });

  return { fakeConnection, fakeDocuments, analysisSessions, environmentEvents };
}

function openedDocument(server: StartedServer, source: string, uri = "file:///workspace/main.vx"): TextDocument {
  const document = TextDocument.create(uri, "vexa", 1, source);
  server.fakeDocuments.open(document);
  return document;
}

function decodeSemanticTokenModifierBits(data: number[]): Array<{ line: number; character: number; length: number; modifierBits: number }> {
  const decoded: Array<{ line: number; character: number; length: number; modifierBits: number }> = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    line += data[index]!;
    character = data[index] === 0 ? character + data[index + 1]! : data[index + 1]!;
    decoded.push({
      line,
      character,
      length: data[index + 2]!,
      modifierBits: data[index + 4]!
    });
  }
  return decoded;
}

async function createWorkspaceAnalysisSessionCache(workspaceRoot: string): Promise<{
  analysisSessions: AnalysisSessionCache;
  projectIndex: ProjectIndex;
  getSessionForFilePath: (filePath: string) => Promise<Awaited<ReturnType<ProjectIndex["getSessionForFilePath"]>>>;
}> {
  const projectIndex = getProjectIndex([workspaceRoot]);

  async function getSessionForFilePath(filePath: string) {
    return projectIndex.getSessionForFilePath(resolvePath(filePath));
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

    const { externalDeclarations, importedSymbols, invalidImportedBindings } =
      await collectAllImportedDeclarations(baseSession.ast, {
        uri: document.uri,
        sourceRoots: [workspaceRoot],
        getSessionForFilePath,
        ambientModuleDeclarations: new Map(),
        ambientGlobalDeclarations: []
      });

    return {
      externalDeclarations,
      importedSymbols,
      invalidImportedBindings,
      ambientDeclarations: [],
      ambientDeclarationLocations: new Map(),
      ambientModuleDeclarations: new Map(),
      ambientModuleLocations: new Map()
    };
  });

  return {
    analysisSessions,
    projectIndex,
    getSessionForFilePath
  };
}

async function startWorkspaceBackedServer(workspaceRoot: string): Promise<StartedServer> {
  const fakeConnection = createFakeConnection();
  const fakeDocuments = createFakeDocuments();
  const environmentEvents: string[] = [];
  const { analysisSessions, projectIndex, getSessionForFilePath } = await createWorkspaceAnalysisSessionCache(workspaceRoot);

  const environment: LspServerEnvironment = {
    getSourceRoots: () => [workspaceRoot],
    getSessionForFilePath,
    onDocumentOpenedOrChanged: (document) => {
      environmentEvents.push(`open-or-change:${document.uri}`);
      const filePath = document.uri.startsWith("file:") ? fileURLToPath(document.uri) : null;
      if (filePath) {
        projectIndex.upsertOpenDocument(filePath, document.getText()).catch(() => undefined);
      }
    },
    onDocumentClosed: (document) => {
      environmentEvents.push(`close:${document.uri}`);
      const filePath = document.uri.startsWith("file:") ? fileURLToPath(document.uri) : null;
      if (filePath) {
        projectIndex.clearOpenDocument(filePath);
        projectIndex.invalidateFile(filePath);
      }
    },
    workspace: {
      refreshDiagnosticsCommand: "vexa.refreshDiagnostics",
      onWatchedFileChanged: (filePath: string) => {
        environmentEvents.push(`watched:${filePath}`);
        projectIndex.invalidateFile(filePath);
      }
    }
  };

  startLspServer({
    connection: fakeConnection.connection,
    documents: fakeDocuments.documents,
    analysisSessions,
    waitForDocumentDiagnosticIdle: async () => undefined,
    environment
  });

  return { fakeConnection, fakeDocuments, analysisSessions, environmentEvents };
}

describe("LSP server core", () => {
  it("marks LSP timing observations above the slow and super-slow thresholds", () => {
    assert.equal(slowLspTimingWarning("textDocument/completion", 249.9), null);
    assert.equal(
      slowLspTimingWarning("textDocument/completion", 250),
      "⚠️ SLOW textDocument/completion took 250.0ms"
    );
    assert.equal(
      slowLspTimingWarning("textDocument/completion", 750),
      "🚨 SUPER SLOW textDocument/completion took 750.0ms"
    );
  });
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

  it("preserves auto-await decorations until shared diagnostic analysis is ready, then requests a refresh", async () => {
    const server = startServer(false);
    const document = openedDocument(server,
      "async fun fetchValue(): Promise<int> { return 1 }\n" +
      "sync fun main(): void {\n" +
      "  fetchValue()\n" +
      "}\n"
    );
    const decorations = server.fakeConnection.handlers.get("request:vexa/autoAwaitDecorations")!;

    assert.equal(await decorations({ textDocument: { uri: document.uri } }), null);
    assert.equal(server.analysisSessions.getMetrics().baseSessionBuilds, 0);

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    assert.deepEqual(server.fakeConnection.sentNotifications, [{
      method: "vexa/autoAwaitDecorations/refresh",
      params: { uri: document.uri, version: document.version }
    }]);
    const refreshedDecorations = await decorations({ textDocument: { uri: document.uri } }) as Array<{
      range: { start: { line: number } };
    }>;
    assert.deepEqual(refreshedDecorations.map((decoration) => decoration.range.start.line), [2]);
    assert.equal(server.analysisSessions.getMetrics().baseSessionBuilds, 1);
  });

  it("advertises workspace capabilities only when a workspace environment exists", async () => {
    const node = startServer(true);
    const browser = startServer(false);
    const initializeParams = { initializationOptions: { enableReferenceCodeLens: true } };

    const nodeResult = await node.fakeConnection.handlers.get("initialize")!(initializeParams) as {
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
    };
    const browserResult = await browser.fakeConnection.handlers.get("initialize")!(initializeParams) as {
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
      triggerCharacters: [".", "@", ":", "$", "#", "/", " ", ",", "<"]
    });
    assert.deepEqual(browserResult.capabilities["completionProvider"], {
      resolveProvider: false,
      triggerCharacters: [".", "@", ":", "$", "#", "/", " ", ",", "<"]
    });
    assert.deepEqual(nodeResult.capabilities["documentOnTypeFormattingProvider"], {
      firstTriggerCharacter: "\n",
      moreTriggerCharacter: ["}", ">"]
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

  it("serves contextual JSX and object completions for space and comma triggers", async () => {
    const server = startServer(false);
    const declarations = [
      "interface Style { display?: string; gap?: string }",
      "function Counter({ id: string, style: Style }) { return null }"
    ];
    const attributeCursor = sourceWithCursor([
      ...declarations,
      "function App() {",
      "  return <Counter ^^^/>",
      "}",
      ""
    ].join("\n"));
    const attributeDocument = openedDocument(server, attributeCursor.source);
    const attributeItems = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: attributeDocument.uri },
      position: { line: attributeCursor.line, character: attributeCursor.character },
      context: { triggerKind: 2, triggerCharacter: " " }
    }) as Array<{ label: string }>;

    assert.equal(attributeItems.some((item) => item.label === "id"), true);
    assert.equal(attributeItems.some((item) => item.label === "style"), true);

    const styleCursor = sourceWithCursor([
      ...declarations,
      "function App() {",
      "  return <Counter style={{ display: \"flex\",^^^ }} />",
      "}",
      ""
    ].join("\n"));
    const styleDocument = openedDocument(server, styleCursor.source, "file:///workspace/style.vx");
    const styleItems = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: styleDocument.uri },
      position: { line: styleCursor.line, character: styleCursor.character },
      context: { triggerKind: 2, triggerCharacter: "," }
    }) as Array<{ label: string }>;

    assert.equal(styleItems.some((item) => item.label === "gap"), true);
    assert.equal(styleItems.some((item) => item.label === "display"), false);

    const continuedCursor = sourceWithCursor([
      ...declarations,
      "function App() {",
      "  return <Counter style={{ display: \"flex\", ^^^ }} />",
      "}",
      ""
    ].join("\n"));
    const continuedDocument = openedDocument(server, continuedCursor.source, "file:///workspace/continued-style.vx");
    const continuedItems = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: continuedDocument.uri },
      position: { line: continuedCursor.line, character: continuedCursor.character },
      context: { triggerKind: 2, triggerCharacter: " " }
    }) as Array<{ label: string }>;

    assert.equal(continuedItems.some((item) => item.label === "gap"), true);

  });

  it("serves JSX block snippets even when the unfinished marker has no AST", async () => {
    const server = startServer(false);
    const { source, line, character } = sourceWithCursor([
      "func View() {",
      "  return <div>",
      "    {#^^^",
      "  </div>",
      "}",
      ""
    ].join("\n"));
    const document = openedDocument(server, source);

    const completionItems = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    }) as Array<{
      label: string;
      insertTextFormat?: number;
      textEdit?: { newText: string };
    }>;

    const forBlock = completionItems.find((item) => item.label === "for block");
    assert.equal(forBlock?.textEdit?.newText, "for ${1:item} of ${2:items}}\n  $0\n{/for}");
    assert.equal(forBlock?.insertTextFormat, 2);
  });

  it("serves intrinsic JSX tags through the LSP route while the opening tag is incomplete", async () => {
    const ambientDeclarations = parseSource([
      "namespace JSX {",
      "  interface IntrinsicElements {",
      "    div: any",
      "    h1: any",
      "  }",
      "}"
    ].join("\n"), { language: "typescript" }).ast!.body;
    const fakeConnection = createFakeConnection();
    const fakeDocuments = createFakeDocuments();
    const analysisSessions = new AnalysisSessionCache(async () => ({
      externalDeclarations: [],
      importedSymbols: new Map(),
      invalidImportedBindings: new Set(),
      ambientDeclarations,
      ambientDeclarationLocations: new Map(),
      ambientModuleDeclarations: new Map(),
      ambientModuleLocations: new Map()
    }));

    startLspServer({
      connection: fakeConnection.connection,
      documents: fakeDocuments.documents,
      analysisSessions,
      waitForDocumentDiagnosticIdle: async () => undefined,
      environment: {
        getSourceRoots: () => [],
        getSessionForFilePath: () => null
      }
    });

    const source = "func View() { return <di";
    const document = TextDocument.create("file:///workspace/main.vx", "vexa", 1, source);
    fakeDocuments.open(document);
    const items = await fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line: 0, character: source.length }
    }) as Array<{ label: string }>;

    assert.equal(items.some((item) => item.label === "div"), true);
    assert.equal(items.some((item) => item.label === "h1"), false);
  });

  it("serves the nearest pending JSX closing tag through the LSP route", async () => {
    const server = startServer(false);
    const source = "func View() { return <button><div></";
    const document = openedDocument(server, source);
    const items = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line: 0, character: source.length },
      context: { triggerKind: 2, triggerCharacter: "/" }
    }) as Array<{ label: string; textEdit?: { newText?: string } }>;

    assert.equal(items.find((item) => item.label === "div")?.textEdit?.newText, "div>");
  });

  it("closes JSX tags through the shared on-type formatting route", () => {
    const server = startServer(false);
    const source = "function View() { return <SignalCounter>";
    const document = openedDocument(server, source);
    const edits = server.fakeConnection.handlers.get("documentOnTypeFormatting")!({
      textDocument: { uri: document.uri },
      position: { line: 0, character: source.length },
      ch: ">"
    }) as Array<{ range: unknown; newText: string }>;

    assert.deepEqual(edits, [{
      range: {
        start: { line: 0, character: source.length },
        end: { line: 0, character: source.length }
      },
      newText: "</SignalCounter>"
    }]);
  });

  it("closes JSX tags from the editor's current text when requested by the VS Code adapter", () => {
    const server = startServer(false);
    const source = "function View() { return <div>";
    const document = openedDocument(server, "function View() { return <div");
    const edits = server.fakeConnection.handlers.get("request:vexa/onTypeFormatting")!({
      textDocument: { uri: document.uri },
      position: { line: 0, character: source.length },
      ch: ">",
      text: source
    }) as Array<{ range: unknown; newText: string }>;

    assert.deepEqual(edits, [{
      range: {
        start: { line: 0, character: source.length },
        end: { line: 0, character: source.length }
      },
      newText: "</div>"
    }]);
  });

  it("consumes an existing auto-inserted brace through the LSP completion route", async () => {
    const server = startServer(false);
    const { source, line, character } = sourceWithCursor([
      "func View({ items: number[] }) {",
      "  return <div>",
      "    {#for^^^}",
      "  </div>",
      "}",
      ""
    ].join("\n"));
    const document = openedDocument(server, source);

    const completionItems = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    }) as Array<{
      label: string;
      textEdit?: { range?: { end?: { character?: number } } };
    }>;
    const forBlock = completionItems.find((item) => item.label === "for block");

    assert.equal(forBlock?.textEdit?.range?.end?.character, character + 1);
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

  it("coalesces intermediate document versions into one diagnostic analysis", async () => {
    const waiters: Array<() => void> = [];
    const server = startServer(false, () => new Promise<void>((resolve) => waiters.push(resolve)));
    const uri = "file:///workspace/coalesced.vx";
    const documentV1 = openedDocument(server, "let value = 1\n", uri);
    const documentV2 = TextDocument.create(uri, "vexa", 2, "let value = 12\n");
    server.fakeDocuments.change(documentV2);

    const reportPromise = server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri }
    }) as Promise<{ kind: string; items: unknown[]; resultId: string }>;
    await Promise.resolve();
    assert.equal(waiters.length, 1);
    assert.equal(server.analysisSessions.getMetrics().asynchronousRequests, 0);

    const documentV3 = TextDocument.create(uri, "vexa", 3, "let value = 123\n");
    server.fakeDocuments.change(documentV3);
    waiters.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(waiters.length, 1);
    assert.equal(server.analysisSessions.getMetrics().asynchronousRequests, 0);

    const documentV4 = TextDocument.create(uri, "vexa", 4, "let value = 1234\n");
    server.fakeDocuments.change(documentV4);
    waiters.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(waiters.length, 1);
    assert.equal(server.analysisSessions.getMetrics().asynchronousRequests, 0);

    waiters.shift()!();
    const report = await reportPromise;

    assert.equal(documentV1.version, 1);
    assert.equal(report.resultId, "4");
    assert.deepEqual(report.items, []);
    assert.deepEqual(server.analysisSessions.getMetrics(), {
      synchronousRequests: 0,
      asynchronousRequests: 1,
      sessionCacheHits: 0,
      sessionCacheMisses: 1,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 1,
      resolvedSessionBuilds: 0
    });

    const cachedReport = await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri }
    }) as { resultId: string };
    assert.equal(cachedReport.resultId, "4");
    assert.equal(waiters.length, 0);
    assert.equal(server.analysisSessions.getMetrics().asynchronousRequests, 1);
  });

  it("does not idle-wait for a document version whose source is unchanged", async () => {
    const waiters: Array<() => void> = [];
    const server = startServer(false, () => new Promise<void>((resolve) => waiters.push(resolve)));
    const uri = "file:///workspace/unchanged.vx";
    const source = "let value = 1\n";
    openedDocument(server, source, uri);
    server.fakeDocuments.change(TextDocument.create(uri, "vexa", 2, source));

    const report = await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri }
    }) as { resultId: string };

    assert.equal(report.resultId, "2");
    assert.equal(waiters.length, 0);
    assert.equal(server.analysisSessions.getMetrics().asynchronousRequests, 1);
  });

  it("serves syntax-only editor refreshes without starting semantic analysis", async () => {
    const server = startServer(false);
    const document = openedDocument(server, [
      "func greet(name: string) {",
      "  return name",
      "}",
      "greet(\"Vexa\")",
      ""
    ].join("\n"));
    server.analysisSessions.resetMetrics();

    const symbols = await server.fakeConnection.handlers.get("documentSymbol")!({
      textDocument: { uri: document.uri }
    }) as unknown[];
    const folds = await server.fakeConnection.handlers.get("foldingRanges")!({
      textDocument: { uri: document.uri }
    }) as unknown[];
    const selections = await server.fakeConnection.handlers.get("selectionRanges")!({
      textDocument: { uri: document.uri },
      positions: [{ line: 1, character: 2 }]
    }) as unknown[];
    const semantic = await server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri: document.uri }
    }) as { data: number[] };
    const highlights = await server.fakeConnection.handlers.get("documentHighlight")!({
      textDocument: { uri: document.uri },
      position: { line: 1, character: 9 }
    }) as unknown[];
    const codeActions = await server.fakeConnection.handlers.get("codeAction")!({
      textDocument: { uri: document.uri },
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 13 }
      },
      context: { diagnostics: [] }
    }) as unknown[];

    assert.equal(symbols.length > 0, true);
    assert.equal(folds.length > 0, true);
    assert.equal(selections.length, 1);
    assert.equal(semantic.data.length > 0, true);
    assert.equal(highlights.length > 0, true);
    assert.deepEqual(codeActions, []);
    assert.deepEqual(server.analysisSessions.getMetrics(), {
      synchronousRequests: 0,
      asynchronousRequests: 0,
      sessionCacheHits: 0,
      sessionCacheMisses: 0,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 0,
      resolvedSessionBuilds: 0
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
        /^\[Timing\] textDocument\/completion self \d+(?:\.\d+)?ms$/.test(message)
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
        /^\[Timing\] textDocument\/completion self \d+(?:\.\d+)?ms$/.test(message)
      ),
      true
    );
    assert.equal(
      server.fakeConnection.infoMessages.some((message) => message.includes(" elapsed ")),
      false
    );
  });

  it("skips completion analysis for a document version superseded by the next keystroke", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: { enableLspTimings: true }
    });
    const uri = "file:///workspace/main.vx";
    const prefix = "declare function line(): unknown\nconst trend = line()\n  ";
    const intermediate = TextDocument.create(uri, "vexa", 2, `${prefix}.`);
    server.fakeDocuments.open(TextDocument.create(uri, "vexa", 1, prefix));
    server.fakeDocuments.change(intermediate);
    server.analysisSessions.resetMetrics();

    const supersededCompletion = server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri },
      position: intermediate.positionAt(intermediate.getText().length),
      context: { triggerKind: 2, triggerCharacter: "." }
    }) as Promise<Array<{ label: string }>>;

    const current = TextDocument.create(uri, "vexa", 3, `${prefix}.x`);
    server.fakeDocuments.change(current);
    const currentCompletion = server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri },
      position: current.positionAt(current.getText().length),
      context: { triggerKind: 1 }
    }) as Promise<Array<{ label: string }>>;

    const [supersededItems, currentItems] = await Promise.all([
      supersededCompletion,
      currentCompletion
    ]);

    assert.deepEqual(supersededItems, []);
    assert.equal(Array.isArray(currentItems), true);
    assert.deepEqual(server.analysisSessions.getMetrics(), {
      synchronousRequests: 0,
      asynchronousRequests: 1,
      sessionCacheHits: 0,
      sessionCacheMisses: 1,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 1,
      resolvedSessionBuilds: 0
    });
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message === "[Timing] textDocument/completion work requestedVersion=2 currentVersion=3 staleVersionSkips=1 analysisSessionRequests=0"
    ), true);
  });

  it("serves matching in-scope identifier completions through the canonical session", async () => {
    const server = startServer(false);
    const marked = sourceWithCursor([
      "func delay(ms: number) {}",
      "d^^^"
    ].join("\n"));
    const document = openedDocument(server, marked.source);
    server.analysisSessions.resetMetrics();

    const items = await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line: marked.line, character: marked.character },
      context: { triggerKind: 1 }
    }) as Array<{ label: string; detail?: string }>;

    assert.equal(items.some((item) => item.label === "delay" && item.detail?.startsWith("In-scope function")), true);
    assert.deepEqual(server.analysisSessions.getMetrics(), {
      synchronousRequests: 0,
      asynchronousRequests: 1,
      sessionCacheHits: 0,
      sessionCacheMisses: 1,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 1,
      resolvedSessionBuilds: 0
    });
  });

  it("skips signature-help analysis for a document version superseded by the next keystroke", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: { enableLspTimings: true }
    });
    const uri = "file:///workspace/main.vx";
    const prefix = "func greet(name: string) => name\n";
    const intermediate = TextDocument.create(uri, "vexa", 2, `${prefix}greet(`);
    server.fakeDocuments.open(TextDocument.create(uri, "vexa", 1, prefix));
    server.fakeDocuments.change(intermediate);
    server.analysisSessions.resetMetrics();

    const supersededSignatureHelp = server.fakeConnection.handlers.get("signatureHelp")!({
      textDocument: { uri },
      position: intermediate.positionAt(intermediate.getText().length)
    }) as Promise<unknown>;

    const current = TextDocument.create(uri, "vexa", 3, `${prefix}greet("Vexa")`);
    server.fakeDocuments.change(current);

    assert.equal(await supersededSignatureHelp, null);
    assert.deepEqual(server.analysisSessions.getMetrics(), {
      synchronousRequests: 0,
      asynchronousRequests: 0,
      sessionCacheHits: 0,
      sessionCacheMisses: 0,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 0,
      resolvedSessionBuilds: 0
    });
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message === "[Timing] textDocument/signatureHelp work requestedVersion=2 currentVersion=3 staleVersionSkips=1 analysisSessionRequests=0"
    ), true);
  });

  it("skips semantic analysis inside a trailing callback body", async () => {
    const server = startServer(false);
    const marked = sourceWithCursor([
      "declare function route(path: string, handler: () => void): void",
      "func delay(ms: number) {}",
      "route(\"/users\") async {",
      "  await delay(1000)",
      "  del^^^",
      "}"
    ].join("\n"));
    const document = openedDocument(server, marked.source);
    server.analysisSessions.resetMetrics();

    const signatureHelp = await server.fakeConnection.handlers.get("signatureHelp")!({
      textDocument: { uri: document.uri },
      position: { line: marked.line, character: marked.character }
    });

    assert.equal(signatureHelp, null);
    assert.deepEqual(server.analysisSessions.getMetrics(), {
      synchronousRequests: 0,
      asynchronousRequests: 0,
      sessionCacheHits: 0,
      sessionCacheMisses: 0,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 0,
      resolvedSessionBuilds: 0
    });
  });

  it("serves signature help for the current document through the asynchronous session path", async () => {
    const server = startServer(false);
    const marked = sourceWithCursor([
      "func greet(name: string) => name",
      "greet(^^^)"
    ].join("\n"));
    const document = openedDocument(server, marked.source);
    server.analysisSessions.resetMetrics();

    const signatureHelp = await server.fakeConnection.handlers.get("signatureHelp")!({
      textDocument: { uri: document.uri },
      position: { line: marked.line, character: marked.character }
    }) as { signatures: Array<{ label: string }> } | null;

    assert.equal(signatureHelp?.signatures[0]?.label, "greet(name: string): string");
    assert.equal(server.analysisSessions.getMetrics().synchronousRequests, 0);
    assert.equal(server.analysisSessions.getMetrics().asynchronousRequests, 1);
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
      /^\[Timing\] textDocument\/diagnostic::analysisSession self \d+(?:\.\d+)?ms$/.test(message)
    ), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] textDocument\/semanticTokens\/full::buildTokens self \d+(?:\.\d+)?ms$/.test(message)
    ), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] textDocument\/semanticTokens\/full::deprecatedSemanticTokenModifiers self \d+(?:\.\d+)?ms$/.test(message)
    ), true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] deprecatedSemanticTokenModifiers work members=\d+ candidates=\d+ resolutions=\d+ resolutionCacheHits=\d+ declarationNodes=\d+ declarationRootCacheHits=\d+$/.test(message)
    ), true);
  });

  it("bounds workspace member diagnostics for an incomplete member chain after an edit", async () => {
    const server = startServer(true);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: { enableLspTimings: true }
    });
    const source = [
      "declare interface Line {",
      "  x(accessor: (value: number) => number): Line",
      "}",
      "declare function line(): Line",
      "const trend = line()",
      "  .x((value) => value)",
      ""
    ].join("\n");
    const document = openedDocument(server, source);

    await server.fakeConnection.handlers.get("workspaceDiagnostics")!({});
    resetCrossFileMemberDiagnosticWorkMetrics();
    const editedDocument = TextDocument.create(
      document.uri,
      "vexa",
      2,
      source.replace("  .x((value)", "  .x\n  .x((value)")
    );
    server.fakeDocuments.change(editedDocument);
    await server.fakeConnection.handlers.get("workspaceDiagnostics")!({});
    const editWork = getCrossFileMemberDiagnosticWorkMetrics();

    assert.equal(editWork.collections, 1);
    assert.equal(editWork.memberExpressionsVisited, 2);
    assert.equal(editWork.analyzedMemberSkips, 1);
    assert.equal(editWork.unsupportedReceiverSkips, 1);
    assert.equal(editWork.objectTypeResolutions, 0);
    assert.equal(editWork.classResolutions, 0);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] workspaceMemberDiagnostics work members=2 analysisSkips=1 unsupportedReceiverSkips=1 unknownReceiverSkips=0 unsupportedReceiverChainSkips=0 objectTypes=0 unresolvedObjectTypeSkips=0 classes=0 membersResolved=0 extensions=0 diagnostics=0$/.test(message)
    ), true);
  });

  it("marks deprecated members in semantic tokens through the LSP route", async () => {
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

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    const semantic = await server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri: document.uri }
    }) as { data: number[] };
    const deprecatedBit = 1 << VEXA_SEMANTIC_TOKENS_LEGEND.tokenModifiers.indexOf("deprecated");
    const beginFillToken = decodeSemanticTokenModifierBits(semantic.data).find((token) =>
      token.line === 6 && token.character === 6 && token.length === "beginFill".length
    );

    assert.equal((beginFillToken?.modifierBits ?? 0) & deprecatedBit, deprecatedBit);
  });

  it("bounds deprecated-member work after an ordinary document edit", async () => {
    const server = startServer(false);
    const source = [
      "declare class Chart {",
      "  attr(name: string, value: string): Chart",
      "}",
      "val chart = Chart()",
      "chart.attr(\"role\", \"img\")",
      ""
    ].join("\n");
    const document = openedDocument(server, source);

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    resetDeprecatedSemanticTokenWorkMetrics();
    await server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri: document.uri }
    });

    resetDeprecatedSemanticTokenWorkMetrics();
    const editedDocument = TextDocument.create(document.uri, "vexa", 2, source.replace("img", "figure"));
    server.fakeDocuments.change(editedDocument);
    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });
    await server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri: document.uri }
    });
    const editWork = getDeprecatedSemanticTokenWorkMetrics();

    assert.equal(editWork.collections, 1);
    assert.equal(editWork.memberExpressionsVisited, 1);
    assert.equal(editWork.candidateMemberExpressions, 0);
    assert.equal(editWork.uniqueMemberResolutions, 0);
    assert.equal(editWork.candidateIndexRootCacheHits >= 1, true);
  });

  it("derives semantic token ranges from the cached full result for the same document version", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: {
        enableLspTimings: true,
        enableLspTimingCacheEvents: true
      }
    });
    const document = openedDocument(server, [
      "val answer = 42",
      "val total = answer + 1",
      ""
    ].join("\n"));

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    const full = await server.fakeConnection.handlers.get("semanticTokens")!({
      textDocument: { uri: document.uri }
    }) as { data: number[] };
    const range = {
      start: { line: 1, character: 0 },
      end: { line: 2, character: 0 }
    };
    const ranged = await server.fakeConnection.handlers.get("semanticTokensRange")!({
      textDocument: { uri: document.uri },
      range
    }) as { data: number[] };

    assert.equal(full.data.length > ranged.data.length, true);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      /^\[Timing\] textDocument\/semanticTokens\/range::analysisSession self \d+(?:\.\d+)?ms$/.test(message)
    ), false);
    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message.startsWith("[Timing] textDocument/semanticTokens/range cache hit v1")
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
      /^\[Timing\] textDocument\/diagnostic self \d+(?:\.\d+)?ms$/.test(message)
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
      message.startsWith("[Timing] workspace/diagnostic self ")
    ).length;

    await server.fakeConnection.handlers.get("workspaceDiagnostics")!({});
    const afterSecondPull = server.fakeConnection.infoMessages.filter((message) =>
      message.startsWith("[Timing] workspace/diagnostic self ")
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
    const emptyMetrics = {
      synchronousRequests: 0,
      asynchronousRequests: 0,
      sessionCacheHits: 0,
      sessionCacheMisses: 0,
      pendingSessionReuses: 0,
      externalCacheHits: 0,
      externalCacheMisses: 0,
      pendingExternalReuses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 0,
      resolvedSessionBuilds: 0
    };
    const analysisSessions = {
      getForDocument: () => badSession,
      getForDocumentAsync: async () => goodSession,
      getMetrics: () => emptyMetrics,
      setProfileObserver: () => undefined,
      setSessionUpdatedObserver: () => undefined,
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
      waitForDocumentDiagnosticIdle: async () => undefined,
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

  it("clears analysis sessions when watched workspace files change", () => {
    const fakeConnection = createFakeConnection();
    const fakeDocuments = createFakeDocuments();
    let clears = 0;
    const analysisSessions = {
      clear: () => {
        clears += 1;
      },
      delete: () => undefined,
      getMetrics: () => ({
        synchronousRequests: 0,
        asynchronousRequests: 0,
        sessionCacheHits: 0,
        sessionCacheMisses: 0,
        pendingSessionReuses: 0,
        externalCacheHits: 0,
        externalCacheMisses: 0,
        pendingExternalReuses: 0,
        externalResolverRuns: 0,
        baseSessionBuilds: 0,
        resolvedSessionBuilds: 0
      }),
      setProfileObserver: () => undefined,
      setSessionUpdatedObserver: () => undefined,
      getForDocument: () => createAnalysisSession(""),
      getForDocumentAsync: async () => createAnalysisSession("")
    } as unknown as AnalysisSessionCache;

    startLspServer({
      connection: fakeConnection.connection,
      documents: fakeDocuments.documents,
      analysisSessions,
      waitForDocumentDiagnosticIdle: async () => undefined,
      environment: {
        getSourceRoots: () => [],
        getSessionForFilePath: () => null,
        workspace: {
          refreshDiagnosticsCommand: "vexa.refreshDiagnostics",
          onWatchedFileChanged: () => undefined
        }
      }
    });

    fakeConnection.handlers.get("didChangeWatchedFiles")!({
      changes: [{ uri: "file:///workspace/dependency.vx" }]
    });

    assert.equal(clears, 1);
  });

  it("invalidates cross-file diagnostics after watched dependency edits without reopening the document", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "vexa-lsp-workspace-"));
    const depPath = join(workspaceRoot, "dep.vx");
    const mainPath = join(workspaceRoot, "main.vx");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(depPath, "export function takesValue(value: number) {}\n", "utf8");
    await writeFile(mainPath, "import { takesValue } from \"./dep\"\ntakesValue(1)\n", "utf8");

    const server = await startWorkspaceBackedServer(workspaceRoot);
    const mainUri = pathToFileURL(mainPath).href;
    const initialSource = "import { takesValue } from \"./dep\"\ntakesValue(1)\n";
    const document = TextDocument.create(mainUri, "vexa", 1, initialSource);
    server.fakeDocuments.open(document);

    const initialReport = await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    }) as { kind: string; items: Array<{ message: string }> };
    assert.equal(initialReport.kind, "full");
    assert.deepEqual(initialReport.items, []);

    await writeFile(depPath, "export function takesValue(value: string) {}\n", "utf8");
    server.fakeConnection.handlers.get("didChangeWatchedFiles")!({
      changes: [{ uri: pathToFileURL(depPath).href }]
    });

    const updatedReport = await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    }) as { kind: string; items: Array<{ message: string }> };
    assert.equal(updatedReport.kind, "full");
    assert.equal(
      updatedReport.items.some((item) =>
        item.message.includes("string")
        && (item.message.includes("not assignable") || item.message.includes("expected"))
      ),
      true
    );
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
    assert.equal(server.fakeConnection.infoMessages.some((message) => message.startsWith("[Timing] workspace/didChangeConfiguration self ")), false);

    const enabledCount = server.fakeConnection.infoMessages.filter((message) =>
      /^\[Timing\] textDocument\/completion self \d+(?:\.\d+)?ms$/.test(message)
    ).length;
    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });
    assert.equal(
      server.fakeConnection.infoMessages.filter((message) =>
        /^\[Timing\] textDocument\/completion self \d+(?:\.\d+)?ms$/.test(message)
      ).length > enabledCount,
      true
    );

    server.fakeConnection.setConfiguration({ lsp: { timings: { enabled: false } } });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    const disabledCount = server.fakeConnection.infoMessages.filter((message) =>
      /^\[Timing\] textDocument\/completion self \d+(?:\.\d+)?ms$/.test(message)
    ).length;
    await server.fakeConnection.handlers.get("completion")!({
      textDocument: { uri: document.uri },
      position: { line, character }
    });
    assert.equal(
      server.fakeConnection.infoMessages.filter((message) =>
        /^\[Timing\] textDocument\/completion self \d+(?:\.\d+)?ms$/.test(message)
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

  it("preserves diagnostic caches across configuration changes that only affect editor features", async () => {
    const server = startServer(false);
    server.fakeConnection.handlers.get("initialize")!({
      initializationOptions: {
        enableLspTimings: true,
        enableLspTimingCacheEvents: true
      }
    });
    const document = openedDocument(server, "val answer = 42\n");

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    const refreshesBeforeConfig = server.fakeConnection.diagnosticsRefreshes();
    server.fakeConnection.setConfiguration({
      inlayHints: { parameters: false, types: true },
      referenceCodeLens: { enabled: true },
      lsp: { timings: { enabled: true, cacheEvents: { enabled: true } } }
    });
    await server.fakeConnection.handlers.get("didChangeConfiguration")!({});
    assert.equal(server.fakeConnection.diagnosticsRefreshes(), refreshesBeforeConfig);

    await server.fakeConnection.handlers.get("diagnostics")!({
      textDocument: { uri: document.uri }
    });

    assert.equal(server.fakeConnection.infoMessages.some((message) =>
      message.startsWith("[Timing] textDocument/diagnostic cache hit v1")
    ), true);
  });

  it("derives candidate characters consistently", () => {
    assert.deepEqual(candidateCharacters(0), [0, 1]);
    assert.deepEqual(candidateCharacters(3), [3, 2, 4]);
  });
});
