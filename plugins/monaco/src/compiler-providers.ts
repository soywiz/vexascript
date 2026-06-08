import * as monaco from "monaco-editor";
import { createAnalysisSession, type AnalysisSession } from "compiler/lsp/analysisSession";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems,
} from "compiler/lsp/completion";
import { collectDiagnosticsFromSession } from "compiler/lsp/diagnostics";
import { collectCodeActions } from "compiler/lsp/codeActionsAggregate";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver/node.js";
import {
  createDocumentHighlights,
  createFoldingRanges,
  createOnTypeFormattingEdits,
  createReferenceCodeLenses,
  createSelectionRanges,
} from "compiler/lsp/documentFeatures";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "compiler/lsp/formatting";
import { createInlayHints } from "compiler/lsp/inlayHints";
import { createAutoAwaitDecorations } from "compiler/lsp/autoAwaitDecorations";
import {
  createHover,
  createPrepareRename,
} from "compiler/lsp/navigation";
import {
  resolveDefinitionAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveRenameAcrossFiles,
} from "compiler/lsp/crossFileNavigation";
import { createSemanticTokens, MYLANG_SEMANTIC_TOKENS_LEGEND } from "compiler/lsp/semanticTokens";
import { createSignatureHelp } from "compiler/lsp/signatureHelp";
import { createDocumentSymbols } from "compiler/lsp/symbols";
import { extractShowReferencesPayload } from "./codeLensCommands";

const LANG_ID = "mylang";

interface SessionState {
  version: number;
  session: AnalysisSession;
}

/**
 * Build the resolver context shared by the cross-file navigation, hover,
 * completion and code-action helpers. The Monaco static demo is single-file,
 * so there is no other session to resolve into; the helpers gracefully fall
 * back to in-file results.
 */
function resolverContext(model: monaco.editor.ITextModel): {
  uri: string;
  sourceRoots: string[];
  getSessionForFilePath: () => null;
} {
  return {
    uri: model.uri.toString(),
    sourceRoots: [],
    getSessionForFilePath: () => null,
  };
}

const CIK = monaco.languages.CompletionItemKind;
const LSP_CIK: Record<number, monaco.languages.CompletionItemKind> = {
  1: CIK.Text,
  2: CIK.Method,
  3: CIK.Function,
  4: CIK.Constructor,
  5: CIK.Field,
  6: CIK.Variable,
  7: CIK.Class,
  8: CIK.Interface,
  9: CIK.Module,
  10: CIK.Property,
  13: CIK.Enum,
  14: CIK.Keyword,
  20: CIK.EnumMember,
  24: CIK.Operator,
  25: CIK.TypeParameter,
};

const SK = monaco.languages.SymbolKind;
const LSP_SK: Record<number, monaco.languages.SymbolKind> = {
  5: SK.Class,
  6: SK.Method,
  7: SK.Property,
  8: SK.Field,
  10: SK.Enum,
  11: SK.Interface,
  12: SK.Function,
  13: SK.Variable,
  22: SK.EnumMember,
};

function getSession(model: monaco.editor.ITextModel, cache: Map<string, SessionState>): AnalysisSession {
  const uri = model.uri.toString();
  const version = model.getVersionId();
  const cached = cache.get(uri);
  if (cached && cached.version === version) {
    return cached.session;
  }
  const session = createAnalysisSession(model.getValue());
  cache.set(uri, { version, session });
  return session;
}

function toMonacoPos(position: { line: number; character: number }): monaco.IPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

function toLspPos(position: monaco.IPosition): { line: number; character: number } {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function toLspRange(range: monaco.IRange) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

function lspEditToMonaco(edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string; }): monaco.languages.TextEdit {
  return { range: toMonacoRange(edit.range), text: edit.newText };
}

function workspaceEditToMonaco(edit: {
  changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>;
}): monaco.languages.WorkspaceEdit {
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, uriEdits] of Object.entries(edit.changes ?? {})) {
    const resource = monaco.Uri.parse(uri);
    for (const uriEdit of uriEdits) {
      edits.push({ resource, textEdit: lspEditToMonaco(uriEdit), versionId: undefined });
    }
  }
  return { edits };
}

function completionEditRange(
  textEdit: unknown,
  fallbackRange: monaco.IRange
): monaco.IRange {
  if (!textEdit || typeof textEdit !== "object") {
    return fallbackRange;
  }
  if ("range" in textEdit) {
    return toMonacoRange((textEdit as {
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }).range);
  }
  if ("insert" in textEdit) {
    return toMonacoRange((textEdit as {
      insert: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }).insert);
  }
  return fallbackRange;
}

function normalizePrepareRenameResult(
  prepared: unknown
): { range: monaco.IRange; text: string } | null {
  if (!prepared || typeof prepared !== "object") {
    return null;
  }
  if ("placeholder" in prepared && "range" in prepared) {
    const value = prepared as {
      placeholder: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    };
    return { range: toMonacoRange(value.range), text: value.placeholder };
  }
  if ("start" in prepared && "end" in prepared) {
    return {
      range: toMonacoRange(prepared as {
        start: { line: number; character: number };
        end: { line: number; character: number };
      }),
      text: "",
    };
  }
  return null;
}

function mapSeverity(severity?: number): monaco.MarkerSeverity {
  if (severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  if (severity === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

function toMarkdown(value: unknown): monaco.IMarkdownString | string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { value };
  if (typeof value === "object" && "kind" in (value as Record<string, unknown>) && "value" in (value as Record<string, unknown>)) {
    const content = value as { kind?: string; value: string };
    return content.kind === "markdown" ? { value: content.value, isTrusted: false } : content.value;
  }
  return undefined;
}

/**
 * Normalise an LSP hover `contents` payload into Monaco `IMarkdownString[]`.
 * Monaco only renders `IMarkdownString` objects, so plain strings and
 * plaintext / MarkedString entries (used by our type signatures) are wrapped in
 * a fenced code block to render as monospaced text.
 */
function hoverContentsToMarkdown(contents: unknown): monaco.IMarkdownString[] {
  const entries = Array.isArray(contents) ? contents : [contents];
  const result: monaco.IMarkdownString[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (typeof entry === "string") {
      result.push({ value: "```mylang\n" + entry + "\n```" });
      continue;
    }
    if (typeof entry === "object") {
      const record = entry as { kind?: string; language?: string; value?: string };
      if (typeof record.value !== "string") continue;
      if (record.kind === "markdown") {
        result.push({ value: record.value, isTrusted: false });
      } else {
        // plaintext MarkupContent or { language, value } MarkedString.
        const lang = record.language ?? "mylang";
        result.push({ value: "```" + lang + "\n" + record.value + "\n```" });
      }
    }
  }
  return result;
}

function mapCodeLensCommand(command?: {
  title: string;
  command: string;
  arguments?: unknown[];
}): monaco.languages.Command | undefined {
  if (!command) return undefined;
  const references = extractShowReferencesPayload(command);
  if (!references) {
    return { id: command.command, title: command.title, command: command.command, arguments: command.arguments };
  }
  return {
    id: "editor.action.showReferences",
    title: command.title,
    command: "editor.action.showReferences",
    arguments: [
      monaco.Uri.parse(references.uri),
      toMonacoPos(references.position),
      references.locations.map((location) => ({
        uri: monaco.Uri.parse(location.uri),
        range: toMonacoRange(location.range),
      })),
    ],
  };
}

export function registerLanguage(): void {
  monaco.languages.register({
    id: LANG_ID,
    extensions: [".my"],
    aliases: ["MyLang", "mylang"],
    mimetypes: ["text/x-mylang"],
  });

  monaco.languages.setMonarchTokensProvider(LANG_ID, {
    defaultToken: "",
    keywords: [
      "declare", "namespace", "enum", "import", "from", "as", "export",
      "class", "interface", "infer", "extends", "implements", "override",
      "async", "yield", "fun", "function", "keyof", "let", "var", "val",
      "const", "if", "else", "return", "throw", "while", "for", "in",
      "switch", "case", "default", "break", "continue", "do", "try",
      "catch", "finally", "new", "is", "instanceof", "typeof", "void",
      "delete", "await", "readonly", "type", "fn", "true", "false",
      "null", "undefined",
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@block_comment" }],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[nNL])?\b/, "number.float"],
        [/[A-Za-z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[{}()\[\]]/, "delimiter"],
        [/[;,.]/, "delimiter"],
        [/[+\-*/%&|^~<>!=?:]+/, "operator"],
      ],
      block_comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[/*]/, "comment"],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  monaco.languages.setLanguageConfiguration(LANG_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"", notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern: /^.*(\{[^}"']*|->)\s*$/,
      decreaseIndentPattern: /^\s*\}/,
    },
    onEnterRules: [
      {
        // Brace/tail lambda arrow with an auto-closed `}` (and trailing
        // call parens) right after the cursor: split onto an indented line
        // and push the closing bracket(s) down.
        beforeText: /->\s*$/,
        afterText: /^\s*[)\]}]/,
        action: { indentAction: monaco.languages.IndentAction.IndentOutdent },
      },
      {
        // Lambda arrow at end of line with nothing after: just indent.
        beforeText: /->\s*$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
  });
}

export function setModelDiagnostics(model: monaco.editor.ITextModel, markers: Array<{
  severity?: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  code?: string | number;
  source?: string;
}>): void {
  monaco.editor.setModelMarkers(
    model,
    "mylang",
    markers.map((marker) => ({
      severity: mapSeverity(marker.severity),
      startLineNumber: marker.range.start.line + 1,
      startColumn: marker.range.start.character + 1,
      endLineNumber: marker.range.end.line + 1,
      endColumn: marker.range.end.character + 1,
      message: marker.message,
      code: String(marker.code ?? ""),
      source: marker.source ?? "mylang",
    }))
  );
}

export function pullDiagnostics(model: monaco.editor.ITextModel, cache: Map<string, SessionState>): void {
  const session = getSession(model, cache);
  const diagnostics = collectDiagnosticsFromSession(
    session,
    model.getValue(),
    (offset) => {
      const position = model.getPositionAt(offset);
      return { line: position.lineNumber - 1, character: position.column - 1 };
    }
  );
  setModelDiagnostics(model, diagnostics);
}

const autoAwaitGlyphCollections = new WeakMap<
  monaco.editor.ICodeEditor,
  monaco.editor.IEditorDecorationsCollection
>();

/**
 * Renders glyph-margin icons on the lines where the compiler inserts an implicit `await` inside a
 * `sync` function body (similar to Kotlin's suspend-call gutter markers). Safe to call repeatedly;
 * the decorations are reconciled through a per-editor decorations collection.
 */
export function updateAutoAwaitGlyphs(
  editor: monaco.editor.ICodeEditor,
  cache: Map<string, SessionState>
): void {
  let collection = autoAwaitGlyphCollections.get(editor);
  if (!collection) {
    collection = editor.createDecorationsCollection();
    autoAwaitGlyphCollections.set(editor, collection);
  }

  const model = editor.getModel();
  if (!model) {
    collection.clear();
    return;
  }

  const session = getSession(model, cache);
  if (!session.ast || !session.analysis) {
    collection.clear();
    return;
  }

  const decorations = createAutoAwaitDecorations(session.ast, session.analysis).map((decoration) => ({
    range: toMonacoRange(decoration.range),
    options: {
      glyphMarginClassName: "mylang-auto-await-glyph",
      glyphMarginHoverMessage: { value: decoration.message },
    },
  }));
  collection.set(decorations);
}

export function registerProviders(): Map<string, SessionState> {
  const cache = new Map<string, SessionState>();

  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const session = getSession(model, cache);
      const word = model.getWordUntilPosition(position);
      if (!session.ast || !session.analysis) {
        const keywordItems = createKeywordOnlyCompletionItems();
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          suggestions: keywordItems.map((item) => ({
            label: item.label,
            kind: LSP_CIK[item.kind ?? 0] ?? CIK.Text,
            insertText: item.insertText ?? item.label,
            range,
          })),
        };
      }
      const items = await createCompletionItemsForPosition(
        session.ast,
        position.lineNumber - 1,
        position.column - 1,
        session.analysis,
        [],
        { text: model.getValue(), ...resolverContext(model) }
      );
      const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: items.map((item) => ({
          label: item.label,
          kind: LSP_CIK[item.kind ?? 0] ?? CIK.Text,
          detail: item.detail,
          documentation: toMarkdown(item.documentation),
          sortText: item.sortText,
          filterText: item.filterText,
          insertText: item.insertText ?? item.label,
          insertTextRules: item.insertTextFormat === 2
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          range: completionEditRange(item.textEdit, defaultRange),
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(LANG_ID, {
    async provideHover(model, position) {
      const session = getSession(model, cache);
      if (!session.analysis || !session.ast) return null;
      const line = position.lineNumber - 1;
      const character = position.column - 1;
      // Member hover may probe the (stubbed) file system in the browser; guard
      // it and fall back to the in-file hover.
      let memberHover = null;
      try {
        memberHover = await resolveMemberHoverAcrossFiles({ line, character, session, ...resolverContext(model) });
      } catch {
        memberHover = null;
      }
      const hover = memberHover ?? createHover(session.analysis, line, character);
      if (!hover) return null;
      return {
        contents: hoverContentsToMarkdown(hover.contents),
        range: hover.range ? toMonacoRange(hover.range) : undefined,
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(LANG_ID, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position) {
      const session = getSession(model, cache);
      if (!session.ast || !session.analysis) return null;
      const help = await createSignatureHelp(
        session.ast,
        session.analysis,
        position.lineNumber - 1,
        position.column - 1,
        resolverContext(model)
      );
      if (!help) return null;
      return {
        value: {
          signatures: help.signatures.map((signature) => ({
            label: signature.label,
            documentation: toMarkdown(signature.documentation),
            parameters: (signature.parameters ?? []).map((parameter) => ({
              label: parameter.label,
              documentation: toMarkdown(parameter.documentation),
            })),
          })),
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });

  const resolveDefinition = async (
    model: monaco.editor.ITextModel,
    position: monaco.IPosition
  ): Promise<monaco.languages.Definition> => {
    const session = getSession(model, cache);
    if (!session.analysis || !session.ast) return [];
    let location = null;
    try {
      location = await resolveDefinitionAcrossFiles({
        line: position.lineNumber - 1,
        character: position.column - 1,
        session,
        ...resolverContext(model),
      });
    } catch {
      location = null;
    }
    return location ? [{ uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) }] : [];
  };

  // VS Code's LSP server answers definition, declaration, type definition and
  // implementation with the same cross-file resolver; mirror that here.
  monaco.languages.registerDefinitionProvider(LANG_ID, {
    provideDefinition: resolveDefinition,
  });
  monaco.languages.registerDeclarationProvider(LANG_ID, {
    provideDeclaration: resolveDefinition,
  });
  monaco.languages.registerTypeDefinitionProvider(LANG_ID, {
    provideTypeDefinition: resolveDefinition,
  });
  monaco.languages.registerImplementationProvider(LANG_ID, {
    provideImplementation: resolveDefinition,
  });

  monaco.languages.registerReferenceProvider(LANG_ID, {
    async provideReferences(model, position, context) {
      const session = getSession(model, cache);
      if (!session.analysis || !session.ast) return [];
      let locations: Awaited<ReturnType<typeof resolveReferencesAcrossFiles>> = [];
      try {
        locations = await resolveReferencesAcrossFiles(
          {
            line: position.lineNumber - 1,
            character: position.column - 1,
            session,
            ...resolverContext(model),
          },
          context.includeDeclaration
        );
      } catch {
        locations = [];
      }
      return locations.map((location) => ({ uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) }));
    },
  });

  monaco.languages.registerDocumentHighlightProvider(LANG_ID, {
    provideDocumentHighlights(model, position) {
      const session = getSession(model, cache);
      if (!session.analysis) return [];
      return createDocumentHighlights(session.analysis, position.lineNumber - 1, position.column - 1).map((highlight) => ({
        range: toMonacoRange(highlight.range),
        kind: highlight.kind === 2
          ? monaco.languages.DocumentHighlightKind.Write
          : monaco.languages.DocumentHighlightKind.Read,
      }));
    },
  });

  monaco.languages.registerRenameProvider(LANG_ID, {
    resolveRenameLocation(model, position) {
      const reject: monaco.languages.RenameLocation & { rejectReason: string } = {
        range: new monaco.Range(1, 1, 1, 1),
        text: "",
        rejectReason: "Cannot rename this symbol",
      };
      const session = getSession(model, cache);
      if (!session.analysis) return reject;
      const prepared = createPrepareRename(session.analysis, position.lineNumber - 1, position.column - 1);
      return normalizePrepareRenameResult(prepared) ?? reject;
    },
    async provideRenameEdits(model, position, newName) {
      const session = getSession(model, cache);
      if (!session.analysis || !session.ast) return { edits: [] };
      let edit = null;
      try {
        edit = await resolveRenameAcrossFiles(
          {
            line: position.lineNumber - 1,
            character: position.column - 1,
            session,
            ...resolverContext(model),
          },
          newName
        );
      } catch {
        edit = null;
      }
      if (!edit) return { edits: [] };
      return workspaceEditToMonaco(edit);
    },
  });

  monaco.languages.registerLinkedEditingRangeProvider(LANG_ID, {
    provideLinkedEditingRanges(model, position) {
      const session = getSession(model, cache);
      if (!session.analysis) return null;
      const ranges = session.analysis.getRenameRangesAt(position.lineNumber - 1, position.column - 1);
      if (ranges.length <= 1) return null;
      return {
        ranges: ranges.map(toMonacoRange),
        wordPattern: /[A-Za-z_][A-Za-z0-9_]*/,
      };
    },
  });

  monaco.languages.registerCodeActionProvider(LANG_ID, {
    async provideCodeActions(model, range, context) {
      const session = getSession(model, cache);
      if (!session.ast) return { actions: [], dispose: () => {} };
      const diagnostics: Diagnostic[] = context.markers.map((marker) => {
        const rawCode = marker.code;
        const code = typeof rawCode === "object" && rawCode !== null ? rawCode.value : rawCode;
        return {
          range: toLspRange({
            startLineNumber: marker.startLineNumber,
            startColumn: marker.startColumn,
            endLineNumber: marker.endLineNumber,
            endColumn: marker.endColumn,
          }),
          severity:
            marker.severity === monaco.MarkerSeverity.Error
              ? DiagnosticSeverity.Error
              : marker.severity === monaco.MarkerSeverity.Warning
                ? DiagnosticSeverity.Warning
                : marker.severity === monaco.MarkerSeverity.Info
                  ? DiagnosticSeverity.Information
                  : DiagnosticSeverity.Hint,
          message: marker.message,
          ...(code !== undefined ? { code } : {}),
        };
      });
      let actions: Awaited<ReturnType<typeof collectCodeActions>> = [];
      try {
        actions = await collectCodeActions({
          text: model.getValue(),
          ast: session.ast,
          analysis: session.analysis,
          range: toLspRange(range),
          diagnostics,
          ...resolverContext(model),
        });
      } catch {
        actions = [];
      }
      return {
        actions: actions.map((action) => ({
          title: action.title,
          kind: action.kind,
          isPreferred: action.isPreferred,
          edit: action.edit ? workspaceEditToMonaco(action.edit) : undefined,
        })),
        dispose: () => {},
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(LANG_ID, {
    provideDocumentFormattingEdits(model) {
      return [lspEditToMonaco(createFullDocumentFormatEdit(model.getValue()))];
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider(LANG_ID, {
    provideDocumentRangeFormattingEdits(model, range) {
      return [lspEditToMonaco(createRangeFormatEdit(model.getValue(), toLspRange(range)))];
    },
  });

  monaco.languages.registerOnTypeFormattingEditProvider(LANG_ID, {
    autoFormatTriggerCharacters: ["\n", "}"],
    provideOnTypeFormattingEdits(model, position, character) {
      return createOnTypeFormattingEdits(model.getValue(), toLspPos(position), character).map(lspEditToMonaco);
    },
  });

  monaco.languages.registerDocumentSymbolProvider(LANG_ID, {
    provideDocumentSymbols(model) {
      const session = getSession(model, cache);
      if (!session.ast) return [];
      const mapSymbol = (symbol: {
        name: string;
        kind: number;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
        children?: unknown[];
      }): monaco.languages.DocumentSymbol => ({
        name: symbol.name,
        detail: "",
        kind: LSP_SK[symbol.kind] ?? SK.Variable,
        range: toMonacoRange(symbol.range),
        selectionRange: toMonacoRange(symbol.selectionRange),
        tags: [],
        children: (symbol.children as typeof symbol[] | undefined)?.map(mapSymbol) ?? [],
      });
      return createDocumentSymbols(session.ast).map(mapSymbol);
    },
  });

  monaco.languages.registerFoldingRangeProvider(LANG_ID, {
    provideFoldingRanges(model) {
      const session = getSession(model, cache);
      if (!session.ast) return [];
      return createFoldingRanges(session.ast).map((range) => ({
        start: range.startLine + 1,
        end: range.endLine + 1,
        kind: range.kind === "comment"
          ? monaco.languages.FoldingRangeKind.Comment
          : range.kind === "imports"
            ? monaco.languages.FoldingRangeKind.Imports
            : monaco.languages.FoldingRangeKind.Region,
      }));
    },
  });

  monaco.languages.registerSelectionRangeProvider(LANG_ID, {
    provideSelectionRanges(model, positions) {
      const session = getSession(model, cache);
      if (!session.ast) return [];
      return createSelectionRanges(session.ast, positions.map(toLspPos)).map((selectionRange) => {
        const chain: monaco.languages.SelectionRange[] = [];
        let current: typeof selectionRange | undefined = selectionRange;
        while (current) {
          chain.push({ range: toMonacoRange(current.range) });
          current = current.parent;
        }
        return chain;
      });
    },
  });

  monaco.languages.registerInlayHintsProvider(LANG_ID, {
    async provideInlayHints(model, range) {
      const session = getSession(model, cache);
      if (!session.ast || !session.analysis) return { hints: [], dispose: () => {} };
      const hints = await createInlayHints(
        session.ast,
        session.analysis,
        toLspRange(range),
        resolverContext(model)
      );
      return {
        hints: hints.map((hint) => ({
          position: toMonacoPos(hint.position),
          label: typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""),
          kind: hint.kind === 1
            ? monaco.languages.InlayHintKind.Type
            : hint.kind === 2
              ? monaco.languages.InlayHintKind.Parameter
              : undefined,
          tooltip: toMarkdown(hint.tooltip),
          paddingLeft: hint.paddingLeft,
          paddingRight: hint.paddingRight,
        })),
        dispose: () => {},
      };
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider(LANG_ID, {
    getLegend: () => MYLANG_SEMANTIC_TOKENS_LEGEND,
    provideDocumentSemanticTokens(model) {
      const session = getSession(model, cache);
      const tokens = createSemanticTokens({
        text: model.getValue(),
        ast: session.ast,
        analysis: session.analysis,
      });
      return tokens?.data ? { data: new Uint32Array(tokens.data) } : null;
    },
    releaseDocumentSemanticTokens: () => {},
  });

  monaco.languages.registerDocumentRangeSemanticTokensProvider(LANG_ID, {
    getLegend: () => MYLANG_SEMANTIC_TOKENS_LEGEND,
    provideDocumentRangeSemanticTokens(model, range) {
      const session = getSession(model, cache);
      const tokens = createSemanticTokens({
        text: model.getValue(),
        ast: session.ast,
        analysis: session.analysis,
        range: toLspRange(range),
      });
      return tokens?.data ? { data: new Uint32Array(tokens.data) } : { data: new Uint32Array() };
    },
  });

  monaco.languages.registerCodeLensProvider(LANG_ID, {
    provideCodeLenses(model) {
      const session = getSession(model, cache);
      if (!session.ast || !session.analysis) return { lenses: [], dispose: () => {} };
      return {
        lenses: createReferenceCodeLenses(session.ast, session.analysis, model.uri.toString()).map((lens) => ({
          range: toMonacoRange(lens.range),
          command: mapCodeLensCommand(lens.command),
        })),
        dispose: () => {},
      };
    },
  });

  return cache;
}
