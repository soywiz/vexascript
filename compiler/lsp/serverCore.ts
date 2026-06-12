/**
 * Shared LSP request-handler core.
 *
 * Registers every document-lifecycle and request handler that the Node stdio
 * server (`server.ts`) and the browser Web Worker server (`server-browser.ts`)
 * have in common, so the two transports cannot drift apart. Environment
 * differences (workspace source roots, project index lookups, watched-file
 * invalidation, workspace-wide diagnostics/symbols) are injected through
 * {@link LspServerEnvironment}; cross-file feature collectors degrade to
 * single-file behavior when the environment provides no source roots.
 *
 * Protocol constants are inlined (same approach as `diagnostics.ts`) and
 * `vscode-languageserver` is only imported for types, so this module stays
 * loadable from both Node and browser bundles.
 */
import type {
  Connection,
  Diagnostic,
  InitializeParams,
  Range,
  TextDocuments,
  TextEdit
} from "vscode-languageserver/node.js";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ProjectSessionLike } from "compiler/analysis/projectIndex";
import { AnalysisSessionCache, createAnalysisSession } from "./analysisSession";
import { collectCodeActions } from "./codeActionsAggregate";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "./formatting";
import { createDocumentDiagnosticReport } from "./diagnostics";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";
import { collectCrossFileTypeDiagnostics } from "./crossFileTypeDiagnostics";
import { buildAutoImportSuggestions, uriToFilePath } from "./importFixes";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";
import {
  resolveDefinitionAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveImportPathHover,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles
} from "./crossFileNavigation";
import {
  createDefinitionLocation,
  createHover,
  createPrepareRename,
  createRenameWorkspaceEdit
} from "./navigation";
import { createSignatureHelp } from "./signatureHelp";
import { createInlayHints } from "./inlayHints";
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";
import { createDocumentSymbols, createWorkspaceSymbols } from "./symbols";
import {
  createSemanticTokens,
  VEXA_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";
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

// Inlined protocol constants so this module never needs runtime imports from
// the environment-specific vscode-languageserver entrypoints.
const TextDocumentSyncKind = { Incremental: 2 } as const;
const DocumentDiagnosticReportKind = { Full: "full" } as const;

export type GetSessionForFilePath = (
  filePath: string
) => ProjectSessionLike | null | Promise<ProjectSessionLike | null>;

/** Workspace-wide capabilities only available when a file-system workspace exists. */
export interface LspWorkspaceFeatures {
  /** Command id advertised via executeCommandProvider that re-publishes diagnostics. */
  refreshDiagnosticsCommand: string;
  /** Invalidates a changed/removed on-disk file in the workspace index. */
  onWatchedFileChanged: (filePath: string) => void;
}

export interface LspServerEnvironment {
  /** Workspace folders used by cross-file features; empty in browser workers. */
  getSourceRoots(): string[];
  /** Resolves the analysis session for a project file; `() => null` without a workspace. */
  getSessionForFilePath: GetSessionForFilePath;
  /** Called with the raw initialize params before capabilities are computed. */
  onInitialize?(params: InitializeParams): void;
  /** Keeps a workspace index in sync with the open editor documents. */
  onDocumentOpenedOrChanged?(document: TextDocument): void;
  onDocumentClosed?(document: TextDocument): void;
  /** Present when the environment supports workspace diagnostics/symbols (Node server). */
  workspace?: LspWorkspaceFeatures;
}

export function candidateCharacters(character: number): number[] {
  const candidates = [character];
  if (character > 0) {
    candidates.push(character - 1);
  }
  candidates.push(character + 1);
  return candidates;
}

export function completionPrefixAt(text: string, offset: number): string {
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

export interface LspServerOptions {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  analysisSessions: AnalysisSessionCache;
  environment: LspServerEnvironment;
}

export function startLspServer(options: LspServerOptions): void {
  const { connection, documents, analysisSessions, environment } = options;
  const workspace = environment.workspace;
  let inlayHintsEnabled = false;
  let referenceCodeLensEnabled = false;

  function refreshDiagnostics(): void {
    connection.languages.diagnostics.refresh();
  }

  function featureContext(uri: string) {
    return {
      uri,
      sourceRoots: environment.getSourceRoots(),
      getSessionForFilePath: environment.getSessionForFilePath
    };
  }

  async function collectWorkspaceDiagnosticsForDocument(doc: TextDocument): Promise<Diagnostic[]> {
    const session = analysisSessions.getForDocument(doc);
    const context = { ...featureContext(doc.uri), session };
    const [crossFileDiagnostics, crossFileTypeDiagnostics] = await Promise.all([
      collectCrossFileMemberDiagnostics(context),
      collectCrossFileTypeDiagnostics(context)
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

  connection.onInitialize((params) => {
    environment.onInitialize?.(params);
    referenceCodeLensEnabled = params.initializationOptions?.enableReferenceCodeLens === true;
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: [".", "@"]
        },
        codeActionProvider: {
          resolveProvider: true
        },
        ...(workspace
          ? { executeCommandProvider: { commands: [workspace.refreshDiagnosticsCommand] } }
          : {}),
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
        diagnosticProvider: {
          interFileDependencies: workspace !== undefined,
          workspaceDiagnostics: workspace !== undefined
        },
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
        ...(workspace ? { workspaceSymbolProvider: true } : {}),
        semanticTokensProvider: {
          legend: VEXA_SEMANTIC_TOKENS_LEGEND,
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

  documents.onDidOpen((event) => {
    environment.onDocumentOpenedOrChanged?.(event.document);
    refreshDiagnostics();
  });
  documents.onDidChangeContent((event) => {
    environment.onDocumentOpenedOrChanged?.(event.document);
    refreshDiagnostics();
  });
  documents.onDidClose((event) => {
    analysisSessions.delete(event.document.uri);
    environment.onDocumentClosed?.(event.document);
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
      sourceRoots: environment.getSourceRoots(),
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
        ...featureContext(doc.uri),
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
      ...featureContext(params.textDocument.uri),
      text: doc.getText(),
      ast: session.ast,
      analysis: session.analysis,
      range: params.range,
      diagnostics: params.context.diagnostics,
      ...(workspace ? { refreshDiagnosticsCommand: workspace.refreshDiagnosticsCommand } : {})
    });

    return deferCodeActions(actions);
  });

  connection.onCodeActionResolve((action) => {
    return resolveDeferredCodeAction(action);
  });

  if (workspace) {
    connection.onExecuteCommand((params) => {
      if (params.command === workspace.refreshDiagnosticsCommand) {
        refreshDiagnostics();
      }
    });
  }

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

  async function resolveDefinition(uri: string, line: number, character: number) {
    const doc = documents.get(uri);
    if (!doc) return null;
    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.analysis || !session.ast) return null;
    const localDefinition = createDefinitionLocation(session.analysis, uri, line, character, session.ast);
    if (localDefinition) {
      return localDefinition;
    }
    return await resolveDefinitionAcrossFiles({
      ...featureContext(uri),
      line,
      character,
      session
    });
  }

  connection.onDefinition((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));
  connection.onDeclaration((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));
  connection.onTypeDefinition((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));
  connection.onImplementation((params) => resolveDefinition(params.textDocument.uri, params.position.line, params.position.character));

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

    const session = await analysisSessions.getForDocumentAsync(doc);
    if (!session.analysis || !session.ast) {
      return null;
    }

    const importHover = await resolveImportPathHover({
      ...featureContext(params.textDocument.uri),
      line: params.position.line,
      character: params.position.character,
      session
    });
    if (importHover) {
      return importHover;
    }

    for (const character of candidateCharacters(params.position.character)) {
      const memberHover = await resolveMemberHoverAcrossFiles({
        ...featureContext(params.textDocument.uri),
        line: params.position.line,
        character,
        session
      });
      if (memberHover) {
        return memberHover;
      }
    }

    for (const character of candidateCharacters(params.position.character)) {
      const hover = createHover(session.analysis, params.position.line, character, session.ast);
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
      const result = createPrepareRename(analysis, params.position.line, character, analysisSessions.getForDocument(doc).ast ?? undefined);
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
          ...featureContext(params.textDocument.uri),
          line: params.position.line,
          character,
          session
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
        items: [] as Diagnostic[]
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

  if (workspace) {
    connection.languages.diagnostics.onWorkspace(async () => {
      const docs = documents.all();
      const items = await Promise.all(docs.map(async (doc) => ({
        kind: DocumentDiagnosticReportKind.Full,
        items: await collectWorkspaceDiagnosticsForDocument(doc),
        uri: doc.uri,
        version: doc.version,
        resultId: String(doc.version)
      })));

      return { items };
    });
  }

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
        ...featureContext(params.textDocument.uri),
        line: params.position.line,
        character: params.position.character,
        session
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
      featureContext(params.textDocument.uri)
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

  if (workspace) {
    connection.onWorkspaceSymbol((params) => {
      return createWorkspaceSymbols({
        sourceRoots: environment.getSourceRoots(),
        query: params.query ?? ""
      });
    });
  }

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
      featureContext(params.textDocument.uri)
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
  connection.onRequest("vexa/autoAwaitDecorations", (params: { textDocument: { uri: string }; range?: Range }) => {
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
    const session = analysisSessions.getForDocument(doc);
    const edit = session.analysis && session.ast
      ? createRenameWorkspaceEdit(session.analysis, doc.uri, params.position.line, params.position.character, "__linked__", session.ast)
      : null;
    const ranges = edit?.changes?.[doc.uri]?.map((entry) => entry.range) ?? [];
    return ranges.length > 1 ? { ranges, wordPattern: "[A-Za-z_][A-Za-z0-9_]*" } : null;
  });

  connection.onDocumentOnTypeFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    return doc ? createOnTypeFormattingEdits(doc.getText(), params.position, params.ch) : [];
  });

  connection.onDidChangeConfiguration(async () => {
    const config = await connection.workspace.getConfiguration("vexa");
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

  if (workspace) {
    connection.onDidChangeWatchedFiles((params) => {
      for (const change of params.changes) {
        const filePath = uriToFilePath(change.uri);
        if (filePath) workspace.onWatchedFileChanged(filePath);
      }
      refreshDiagnostics();
    });
  }

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
}
