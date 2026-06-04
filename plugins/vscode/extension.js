const path = require("node:path");
const { commands, Location, Position, Range, Uri, workspace, window } = require("vscode");
const {
  LanguageClient,
  TransportKind
} = require("vscode-languageclient/node");

/** @type {LanguageClient | undefined} */
let client;

function activate(context) {
  const outputChannel = window.createOutputChannel("MyLang LSP");
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    commands.registerCommand("mylang.showReferences", (uri, position, locations) => {
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
    "..",
    "..",
    "dist",
    "mylang.js"
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

  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "mylang" },
      { scheme: "file", pattern: "**/*.my" }
    ],
    outputChannel,
    traceOutputChannel: outputChannel,
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.my")
    }
  };

  client = new LanguageClient(
    "mylang-lsp",
    "MyLang Language Server",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client.start());
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
