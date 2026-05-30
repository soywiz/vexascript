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
import { collectDiagnostics } from "./diagnostics";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import {
  createDefinitionLocation,
  createHover,
  createPrepareRename,
  createReferences,
  createRenameWorkspaceEdit
} from "./navigation";

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
      documentFormattingProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true
      }
    }
  };
});

function validateDocument(doc: TextDocument): void {
  const text = doc.getText();
  const diagnostics = collectDiagnostics(text, (offset) => doc.positionAt(offset));

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

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    if (parser.errors.length > 0) {
      return null;
    }
    const analysis = new Analysis(ast);
    return createDefinitionLocation(
      analysis,
      params.textDocument.uri,
      params.position.line,
      params.position.character
    );
  } catch {
    return null;
  }
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    if (parser.errors.length > 0) {
      return null;
    }
    const analysis = new Analysis(ast);
    return createHover(analysis, params.position.line, params.position.character);
  } catch {
    return null;
  }
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    if (parser.errors.length > 0) {
      return null;
    }
    const analysis = new Analysis(ast);
    return createPrepareRename(analysis, params.position.line, params.position.character);
  } catch {
    return null;
  }
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    if (parser.errors.length > 0) {
      return null;
    }
    const analysis = new Analysis(ast);
    return createRenameWorkspaceEdit(
      analysis,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      params.newName
    );
  } catch {
    return null;
  }
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  try {
    const tokens = tokenize(doc.getText());
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();
    if (parser.errors.length > 0) {
      return [];
    }
    const analysis = new Analysis(ast);
    return createReferences(
      analysis,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      params.context.includeDeclaration
    );
  } catch {
    return [];
  }
});

documents.listen(connection);
connection.listen();
