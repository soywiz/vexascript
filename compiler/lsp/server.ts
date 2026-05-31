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
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";
import { AnalysisSessionCache } from "./analysisSession";
import { buildAutoImportSuggestions, createAutoImportCodeActions } from "./importFixes";
import { createCallFixCodeActions } from "./callFixes";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";
import {
  resolveDefinitionAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import {
  createHover,
  createPrepareRename
} from "./navigation";
import { resolve as resolvePath } from "node:path";
import { createSignatureHelp } from "./signatureHelp";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";
import {
  createSemanticTokens,
  MYLANG_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";

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

function getSessionForFilePathFromOpenDocuments(filePath: string) {
  const target = resolvePath(filePath);
  for (const document of documents.all()) {
    const documentPath = uriToFilePath(document.uri);
    if (!documentPath) {
      continue;
    }
    if (resolvePath(documentPath) === target) {
      return analysisSessions.getForDocument(document);
    }
  }
  return null;
}

connection.onInitialize((params) => {
  sourceRoots = resolveSourceRoots(params);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["."]
      },
      codeActionProvider: {
        resolveProvider: true
      },
      documentFormattingProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","]
      },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      semanticTokensProvider: {
        legend: MYLANG_SEMANTIC_TOKENS_LEGEND,
        full: true,
        range: true
      },
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
  const crossFileDiagnostics = collectCrossFileMemberDiagnostics({
    uri: doc.uri,
    session,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
  diagnostics.push(...crossFileDiagnostics);

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

function completionPrefixAt(text: string, offset: number): string {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i > 0) {
    const ch = text[i - 1] ?? "";
    if (!/[A-Za-z0-9_]/.test(ch)) {
      break;
    }
    i -= 1;
  }
  return text.slice(i, offset);
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
  const text = doc.getText();
  const prefix = completionPrefixAt(text, doc.offsetAt(params.position));
  const visibleSymbols = session.analysis?.getVisibleSymbolsAt(
    params.position.line,
    params.position.character
  ) ?? [];
  const autoImportSuggestions = buildAutoImportSuggestions({
    uri: doc.uri,
    ast: session.ast,
    sourceRoots,
    prefix,
    excludeSymbols: new Set(visibleSymbols.map((symbol) => symbol.name))
  });

  return createCompletionItemsForPosition(
    session.ast,
    params.position.line,
    params.position.character,
    session.analysis,
    autoImportSuggestions,
    {
      text,
      uri: doc.uri,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    }
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

  const callFixActions = createCallFixCodeActions({
    uri: params.textDocument.uri,
    text: doc.getText(),
    ast: session.ast,
    analysis: session.analysis,
    diagnostics: params.context.diagnostics
  });
  actions.push(...callFixActions);

  return deferCodeActions(actions);
});

connection.onCodeActionResolve((action) => {
  return resolveDeferredCodeAction(action);
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

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return null;
  }
  return resolveDefinitionAcrossFiles({
    uri: params.textDocument.uri,
    line: params.position.line,
    character: params.position.character,
    session,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
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

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return null;
  }
  return resolveRenameAcrossFiles(
    {
      uri: params.textDocument.uri,
      line: params.position.line,
      character: params.position.character,
      session,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    },
    params.newName
  );
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return [];
  }
  return resolveReferencesAcrossFiles(
    {
      uri: params.textDocument.uri,
      line: params.position.line,
      character: params.position.character,
      session,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    },
    params.context.includeDeclaration
  );
});

connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return null;
  }

  return createSignatureHelp(
    session.ast,
    session.analysis,
    params.position.line,
    params.position.character
  );
});

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.ast) {
    return [];
  }

  return createDocumentSymbols(session.ast);
});

connection.onWorkspaceSymbol((params) => {
  return createWorkspaceSymbols({
    sourceRoots,
    query: params.query ?? ""
  });
});

connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return { data: [] };
  }

  const session = analysisSessions.getForDocument(doc);
  return createSemanticTokens({
    text: doc.getText(),
    ast: session.ast,
    analysis: session.analysis
  });
});

connection.languages.semanticTokens.onRange((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return { data: [] };
  }

  const session = analysisSessions.getForDocument(doc);
  return createSemanticTokens({
    text: doc.getText(),
    ast: session.ast,
    analysis: session.analysis,
    range: params.range
  });
});

documents.listen(connection);
connection.listen();
