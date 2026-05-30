import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type Diagnostic,
  DiagnosticSeverity,
  CodeActionKind,
  type TextEdit
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ListReader } from "compiler/utils/ListReader";
import { Program } from "compiler/ast/ast";
import { Parser } from "compiler/parser/parser";
import { TokenizeError, tokenize, type Token } from "compiler/parser/tokenizer";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";
import { createFullDocumentFormatEdit } from "./formatting";
import { Analysis } from "compiler/analysis/Analysis";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false
      },
      codeActionProvider: true,
      documentFormattingProvider: true
    }
  };
});

function validateDocument(doc: TextDocument): void {
  const text = doc.getText();
  const diagnostics: Diagnostic[] = [];

  try {
    const tokens = tokenize(text);
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();

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

    if (parser.errors.length === 0) {
      const analysis = new Analysis(ast);
      for (const issue of analysis.getIssues()) {
        const token = issue.node.firstToken;
        if (!token) {
          continue;
        }
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: {
            start: {
              line: token.range.start.line,
              character: token.range.start.column
            },
            end: {
              line: token.range.end.line,
              character: token.range.end.column
            }
          },
          message: issue.message,
          source: "mylang-sema"
        });
      }
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

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return createKeywordOnlyCompletionItems();
  }

  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    return createCompletionItemsForPosition(
      ast,
      params.position.line,
      params.position.character
    );
  } catch {
    return createKeywordOnlyCompletionItems();
  }
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  let ast: Program;
  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    ast = parser.parseFile();
  } catch {
    return [];
  }

  const replacement = findDeclarationKeywordReplacementAtPosition(
    ast,
    params.range.start.line,
    params.range.start.character
  );
  if (!replacement) {
    return [];
  }

  return [
    {
      title: `Replace '${replacement.from}' with '${replacement.to}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [params.textDocument.uri]: [
            {
              range: replacement.range,
              newText: replacement.to
            }
          ]
        }
      }
    }
  ];
});

connection.onDocumentFormatting((params): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  return [createFullDocumentFormatEdit(doc.getText())];
});

documents.listen(connection);
connection.listen();
