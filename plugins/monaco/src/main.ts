/// <reference types="vite/client" />

/**
 * Entry point for the MyLang Monaco browser editor.
 *
 * Boot sequence:
 *   1. Configure Monaco web workers (required before the editor is created).
 *   2. Register the MyLang language (syntax highlighting + language config).
 *   3. Fetch workspace info from the backend (/api/workspace) to discover the
 *      real file:// URI so the LSP server can resolve cross-file references.
 *   4. Create the Monaco editor model and editor instance.
 *   5. Connect to the LSP WebSocket bridge and run the initialize handshake.
 *   6. Register all language feature providers (hover, completion, etc.).
 *   7. Start document synchronization (didOpen / didChange).
 */

// Monaco requires a web worker for the editor core.
// The ?worker Vite query produces a bundled Worker constructor.
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, _label: string): Worker {
    return new editorWorker();
  },
};

import * as monaco from "monaco-editor";
import { CompilerClient } from "./compiler-client";
import {
  registerLanguage,
  registerProviders,
  pullDiagnostics,
  setModelDiagnostics,
  type SemanticTokensLegend,
} from "./lsp-providers";

// ── Default semantic tokens legend (matches compiler/lsp/semanticTokens.ts) ──

const DEFAULT_LEGEND: SemanticTokensLegend = {
  tokenTypes: [
    "keyword", "variable", "parameter", "function", "method",
    "class", "enumMember", "property", "namespace", "type",
    "number", "string", "operator",
  ],
  tokenModifiers: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(text: string, state: "connecting" | "connected" | "error" | ""): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = "status " + state;
}

function showToast(msg: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  setStatus("Connecting…", "connecting");

  // Register language syntax and config first (no LSP needed for these).
  registerLanguage();

  // ── 1. Fetch workspace info ─────────────────────────────────────────────────
  let workspaceInfo: { rootUri: string; fileUri: string; content: string };
  try {
    const res = await fetch("/api/workspace");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    workspaceInfo = (await res.json()) as typeof workspaceInfo;
  } catch (e) {
    setStatus("Failed to load workspace", "error");
    console.error("workspace fetch failed:", e);
    return;
  }

  // ── 2. Create Monaco editor ─────────────────────────────────────────────────
  const modelUri = monaco.Uri.parse(workspaceInfo.fileUri);
  const model = monaco.editor.createModel(
    workspaceInfo.content,
    "mylang",
    modelUri
  );

  const container = document.getElementById("editor-container")!;
  const editor = monaco.editor.create(container, {
    model,
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 14,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "off",
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: "selection",
    "semanticHighlighting.enabled": true,
    scrollbar: { vertical: "visible", horizontal: "visible" },
    glyphMargin: true,
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
    bracketPairColorization: { enabled: true },
  });

  // ── 3. Start the in-browser LSP worker ────────────────────────────────────
  const lsp = new CompilerClient(
    new URL("./lsp-worker.ts", import.meta.url)
  );
  await lsp.ready;

  // ── 4. LSP initialize handshake ─────────────────────────────────────────────
  type InitResult = {
    capabilities?: {
      semanticTokensProvider?: { legend?: SemanticTokensLegend };
    };
  };

  const initResult = await lsp.request<InitResult>("initialize", {
    processId: null,
    clientInfo: { name: "Monaco LSP Client", version: "1.0.0" },
    capabilities: {
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: false,
        },
        completion: {
          dynamicRegistration: false,
          completionItem: {
            snippetSupport: true,
            documentationFormat: ["markdown", "plaintext"],
            insertReplaceSupport: false,
            resolveAdditionalTextEditsSupport: true,
          },
          contextSupport: true,
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ["markdown", "plaintext"],
        },
        signatureHelp: {
          dynamicRegistration: false,
          signatureInformation: {
            documentationFormat: ["markdown", "plaintext"],
            parameterInformation: { labelOffsetSupport: true },
          },
        },
        references: { dynamicRegistration: false },
        documentHighlight: { dynamicRegistration: false },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
        },
        formatting:      { dynamicRegistration: false },
        rangeFormatting: { dynamicRegistration: false },
        onTypeFormatting: { dynamicRegistration: false },
        definition:       { dynamicRegistration: false },
        typeDefinition:   { dynamicRegistration: false },
        implementation:   { dynamicRegistration: false },
        codeAction: {
          dynamicRegistration: false,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                "", "quickfix", "refactor", "refactor.extract",
                "refactor.inline", "refactor.rewrite",
                "source", "source.organizeImports",
              ],
            },
          },
          resolveSupport: { properties: ["edit"] },
        },
        rename: { dynamicRegistration: false, prepareSupport: true },
        foldingRange: {
          dynamicRegistration: false,
          rangeLimit: 5000,
          lineFoldingOnly: true,
        },
        selectionRange: { dynamicRegistration: false },
        linkedEditingRange: { dynamicRegistration: false },
        inlayHint: { dynamicRegistration: false },
        codeLens: { dynamicRegistration: false },
        semanticTokens: {
          dynamicRegistration: false,
          requests: { full: true, range: false },
          tokenTypes: DEFAULT_LEGEND.tokenTypes,
          tokenModifiers: DEFAULT_LEGEND.tokenModifiers,
          formats: ["relative"],
          overlappingTokenSupport: false,
          multilineTokenSupport: false,
        },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
      },
      workspace: {
        applyEdit: true,
        workspaceEdit: { documentChanges: true },
        didChangeConfiguration: { dynamicRegistration: false },
      },
      window: {
        workDoneProgress: false,
        showMessage: {},
        showDocument: {},
      },
    },
    rootUri: workspaceInfo.rootUri,
    workspaceFolders: [
      { uri: workspaceInfo.rootUri, name: "workspace" },
    ],
  });

  // Prefer the legend advertised by the server.
  const legend =
    initResult?.capabilities?.semanticTokensProvider?.legend ?? DEFAULT_LEGEND;

  // Signal that the client is ready.
  lsp.notify("initialized", {});

  // ── 5. Register all Monaco providers ────────────────────────────────────────
  registerProviders(lsp, legend);

  // ── 6. Notification / request handlers ──────────────────────────────────────

  // Server can ask the client to refresh diagnostics for all open docs.
  lsp.onNotification("workspace/diagnostic/refresh", async () => {
    for (const m of monaco.editor.getModels()) {
      if (m.getLanguageId() === "mylang") {
        await pullDiagnostics(lsp, m);
      }
    }
  });

  // Push-model diagnostics (fallback if the server sends them).
  lsp.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics: Parameters<typeof setModelDiagnostics>[1] }) => {
      const m = monaco.editor.getModel(monaco.Uri.parse(params.uri));
      if (m) setModelDiagnostics(m, params.diagnostics);
    }
  );

  lsp.onNotification(
    "window/showMessage",
    (params: { type: number; message: string }) => {
      console.info("[LSP]", params.message);
    }
  );

  // ── 7. Open document and start sync ─────────────────────────────────────────
  lsp.notify("textDocument/didOpen", {
    textDocument: {
      uri: model.uri.toString(),
      languageId: "mylang",
      version: model.getVersionId(),
      text: model.getValue(),
    },
  });

  // Pull initial diagnostics.
  await pullDiagnostics(lsp, model);

  setStatus("LSP Connected", "connected");

  // Sync incremental changes to the LSP server.
  let diagTimer: ReturnType<typeof setTimeout> | undefined;
  model.onDidChangeContent((e) => {
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: model.uri.toString(), version: model.getVersionId() },
      contentChanges: e.changes.map((ch) => ({
        range: {
          start: { line: ch.range.startLineNumber - 1, character: ch.range.startColumn - 1 },
          end:   { line: ch.range.endLineNumber   - 1, character: ch.range.endColumn   - 1 },
        },
        rangeLength: ch.rangeLength,
        text: ch.text,
      })),
    });
    // Debounce diagnostic pulls to avoid hammering the server while typing.
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => pullDiagnostics(lsp, model), 600);
  });

  // ── Toolbar buttons ──────────────────────────────────────────────────────────
  document.getElementById("btn-format")!.addEventListener("click", () => {
    editor.getAction("editor.action.formatDocument")?.run();
  });

  document.getElementById("btn-save")!.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: model.getValue() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast("Saved");
    } catch (e) {
      showToast("Save failed: " + String(e));
    }
  });

  // Ctrl/Cmd+S → save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    document.getElementById("btn-save")!.click();
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  setStatus("Error: " + String(e), "error");
});
