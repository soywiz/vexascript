/**
 * Browser-compatible LSP server entry point.
 *
 * Differences from server.ts (the Node.js/stdio version):
 *   - Uses vscode-languageserver/browser transport (BrowserMessageReader/Writer)
 *     so the entire server runs inside a Web Worker.
 *   - Cross-file features are omitted (they depend on node:fs / node:path):
 *       • Auto-import code actions
 *       • Interface-implementation fixes
 *       • Cross-file definition / references / rename / hover
 *       • Workspace symbols
 *       • Workspace diagnostics
 *   - Single-file equivalents from navigation.ts are used instead.
 */

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DocumentDiagnosticReportKind,
  BrowserMessageReader,
  BrowserMessageWriter,
  type CodeAction,
  type Diagnostic,
  type TextEdit,
} from "vscode-languageserver/browser";
import { TextDocument as LspTextDocument } from "vscode-languageserver-textdocument";
import { CodeActionKind } from "./codeActionKinds";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "./formatting";
import { createDocumentDiagnosticReport } from "./diagnostics";
import { AnalysisSessionCache } from "./analysisSession";
import { createCallFixCodeActions } from "./callFixes";
import { createFunctionShorthandCodeActions } from "./functionShorthandFixes";
import { createCreateMemberCodeActions } from "./memberFixes";
import { createStringTemplateCodeActions } from "./stringTemplateFixes";
import { createTypeFixCodeActions } from "./typeFixes";
import { createThisCodeActions } from "./thisFixes";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems,
} from "./completion";
import { deferCodeActions, resolveDeferredCodeAction } from "./codeActions";
import {
  createDefinitionLocation,
  createHover,
  createPrepareRename,
  createRenameWorkspaceEdit,
  createReferences,
} from "./navigation";
import { createSignatureHelp } from "./signatureHelp";
import { createInlayHints } from "./inlayHints";
import { createDocumentSymbols } from "./symbols";
import {
  createSemanticTokens,
  MYLANG_SEMANTIC_TOKENS_LEGEND,
} from "./semanticTokens";
import {
  createDocumentHighlights,
  createFoldingRanges,
  createOnTypeFormattingEdits,
  createReferenceCodeLenses,
  createSelectionRanges,
  prepareCallHierarchy,
  createIncomingCalls,
  createOutgoingCalls,
} from "./documentFeatures";

export function startLspInWorker(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerScope = self as any;
  const reader = new BrowserMessageReader(workerScope);
  const writer = new BrowserMessageWriter(workerScope);
  const connection = createConnection(ProposedFeatures.all, reader, writer);

  const documents = new TextDocuments(LspTextDocument);
  const analysisSessions = new AnalysisSessionCache();

  function refreshDiagnostics(): void {
    connection.languages.diagnostics.refresh();
  }

  function candidateCharacters(character: number): number[] {
    const candidates = [character];
    if (character > 0) candidates.push(character - 1);
    candidates.push(character + 1);
    return candidates;
  }

  function completionPrefixAt(text: string, offset: number): string {
    let i = Math.max(0, Math.min(offset, text.length));
    while (i > 0) {
      const ch = text[i - 1] ?? "";
      if (!/[A-Za-z0-9_]/.test(ch)) break;
      i -= 1;
    }
    return text.slice(i, offset);
  }

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ["."],
      },
      codeActionProvider: { resolveProvider: true },
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
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: "\n",
        moreTriggerCharacter: ["}"],
      },
      hoverProvider: true,
      referencesProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","],
      },
      documentSymbolProvider: true,
      semanticTokensProvider: {
        legend: MYLANG_SEMANTIC_TOKENS_LEGEND,
        full: true,
        range: true,
      },
      inlayHintProvider: true,
      renameProvider: { prepareProvider: true },
    },
  }));

  documents.onDidOpen(() => refreshDiagnostics());
  documents.onDidChangeContent(() => refreshDiagnostics());
  documents.onDidClose((event) => {
    analysisSessions.delete(event.document.uri);
    refreshDiagnostics();
  });

  connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return createKeywordOnlyCompletionItems();
    const session = analysisSessions.getForDocument(doc);
    if (!session.ast) return createKeywordOnlyCompletionItems();
    const text = doc.getText();
    completionPrefixAt(text, doc.offsetAt(params.position));
    return createCompletionItemsForPosition(
      session.ast,
      params.position.line,
      params.position.character,
      session.analysis,
      [],
      { text, uri: doc.uri, sourceRoots: [], getSessionForFilePath: () => null }
    );
  });

  connection.onCodeAction(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = analysisSessions.getForDocument(doc);
    if (!session.ast) return [];

    const actions: CodeAction[] = [];

    const replacement = findDeclarationKeywordReplacementAtPosition(
      session.ast,
      params.range.start.line,
      params.range.start.character
    );
    if (replacement) {
      actions.push({
        title: `Replace '${replacement.from}' with '${replacement.to}'`,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [params.textDocument.uri]: [
              { range: replacement.range, newText: replacement.to },
            ],
          },
        },
      });
    }

    actions.push(
      ...createFunctionShorthandCodeActions({
        uri: params.textDocument.uri,
        ast: session.ast,
        text: doc.getText(),
        position: params.range.start,
      })
    );

    actions.push(
      ...createStringTemplateCodeActions({
        uri: params.textDocument.uri,
        ast: session.ast,
        text: doc.getText(),
        position: params.range.start,
      })
    );

    actions.push(
      ...createCallFixCodeActions({
        uri: params.textDocument.uri,
        text: doc.getText(),
        ast: session.ast,
        analysis: session.analysis,
        diagnostics: params.context.diagnostics,
      })
    );

    actions.push(
      ...createThisCodeActions({
        uri: params.textDocument.uri,
        ast: session.ast,
        analysis: session.analysis,
        position: params.range.start,
      })
    );

    actions.push(
      ...await createCreateMemberCodeActions({
        uri: params.textDocument.uri,
        ast: session.ast,
        analysis: session.analysis,
        diagnostics: params.context.diagnostics,
        sourceRoots: [],
        getSessionForFilePath: () => null,
      })
    );

    actions.push(
      ...await createTypeFixCodeActions({
        uri: params.textDocument.uri,
        ast: session.ast,
        analysis: session.analysis,
        diagnostics: params.context.diagnostics,
        sourceRoots: [],
        getSessionForFilePath: () => null,
        commandName: "",
      })
    );

    return deferCodeActions(actions);
  });

  connection.onCodeActionResolve((action) => resolveDeferredCodeAction(action));

  connection.onDocumentFormatting((params): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    return doc ? [createFullDocumentFormatEdit(doc.getText())] : [];
  });

  connection.onDocumentRangeFormatting((params): TextEdit[] => {
    const doc = documents.get(params.textDocument.uri);
    return doc ? [createRangeFormatEdit(doc.getText(), params.range)] : [];
  });

  function resolveDefinition(uri: string, line: number, character: number) {
    const doc = documents.get(uri);
    if (!doc) return null;
    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis) return null;
    return createDefinitionLocation(session.analysis, uri, line, character);
  }

  connection.onDefinition((p) =>
    resolveDefinition(p.textDocument.uri, p.position.line, p.position.character)
  );
  connection.onDeclaration((p) =>
    resolveDefinition(p.textDocument.uri, p.position.line, p.position.character)
  );
  connection.onTypeDefinition((p) =>
    resolveDefinition(p.textDocument.uri, p.position.line, p.position.character)
  );
  connection.onImplementation((p) =>
    resolveDefinition(p.textDocument.uri, p.position.line, p.position.character)
  );

  connection.onDocumentHighlight((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const analysis = analysisSessions.getForDocument(doc).analysis;
    return analysis
      ? createDocumentHighlights(
          analysis,
          params.position.line,
          params.position.character
        )
      : [];
  });

  connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis) return null;
    for (const character of candidateCharacters(params.position.character)) {
      const hover = createHover(
        session.analysis,
        params.position.line,
        character
      );
      if (hover) return hover;
    }
    return null;
  });

  connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const analysis = analysisSessions.getForDocument(doc).analysis;
    if (!analysis) return null;
    for (const character of candidateCharacters(params.position.character)) {
      const result = createPrepareRename(
        analysis,
        params.position.line,
        character
      );
      if (result) return result;
    }
    return null;
  });

  connection.onRenameRequest((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis) return null;
    for (const character of candidateCharacters(params.position.character)) {
      const edit = createRenameWorkspaceEdit(
        session.analysis,
        params.textDocument.uri,
        params.position.line,
        character,
        params.newName
      );
      if (edit) return edit;
    }
    return null;
  });

  connection.languages.diagnostics.on((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
      return { kind: DocumentDiagnosticReportKind.Full, items: [] as Diagnostic[] };
    const session = analysisSessions.getForDocument(doc);
    return createDocumentDiagnosticReport(
      session,
      doc.getText(),
      (offset) => doc.positionAt(offset),
      String(doc.version)
    );
  });

  connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis) return [];
    return createReferences(
      session.analysis,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      params.context.includeDeclaration
    );
  });

  connection.onSignatureHelp((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const session = analysisSessions.getForDocument(doc);
    if (!session.analysis || !session.ast) return null;
    return createSignatureHelp(
      session.ast,
      session.analysis,
      params.position.line,
      params.position.character,
      {
        uri: params.textDocument.uri,
        sourceRoots: [],
        getSessionForFilePath: () => null,
      }
    );
  });

  connection.onDocumentSymbol((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = analysisSessions.getForDocument(doc);
    return session.ast ? createDocumentSymbols(session.ast) : [];
  });

  connection.languages.inlayHint.on(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = analysisSessions.getForDocument(doc);
    if (!session.ast || !session.analysis) return [];
    return createInlayHints(session.ast, session.analysis, params.range, {
      uri: params.textDocument.uri,
      sourceRoots: [],
      getSessionForFilePath: () => null,
    });
  });

  connection.onCodeLens((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const session = analysisSessions.getForDocument(doc);
    return session.ast && session.analysis
      ? createReferenceCodeLenses(session.ast, session.analysis, doc.uri)
      : [];
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
    const ranges = analysis.getRenameRangesAt(
      params.position.line,
      params.position.character
    );
    return ranges.length > 1
      ? { ranges, wordPattern: "[A-Za-z_][A-Za-z0-9_]*" }
      : null;
  });

  connection.onDocumentOnTypeFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    return doc
      ? createOnTypeFormattingEdits(doc.getText(), params.position, params.ch)
      : [];
  });

  connection.onDidChangeConfiguration(() => refreshDiagnostics());

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
    if (!doc) return { data: [] };
    const session = analysisSessions.getForDocument(doc);
    return createSemanticTokens({
      text: doc.getText(),
      ast: session.ast,
      analysis: session.analysis,
    });
  });

  connection.languages.semanticTokens.onRange((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { data: [] };
    const session = analysisSessions.getForDocument(doc);
    return createSemanticTokens({
      text: doc.getText(),
      ast: session.ast,
      analysis: session.analysis,
      range: params.range,
    });
  });

  documents.listen(connection);
  connection.listen();
}
