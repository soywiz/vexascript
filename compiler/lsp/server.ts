import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CodeActionKind,
  type CodeAction,
  type InitializeParams,
  type TextEdit
} from "vscode-languageserver/node.js";
import { fileURLToPath } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";
import { createFullDocumentFormatEdit } from "./formatting";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { AnalysisSessionCache } from "./analysisSession";
import { createAutoImportCodeActions } from "./importFixes";
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
let sourceRoots: string[] = [];

function uriToFilePath(uri: string | null | undefined): string | null {
  if (!uri || !uri.startsWith("file://")) {
    return null;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function resolveSourceRoots(params: InitializeParams): string[] {
  const roots: string[] = [];
  for (const folder of params.workspaceFolders ?? []) {
    const path = uriToFilePath(folder.uri);
    if (path) {
      roots.push(path);
    }
  }

  if (roots.length === 0) {
    const rootUri = params.rootUri ?? undefined;
    const rootPath = rootUri ? uriToFilePath(rootUri) : params.rootPath ?? undefined;
    if (rootPath) {
      roots.push(rootPath);
    }
  }

  return roots;
}

connection.onInitialize((params) => {
  sourceRoots = resolveSourceRoots(params);
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
  const actions: CodeAction[] = [];

  if (replacement) {
    actions.push({
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
    });
  }

  const autoImportActions = createAutoImportCodeActions({
    uri: params.textDocument.uri,
    ast: session.ast,
    diagnostics: params.context.diagnostics,
    sourceRoots
  });
  actions.push(...autoImportActions);

  return actions;
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
