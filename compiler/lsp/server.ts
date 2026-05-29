import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type Diagnostic,
  DiagnosticSeverity,
  CompletionItemKind
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false
      }
    }
  };
});

function validateDocument(doc: TextDocument): void {
  const text = doc.getText();
  const diagnostics: Diagnostic[] = [];

  const anyIndex = text.indexOf("any");
  if (anyIndex >= 0) {
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: doc.positionAt(anyIndex),
        end: doc.positionAt(anyIndex + 3)
      },
      message: "MyLang: evita 'any' cuando puedas.",
      source: "mylang-ls"
    });
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidOpen((event) => validateDocument(event.document));
documents.onDidChangeContent((event) => validateDocument(event.document));

connection.onCompletion(() => {
  return [
    { label: "fn", kind: CompletionItemKind.Keyword, detail: "Keyword" },
    { label: "type", kind: CompletionItemKind.Keyword, detail: "Keyword" },
    { label: "interface", kind: CompletionItemKind.Keyword, detail: "Keyword" }
  ];
});

documents.listen(connection);
connection.listen();
