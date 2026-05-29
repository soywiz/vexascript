const path = require("node:path");
const { workspace } = require("vscode");
const {
  LanguageClient,
  TransportKind
} = require("vscode-languageclient/node");

/** @type {LanguageClient | undefined} */
let client;

function activate(context) {
  const serverModule = path.join(context.extensionPath, "..", "dist", "mylang.js");

  const serverOptions = {
    run: {
      command: "node",
      args: [serverModule, "--lsp"],
      transport: TransportKind.stdio
    },
    debug: {
      command: "node",
      args: [serverModule, "--lsp"],
      transport: TransportKind.stdio
    }
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "mylang" }],
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
