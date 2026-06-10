const path = require("node:path");
const { commands, Location, Position, Range, Uri, workspace, window } = require("vscode");
const {
  LanguageClient,
  TransportKind
} = require("vscode-languageclient/node");

/** @type {LanguageClient | undefined} */
let client;

function activate(context) {
  const outputChannel = window.createOutputChannel("VexaScript LSP");
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    commands.registerCommand("vexa.showReferences", (uri, position, locations) => {
      const targetUri = typeof uri === "string" ? Uri.parse(uri) : uri;
      const targetPosition = new Position(position.line, position.character);
      const targetLocations = (locations ?? []).map((location) =>
        new Location(
          typeof location.uri === "string" ? Uri.parse(location.uri) : location.uri,
          new Range(
            new Position(location.range.start.line, location.range.start.character),
            new Position(location.range.end.line, location.range.end.character)
          )
        )
      );
      return commands.executeCommand(
        "editor.action.showReferences",
        targetUri,
        targetPosition,
        targetLocations
      );
    })
  );

  const serverModule = path.resolve(
    context.extensionPath,
    "dist",
    "vexa.mjs"
  );

  const serverOptions = {
    run: {
      command: "node",
      args: [serverModule, "--lsp", "--stdio"],
      transport: TransportKind.stdio
    },
    debug: {
      command: "node",
      args: [serverModule, "--lsp", "--stdio"],
      transport: TransportKind.stdio
    }
  };

  const vexaConfig = workspace.getConfiguration("vexa");
  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "vexa" },
      { scheme: "file", pattern: "**/*.vx" }
    ],
    outputChannel,
    traceOutputChannel: outputChannel,
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.vx"),
      configurationSection: "vexa"
    },
    initializationOptions: {
      enableReferenceCodeLens: vexaConfig.get("referenceCodeLens.enabled", false)
    }
  };

  client = new LanguageClient(
    "vexa-lsp",
    "VexaScript Language Server",
    serverOptions,
    clientOptions
  );

  const ready = client.start();

  registerAutoAwaitGutterIcons(context, client, ready);
}

/**
 * Renders gutter icons on the lines that contain an `await` — explicit awaits in async/sync
 * functions and the implicit awaits the compiler inserts inside `sync` functions (similar to
 * Kotlin's suspend-call markers). The line list comes from the custom `vexa/autoAwaitDecorations`
 * LSP request.
 */
function registerAutoAwaitGutterIcons(context, client, ready) {
  const decorationType = window.createTextEditorDecorationType({
    gutterIconPath: path.join(context.extensionPath, "icons", "auto-await.svg"),
    gutterIconSize: "contain"
  });
  context.subscriptions.push(decorationType);

  let pending;
  const isVexaScript = (document) =>
    document && (document.languageId === "vexa" || document.uri.fsPath.endsWith(".vx"));

  async function updateEditor(editor) {
    if (!editor || !isVexaScript(editor.document)) {
      return;
    }
    try {
      const decorations = await client.sendRequest("vexa/autoAwaitDecorations", {
        textDocument: { uri: editor.document.uri.toString() }
      });
      const ranges = (decorations ?? []).map(
        (decoration) =>
          new Range(
            new Position(decoration.range.start.line, decoration.range.start.character),
            new Position(decoration.range.end.line, decoration.range.end.character)
          )
      );
      editor.setDecorations(decorationType, ranges);
    } catch {
      // The server may not be ready yet; the next document/editor change re-triggers the update.
    }
  }

  function scheduleUpdate(editor) {
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => updateEditor(editor), 150);
  }

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor((editor) => updateEditor(editor)),
    workspace.onDidChangeTextDocument((event) => {
      const editor = window.activeTextEditor;
      if (editor && event.document === editor.document) {
        scheduleUpdate(editor);
      }
    })
  );

  Promise.resolve(ready)
    .then(() => updateEditor(window.activeTextEditor))
    .catch(() => {
      /* server failed to start; nothing to decorate */
    });
}

function deactivate() {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

module.exports = {
  activate,
  deactivate
};
