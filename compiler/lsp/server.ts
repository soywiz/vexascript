import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CodeActionKind,
  type TextEdit
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";
import { createFullDocumentFormatEdit } from "./formatting";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { AnalysisSessionCache } from "./analysisSession";
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
const analysisSessions = new AnalysisSessionCache();

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
  const session = analysisSessions.getForDocument(doc);
  const diagnostics = collectDiagnosticsFromSession(session, text, (offset) =>
    doc.positionAt(offset)
  );

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidOpen((event) => validateDocument(event.document));
documents.onDidChangeContent((event) => validateDocument(event.document));
documents.onDidClose((event) => {
  analysisSessions.delete(event.document.uri);
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return createKeywordOnlyCompletionItems();
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.ast) {
    return createKeywordOnlyCompletionItems();
  }
  return createCompletionItemsForPosition(
    session.ast,
    params.position.line,
    params.position.character
  );
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.ast) {
    return [];
  }

  const replacement = findDeclarationKeywordReplacementAtPosition(
    session.ast,
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

  const analysis = analysisSessions.getForDocument(doc).analysis;
  if (!analysis) {
    return null;
  }
  return createDefinitionLocation(
    analysis,
    params.textDocument.uri,
    params.position.line,
    params.position.character
  );
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const analysis = analysisSessions.getForDocument(doc).analysis;
  if (!analysis) {
    return null;
  }
  return createHover(analysis, params.position.line, params.position.character);
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const analysis = analysisSessions.getForDocument(doc).analysis;
  if (!analysis) {
    return null;
  }
  return createPrepareRename(analysis, params.position.line, params.position.character);
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const analysis = analysisSessions.getForDocument(doc).analysis;
  if (!analysis) {
    return null;
  }
  return createRenameWorkspaceEdit(
    analysis,
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    params.newName
  );
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  const analysis = analysisSessions.getForDocument(doc).analysis;
  if (!analysis) {
    return [];
  }
  return createReferences(
    analysis,
    params.textDocument.uri,
    params.position.line,
    params.position.character,
    params.context.includeDeclaration
  );
});

documents.listen(connection);
connection.listen();
