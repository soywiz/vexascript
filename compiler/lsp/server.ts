import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DocumentDiagnosticReportKind,
  type Diagnostic,
  type InitializeParams,
  type Range,
  type TextEdit
} from "vscode-languageserver/node.js";
import { fileURLToPath } from "node:url";
import { TextDocument as LspTextDocument } from "vscode-languageserver-textdocument";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "./formatting";
import { createDocumentDiagnosticReport } from "./diagnostics";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";
import { collectCrossFileTypeDiagnostics } from "./crossFileTypeDiagnostics";
import { AnalysisSessionCache, createAnalysisSession } from "./analysisSession";
import { collectImportedSymbolTypes, collectImportedTypeDeclarations } from "./importedDeclarations";
import { ensureEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { buildAutoImportSuggestions } from "./importFixes";
import { collectCodeActions } from "./codeActionsAggregate";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";
import {
  resolveDefinitionAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveImportPathHover,
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
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";
import {
  createSemanticTokens,
  MYLANG_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";
import { getProjectIndex, type ProjectIndex } from "./projectAnalysis";
import { loadProject } from "compiler/project";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
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
const documents = new TextDocuments(LspTextDocument);
let sourceRoots: string[] = [];
let inlayHintsEnabled = false;
let referenceCodeLensEnabled = false;
let projectIndex: ProjectIndex = getProjectIndex([]);
const analysisSessions = new AnalysisSessionCache(async (document, baseSession) => {
  if (!baseSession.ast) {
    return { externalDeclarations: [], importedSymbolTypes: new Map(), ambientDeclarations: [] };
  }
  const context = {
    uri: document.uri,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  };
  const filePath = uriToFilePath(document.uri);
  const [externalDeclarations, importedSymbolTypes, ambientDeclarations] = await Promise.all([
    collectImportedTypeDeclarations(baseSession.ast, context),
    collectImportedSymbolTypes(baseSession.ast, context),
    (async () => {
      if (!filePath) {
        return [];
      }
      const project = await loadProject(filePath);
      const requested = new Set((project?.libs ?? []).map((lib) => lib.toLowerCase()));
      if (!requested.has("dom")) {
        return [];
      }
      return (await ensureDomProgram()).body;
    })()
  ]);
  return { externalDeclarations, importedSymbolTypes, ambientDeclarations };
}, () => refreshDiagnostics());
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

async function getSessionForFilePathFromOpenDocuments(filePath: string) {
  return projectIndex.getSessionForFilePath(resolvePath(filePath));
}

async function collectWorkspaceDiagnosticsForDocument(doc: LspTextDocument): Promise<Diagnostic[]> {
  const session = analysisSessions.getForDocument(doc);
  const [crossFileDiagnostics, crossFileTypeDiagnostics] = await Promise.all([
    collectCrossFileMemberDiagnostics({
      uri: doc.uri,
      session,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    }),
    collectCrossFileTypeDiagnostics({
      uri: doc.uri,
      session,
      sourceRoots,
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments
    })
  ]);
  const sameFileKeys = new Set(
    session.semanticIssues.map((issue) => {
      const token = issue.node.firstToken;
      if (!token) {
        return issue.message;
      }
      return `${token.range.start.line}:${token.range.start.column}:${issue.message}`;
    })
  );
  return [...crossFileDiagnostics, ...crossFileTypeDiagnostics].filter((diagnostic) => {
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
    return !sameFileKeys.has(key);
  });
}

// Ensure runtime is loaded on server start (non-blocking background load)
ensureEcmaScriptRuntimeProgram().catch(() => undefined);

connection.onInitialize((params) => {
  sourceRoots = resolveSourceRoots(params);
  projectIndex = getProjectIndex(sourceRoots);
  referenceCodeLensEnabled = params.initializationOptions?.enableReferenceCodeLens === true;
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
      ...(referenceCodeLensEnabled ? { codeLensProvider: { resolveProvider: false } } : {}),
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
      ...(inlayHintsEnabled ? { inlayHintProvider: true } : {}),
      renameProvider: {
        prepareProvider: true
      }
    }
  };
});

function refreshDiagnostics(): void {
  connection.languages.diagnostics.refresh();
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
    projectIndex.upsertOpenDocument(filePath, event.document.getText()).catch(() => undefined);
  }
  refreshDiagnostics();
});
documents.onDidChangeContent((event) => {
  const filePath = uriToFilePath(event.document.uri);
  if (filePath) {
    projectIndex.upsertOpenDocument(filePath, event.document.getText()).catch(() => undefined);
  }
  refreshDiagnostics();
});
documents.onDidClose((event) => {
  analysisSessions.delete(event.document.uri);
  const filePath = uriToFilePath(event.document.uri);
  if (filePath) {
    projectIndex.clearOpenDocument(filePath);
    projectIndex.invalidateFile(filePath);
  }
  refreshDiagnostics();
});

connection.onCompletion(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return createKeywordOnlyCompletionItems();
  }

  const session = await analysisSessions.getForDocumentAsync(doc);
  if (!session.ast) {
    return createKeywordOnlyCompletionItems();
  }
  const text = doc.getText();
  const prefix = completionPrefixAt(text, doc.offsetAt(params.position));
  const visibleSymbols = session.analysis?.getVisibleSymbolsAt(
    params.position.line,
    params.position.character
  ) ?? [];
  const autoImportSuggestions = await buildAutoImportSuggestions({
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
      getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
      recoverAnalysisSession: (source) => createAnalysisSession(
        source,
        session.externalDeclarations,
        session.importedSymbolTypes,
        session.ambientDeclarations
      )
    }
  );
});

connection.onCodeAction(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.ast) {
    return [];
  }

  const actions = await collectCodeActions({
    uri: params.textDocument.uri,
    text: doc.getText(),
    ast: session.ast,
    analysis: session.analysis,
    range: params.range,
    diagnostics: params.context.diagnostics,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    refreshDiagnosticsCommand: REFRESH_DIAGNOSTICS_COMMAND
  });

  return deferCodeActions(actions);
});

connection.onCodeActionResolve((action) => {
  return resolveDeferredCodeAction(action);
});

connection.onExecuteCommand((params) => {
  if (params.command === REFRESH_DIAGNOSTICS_COMMAND) {
    refreshDiagnostics();
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

connection.onHover(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return null;
  }

  const importHover = resolveImportPathHover({
    uri: params.textDocument.uri,
    line: params.position.line,
    character: params.position.character,
    session,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments
  });
  if (importHover) {
    return importHover;
  }

  for (const character of candidateCharacters(params.position.character)) {
    const memberHover = await resolveMemberHoverAcrossFiles({
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

connection.onRenameRequest(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }

  const session = analysisSessions.getForDocument(doc);
  if (!session.analysis || !session.ast) {
    return null;
  }

  for (const character of candidateCharacters(params.position.character)) {
    const edit = await resolveRenameAcrossFiles(
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

connection.languages.diagnostics.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: []
    };
  }

  const session = analysisSessions.getForDocument(doc);
  return createDocumentDiagnosticReport(
    session,
    doc.getText(),
    (offset) => doc.positionAt(offset),
    String(doc.version)
  );
});

connection.languages.diagnostics.onWorkspace(async () => {
  const docs = documents.all();
  const items = await Promise.all(docs.map(async (doc) => ({
    kind: DocumentDiagnosticReportKind.Full as typeof DocumentDiagnosticReportKind.Full,
    items: await collectWorkspaceDiagnosticsForDocument(doc),
    uri: doc.uri,
    version: doc.version,
    resultId: String(doc.version)
  })));

  return { items };
});

connection.onReferences(async (params) => {
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

connection.onSignatureHelp(async (params) => {
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

connection.languages.inlayHint.on(async (params) => {
  if (!inlayHintsEnabled) return [];

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
  if (!referenceCodeLensEnabled) return [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const session = analysisSessions.getForDocument(doc);
  return session.ast && session.analysis ? createReferenceCodeLenses(session.ast, session.analysis, doc.uri) : [];
});

// Custom request: the editor asks for the lines that receive an implicit `await` so it can render
// gutter icons (similar to Kotlin's suspend-call markers). Not part of the standard LSP protocol.
connection.onRequest("mylang/autoAwaitDecorations", (params: { textDocument: { uri: string }; range?: Range }) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const session = analysisSessions.getForDocument(doc);
  if (!session.ast || !session.analysis) return [];
  return createAutoAwaitDecorations(session.ast, session.analysis, params.range);
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

connection.onDidChangeConfiguration(async () => {
  const config = await connection.workspace.getConfiguration("mylang");
  const newEnabled = config?.inlayHints?.enabled === true;
  if (newEnabled !== inlayHintsEnabled) {
    inlayHintsEnabled = newEnabled;
    connection.languages.inlayHint.refresh();
  }
  const newCodeLensEnabled = config?.referenceCodeLens?.enabled === true;
  if (newCodeLensEnabled !== referenceCodeLensEnabled) {
    referenceCodeLensEnabled = newCodeLensEnabled;
    connection.sendRequest("workspace/codeLens/refresh");
  }
  refreshDiagnostics();
});
connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    const filePath = uriToFilePath(change.uri);
    if (filePath) projectIndex.invalidateFile(filePath);
  }
  refreshDiagnostics();
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
