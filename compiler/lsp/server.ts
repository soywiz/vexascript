import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type Diagnostic,
  DiagnosticSeverity,
  CompletionItemKind
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ListReader } from "compiler/utils/ListReader";
import { Parser } from "compiler/parser/parser";
import { TokenizeError, tokenize, type Token } from "compiler/parser/tokenizer";

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

  try {
    const tokens = tokenize(text);
    const parser = new Parser(new ListReader<Token>(tokens));
    parser.parseFile();

    for (const issue of parser.errors) {
      const token = issue.token;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: token
          ? {
              start: {
                line: token.range.start.line,
                character: token.range.start.column
              },
              end: {
                line: token.range.end.line,
                character: token.range.end.column
              }
            }
          : {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 }
            },
        message: issue.message,
        source: "mylang-ls"
      });
    }
  } catch (error) {
    if (error instanceof TokenizeError) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: {
            line: error.range.start.line,
            character: error.range.start.column
          },
          end: {
            line: error.range.end.line,
            character: error.range.end.column
          }
        },
        message: error.message,
        source: "mylang-ls"
      });
    } else {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 }
        },
        message: error instanceof Error ? error.message : String(error),
        source: "mylang-ls"
      });
    }
  }

  const anyIndex = text.indexOf("any");
  if (anyIndex >= 0) {
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: doc.positionAt(anyIndex),
        end: doc.positionAt(anyIndex + 3)
      },
      message: "MyLang: avoid 'any' when possible.",
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
