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
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "./formatting";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";
import { collectCrossFileTypeDiagnostics } from "./crossFileTypeDiagnostics";
import { AnalysisSessionCache } from "./analysisSession";
import { buildAutoImportSuggestions, createAutoImportCodeActions } from "./importFixes";
import { createCallFixCodeActions } from "./callFixes";
import { createCreateMemberCodeActions } from "./memberFixes";
import { createTypeFixCodeActions } from "./typeFixes";
import { createInterfaceImplementationCodeActions } from "./interfaceImplementationFixes";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";
import {
  resolveDefinitionAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import {
  createHover,
  createPrepareRename
} from "./navigation";
import { resolve as resolvePath } from "node:path";
import { createSignatureHelp } from "./signatureHelp";
import { createInlayHints } from "./inlayHints";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";
import {
  createSemanticTokens,
  MYLANG_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";
import { getProjectIndex, type ProjectIndex } from "./projectAnalysis";
import {
  createDocumentHighlights,
  createFoldingRanges,
  createOnTypeFormattingEdits,
  createReferenceCodeLenses,
  createSelectionRanges,
  prepareCallHierarchy,
  createIncomingCalls,
  createOutgoingCalls
} from "./documentFeatures";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const analysisSessions = new AnalysisSessionCache();
let sourceRoots: string[] = [];
let projectIndex: ProjectIndex = getProjectIndex([]);
const REFRESH_DIAGNOSTICS_COMMAND = "mylang.refreshDiagnostics";

function candidateCharacters(character: number): number[] {
  const candidates = [character];
  if (character > 0) {
    candidates.push(character - 1);
  }
  candidates.push(character + 1);
  return candidates;
}

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
  return projectIndex.getSessionForFilePath(resolvePath(filePath));
}

connection.onInitialize((params) => {
  sourceRoots = resolveSourceRoots(params);
  projectIndex = getProjectIndex(sourceRoots);
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
      executeCommandProvider: {
        commands: [REFRESH_DIAGNOSTICS_COMMAND]
      },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      definitionProvider: true,
      declarationProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      documentHighlightProvider: true,
      codeLensProvider: { resolveProvider: false },
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      linkedEditingRangeProvider: true,
      callHierarchyProvider: true,
      diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: "\n",
        moreTriggerCharacter: ["}"]
      },
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
      inlayHintProvider: true,
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
  const crossFileTypeDiagnostics = collectCrossFileTypeDiagnostics({
    uri: doc.uri,
    session,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
  diagnostics.push(...crossFileDiagnostics);
  diagnostics.push(...crossFileTypeDiagnostics);

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

function validateAllOpenDocuments(): void {
  for (const document of documents.all()) {
    validateDocument(document);
  }
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

documents.onDidOpen((event) => {
  const filePath = uriToFilePath(event.document.uri);
  if (filePath) {
    projectIndex.upsertOpenDocument(filePath, event.document.getText());
  }
  validateAllOpenDocuments();
});
documents.onDidChangeContent((event) => {
  const filePath = uriToFilePath(event.document.uri);
  if (filePath) {
    projectIndex.upsertOpenDocument(filePath, event.document.getText());
  }
  validateAllOpenDocuments();
});
documents.onDidClose((event) => {
  analysisSessions.delete(event.document.uri);
  const filePath = uriToFilePath(event.document.uri);
  if (filePath) {
    projectIndex.clearOpenDocument(filePath);
    projectIndex.invalidateFile(filePath);
  }
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  validateAllOpenDocuments();
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

  const createMemberActions = createCreateMemberCodeActions({
    uri: params.textDocument.uri,
    ast: session.ast,
    analysis: session.analysis,
    diagnostics: params.context.diagnostics,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
  actions.push(...createMemberActions);

  const typeFixActions = createTypeFixCodeActions({
    uri: params.textDocument.uri,
    ast: session.ast,
    analysis: session.analysis,
    diagnostics: params.context.diagnostics,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    commandName: REFRESH_DIAGNOSTICS_COMMAND
  });
  actions.push(...typeFixActions);

  const interfaceImplementationFixActions = createInterfaceImplementationCodeActions({
    uri: params.textDocument.uri,
    ast: session.ast,
    diagnostics: params.context.diagnostics,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
  actions.push(...interfaceImplementationFixActions);

  return deferCodeActions(actions);
});

connection.onCodeActionResolve((action) => {
  return resolveDeferredCodeAction(action);
});

connection.onExecuteCommand((params) => {
  if (params.command === REFRESH_DIAGNOSTICS_COMMAND) {
    validateAllOpenDocuments();
  }
});

connection.onDocumentFormatting((params): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  return [createFullDocumentFormatEdit(doc.getText())];
});

connection.onDocumentRangeFormatting((params): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  return [createRangeFormatEdit(doc.getText(), params.range)];
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

connection.onDeclaration((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));
connection.onTypeDefinition((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));
connection.onImplementation((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));

function resolveDefinition(uri: string, line: number, character: number) {
  const doc = documents.get(uri);
  if (!doc) return null;
  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) return null;
  return resolveDefinitionAcrossFiles({
    uri,
    line,
    character,
    session,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
}

connection.onDocumentHighlight((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const analysis = analysisSessions.getForDocument(doc).analysis;
  return analysis ? createDocumentHighlights(analysis, params.position.line, params.position.character) : [];
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return null;
  }

  for (const character of candidateCharacters(params.position.character)) {
    const memberHover = resolveMemberHoverAcrossFiles({
      uri: params.textDocument.uri,
      line: params.position.line,
      character,
      session,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    });
    if (memberHover) {
      return memberHover;
    }
  }

  for (const character of candidateCharacters(params.position.character)) {
    const hover = createHover(session.analysis, params.position.line, character);
    if (hover) {
      return hover;
    }
  }
  return null;
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

  for (const character of candidateCharacters(params.position.character)) {
    const result = createPrepareRename(analysis, params.position.line, character);
    if (result) {
      return result;
    }
  }
  return null;
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

  for (const character of candidateCharacters(params.position.character)) {
    const edit = resolveRenameAcrossFiles(
      {
        uri: params.textDocument.uri,
        line: params.position.line,
        character,
        session,
        sourceRoots,
        getSessionForFilePath: getSessionForFilePathFromOpenDocuments
      },
      params.newName
    );
    if (edit) {
      return edit;
    }
  }
  return null;
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
    params.position.character,
    {
      uri: params.textDocument.uri,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    }
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

connection.languages.inlayHint.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.ast || !session.analysis) {
    return [];
  }

  return createInlayHints(
    session.ast,
    session.analysis,
    params.range,
    {
      uri: params.textDocument.uri,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    }
  );
});

connection.onCodeLens((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const session = analysisSessions.getForDocument(doc);
  return session.ast && session.analysis ? createReferenceCodeLenses(session.ast, session.analysis, doc.uri) : [];
});

connection.onFoldingRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const ast = analysisSessions.getForDocument(doc).ast;
  return ast ? createFoldingRanges(ast) : [];
});

connection.onSelectionRanges((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const ast = analysisSessions.getForDocument(doc).ast;
  return ast ? createSelectionRanges(ast, params.positions) : [];
});

connection.languages.onLinkedEditingRange((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const analysis = analysisSessions.getForDocument(doc).analysis;
  if (!analysis) return null;
  const ranges = analysis.getRenameRangesAt(params.position.line, params.position.character);
  return ranges.length > 1 ? { ranges, wordPattern: "[A-Za-z_][A-Za-z0-9_]*" } : null;
});

connection.onDocumentOnTypeFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? createOnTypeFormattingEdits(doc.getText(), params.position, params.ch) : [];
});

connection.onDidChangeConfiguration(() => validateAllOpenDocuments());
connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    const filePath = uriToFilePath(change.uri);
    if (filePath) projectIndex.invalidateFile(filePath);
  }
  validateAllOpenDocuments();
});

connection.languages.callHierarchy.onPrepare((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const ast = analysisSessions.getForDocument(doc).ast;
  return ast ? prepareCallHierarchy(ast, doc.uri, params.position) : null;
});

connection.languages.callHierarchy.onIncomingCalls((params) => {
  const doc = documents.get(params.item.uri);
  if (!doc) return [];
  const ast = analysisSessions.getForDocument(doc).ast;
  return ast ? createIncomingCalls(ast, doc.uri, params.item) : [];
});

connection.languages.callHierarchy.onOutgoingCalls((params) => {
  const doc = documents.get(params.item.uri);
  if (!doc) return [];
  const ast = analysisSessions.getForDocument(doc).ast;
  return ast ? createOutgoingCalls(ast, doc.uri, params.item) : [];
});

connection.languages.diagnostics.onWorkspace(() => ({
  items: documents.all().map((doc) => {
    const session = analysisSessions.getForDocument(doc);
    return {
      kind: "full" as const,
      uri: doc.uri,
      version: doc.version,
      items: collectDiagnosticsFromSession(session, doc.getText(), (offset) => doc.positionAt(offset))
    };
  })
}));

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
