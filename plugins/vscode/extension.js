const path = require("node:path");
const { commands, languages, Location, Position, Range, Selection, Uri, workspace, window } = require("vscode");
const {
  LanguageClient,
  TransportKind
} = require("vscode-languageclient/node");

const SELECT_CODE_ACTION_RANGE_COMMAND = "vexa.selectCodeActionRange";
const {
  shouldRetriggerParameterHints,
  shouldRetriggerParameterHintsForSelectionChange,
  selectionStateFromEvent
} = require("./parameterHints.js");
const {
  shouldTriggerValueSuggestions,
  shouldKeepValueSuggestions,
  shouldTriggerMemberSuggestions
} = require("./suggestTrigger.js");
const {
  collectDeprecatedDiagnosticRanges
} = require("./deprecatedDecorations.js");

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

  context.subscriptions.push(
    commands.registerCommand(SELECT_CODE_ACTION_RANGE_COMMAND, async (uri, range) => {
      const editor = window.activeTextEditor;
      if (!editor || !range) {
        return;
      }
      const targetUri = typeof uri === "string" ? Uri.parse(uri) : uri;
      if (editor.document.uri.toString() !== targetUri.toString()) {
        return;
      }
      const selectionRange = new Range(
        new Position(range.start.line, range.start.character),
        new Position(range.end.line, range.end.character)
      );
      editor.selection = new Selection(selectionRange.start, selectionRange.end);
      editor.revealRange(selectionRange);
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
      enableReferenceCodeLens: vexaConfig.get("referenceCodeLens.enabled", false),
      enableInlayHintsParameters: vexaConfig.get("inlayHints.parameters", true),
      enableInlayHintsTypes: vexaConfig.get("inlayHints.types", true),
      enableLspTimings: vexaConfig.get("lsp.timings.enabled", false),
      enableLspTimingCacheEvents: vexaConfig.get("lsp.timings.cacheEvents.enabled", false)
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
  registerDeprecatedDiagnosticDecorations(context);
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
  let parameterHintsPending;
  let parameterHintsRetryPending;
  let parameterHintsArmed = false;
  let lastParameterHintsSelection;
  let valueSuggestionsPending;
  let valueSuggestionsRetryPending;
  let valueSuggestionsArmed = false;
  const isVexaScript = (document) =>
    document && (document.languageId === "vexa" || document.uri.fsPath.endsWith(".vx"));

  function scheduleParameterHints(editor, reason = "typing") {
    const selectionState = editor && editor.selection
      ? {
          line: editor.selection.active.line,
          character: editor.selection.active.character
        }
      : undefined;
    parameterHintsArmed = true;
    lastParameterHintsSelection = selectionState;
    if (parameterHintsPending) {
      clearTimeout(parameterHintsPending);
    }
    if (parameterHintsRetryPending) {
      clearTimeout(parameterHintsRetryPending);
    }
    parameterHintsPending = setTimeout(() => {
      parameterHintsPending = undefined;
      commands.executeCommand("editor.action.triggerParameterHints");
    }, 25);
    parameterHintsRetryPending = setTimeout(() => {
      parameterHintsRetryPending = undefined;
      commands.executeCommand("editor.action.triggerParameterHints");
    }, 90);
  }

  function scheduleValueSuggestions() {
    valueSuggestionsArmed = true;
    if (valueSuggestionsPending) {
      clearTimeout(valueSuggestionsPending);
    }
    if (valueSuggestionsRetryPending) {
      clearTimeout(valueSuggestionsRetryPending);
    }
    valueSuggestionsPending = setTimeout(() => {
      valueSuggestionsPending = undefined;
      commands.executeCommand("editor.action.triggerSuggest");
    }, 25);
    valueSuggestionsRetryPending = setTimeout(() => {
      valueSuggestionsRetryPending = undefined;
      commands.executeCommand("editor.action.triggerSuggest");
    }, 90);
  }

  function linePrefixAfterChange(document, change) {
    if (!change || !change.range || typeof change.text !== "string") {
      return undefined;
    }
    if (change.text.includes("\n") || change.text.includes("\r")) {
      return undefined;
    }
    const line = change.range.start.line;
    const character = change.range.start.character + change.text.length;
    if (line < 0 || line >= document.lineCount) {
      return undefined;
    }
    return document.lineAt(line).text.slice(0, character);
  }

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
        if (shouldRetriggerParameterHints(event.contentChanges)) {
          scheduleParameterHints(editor, "typing");
        }
        const linePrefix = linePrefixAfterChange(event.document, event.contentChanges[0]);
        if (shouldTriggerMemberSuggestions(
          event.contentChanges,
          linePrefix
        )) {
          scheduleValueSuggestions();
        } else if (shouldTriggerValueSuggestions(event.contentChanges)) {
          scheduleValueSuggestions();
        } else if (shouldKeepValueSuggestions(event.contentChanges, { valueSuggestionsArmed })) {
          scheduleValueSuggestions();
        }
      }
    }),
    window.onDidChangeTextEditorSelection((event) => {
      const editor = window.activeTextEditor;
      if (!editor || event.textEditor !== editor || !isVexaScript(editor.document)) {
        parameterHintsArmed = false;
        lastParameterHintsSelection = undefined;
        valueSuggestionsArmed = false;
        return;
      }
      const selectionState = selectionStateFromEvent(event);
      if (!selectionState) {
        parameterHintsArmed = false;
        lastParameterHintsSelection = undefined;
        valueSuggestionsArmed = false;
        return;
      }
      if (shouldRetriggerParameterHintsForSelectionChange(event, {
        parameterHintsArmed,
        lastSelection: lastParameterHintsSelection
      })) {
        scheduleParameterHints(editor, "selection");
        return;
      }
      if (lastParameterHintsSelection && selectionState.line !== lastParameterHintsSelection.line) {
        parameterHintsArmed = false;
      }
      if (lastParameterHintsSelection && selectionState.line !== lastParameterHintsSelection.line) {
        valueSuggestionsArmed = false;
      }
      lastParameterHintsSelection = selectionState;
    })
  );

  Promise.resolve(ready)
    .then(() => updateEditor(window.activeTextEditor))
    .catch(() => {
      /* server failed to start; nothing to decorate */
    });
}

function registerDeprecatedDiagnosticDecorations(context) {
  const decorationType = window.createTextEditorDecorationType({
    textDecoration: "line-through"
  });
  const isVexaScript = (document) =>
    document && (document.languageId === "vexa" || document.uri.fsPath.endsWith(".vx"));

  function applyDecorations(editor) {
    if (!editor || !isVexaScript(editor.document)) {
      return;
    }
    const ranges = collectDeprecatedDiagnosticRanges(
      editor.document.uri.toString(),
      languages.getDiagnostics(editor.document.uri)
    ).map((range) => new Range(
      new Position(range.start.line, range.start.character),
      new Position(range.end.line, range.end.character)
    ));
    editor.setDecorations(decorationType, ranges);
  }

  function refreshVisibleEditors() {
    for (const editor of window.visibleTextEditors) {
      applyDecorations(editor);
    }
  }

  context.subscriptions.push(
    decorationType,
    languages.onDidChangeDiagnostics((event) => {
      const changedUris = new Set(event.uris.map((uri) => uri.toString()));
      for (const editor of window.visibleTextEditors) {
        if (changedUris.has(editor.document.uri.toString())) {
          applyDecorations(editor);
        }
      }
    }),
    window.onDidChangeVisibleTextEditors(() => refreshVisibleEditors()),
    window.onDidChangeActiveTextEditor((editor) => applyDecorations(editor))
  );

  refreshVisibleEditors();
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
