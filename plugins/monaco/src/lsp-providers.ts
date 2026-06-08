/**
 * Monaco language feature providers backed by the MyLang LSP server.
 *
 * Each provider translates between Monaco's coordinate system (1-based
 * lineNumber/column) and LSP's (0-based line/character), forwards the
 * request to the LSP via the WebSocket client, and maps the response back
 * to Monaco types.
 */

import * as monaco from "monaco-editor";
import type { CompilerClient } from "./compiler-client";
import { extractShowReferencesPayload } from "./codeLensCommands";

// ── LSP type stubs (only the shapes we actually use) ─────────────────────────

interface LspPos { line: number; character: number }
interface LspRange { start: LspPos; end: LspPos }
interface LspLocation { uri: string; range: LspRange }

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface LspTextEdit { range: LspRange; newText: string }

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }>;
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number; // 1=plain, 2=snippet
  textEdit?: { range: LspRange; newText: string };
  additionalTextEdits?: LspTextEdit[];
  data?: unknown;
}

interface LspHover {
  contents:
    | string
    | { kind?: string; value: string }
    | Array<string | { language?: string; value: string }>;
  range?: LspRange;
}

interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | { kind?: string; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { kind?: string; value: string };
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

interface LspSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspSymbol[];
}

interface LspCodeAction {
  title: string;
  kind?: string;
  edit?: LspWorkspaceEdit;
  data?: unknown;
}

interface LspInlayHint {
  position: LspPos;
  label: string | Array<{ value: string }>;
  kind?: number;
  tooltip?: string | { kind?: string; value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

interface LspSelectionRange {
  range: LspRange;
  parent?: LspSelectionRange;
}

// ── Coordinate conversion ─────────────────────────────────────────────────────

/** LSP (0-based) → Monaco (1-based) */
function toMonacoPos(p: LspPos): monaco.IPosition {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}

/** Monaco (1-based) → LSP (0-based) */
function toLspPos(p: monaco.IPosition): LspPos {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

/** LSP range → Monaco range */
function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

/** Monaco range → LSP range */
function toLspRange(r: monaco.IRange): LspRange {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end:   { line: r.endLineNumber   - 1, character: r.endColumn   - 1 },
  };
}

function lspEditToMonaco(e: LspTextEdit): monaco.languages.TextEdit {
  return { range: toMonacoRange(e.range), text: e.newText };
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

// ── Kind / severity mapping ───────────────────────────────────────────────────

const CIK = monaco.languages.CompletionItemKind;
const LSP_CIK: Record<number, monaco.languages.CompletionItemKind> = {
  1: CIK.Text, 2: CIK.Method, 3: CIK.Function, 4: CIK.Constructor,
  5: CIK.Field, 6: CIK.Variable, 7: CIK.Class, 8: CIK.Interface,
  9: CIK.Module, 10: CIK.Property, 11: CIK.Unit, 12: CIK.Value,
  13: CIK.Enum, 14: CIK.Keyword, 15: CIK.Snippet, 16: CIK.Color,
  17: CIK.File, 18: CIK.Reference, 19: CIK.Folder, 20: CIK.EnumMember,
  21: CIK.Constant, 22: CIK.Struct, 23: CIK.Event, 24: CIK.Operator,
  25: CIK.TypeParameter,
};
function mapCIK(k?: number) { return LSP_CIK[k ?? 0] ?? CIK.Text; }

const SK = monaco.languages.SymbolKind;
const LSP_SK: Record<number, monaco.languages.SymbolKind> = {
  1: SK.File, 2: SK.Module, 3: SK.Namespace, 4: SK.Package,
  5: SK.Class, 6: SK.Method, 7: SK.Property, 8: SK.Field,
  9: SK.Constructor, 10: SK.Enum, 11: SK.Interface, 12: SK.Function,
  13: SK.Variable, 14: SK.Constant, 15: SK.String, 16: SK.Number,
  17: SK.Boolean, 18: SK.Array, 19: SK.Object, 20: SK.Key,
  21: SK.Null, 22: SK.EnumMember, 23: SK.Struct, 24: SK.Event,
  25: SK.Operator, 26: SK.TypeParameter,
};
function mapSK(k?: number) { return LSP_SK[k ?? 0] ?? SK.Variable; }

function mapSeverity(s?: number): monaco.MarkerSeverity {
  if (s === 1) return monaco.MarkerSeverity.Error;
  if (s === 2) return monaco.MarkerSeverity.Warning;
  if (s === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

// ── Documentation helper ──────────────────────────────────────────────────────

function toMarkdown(
  doc: undefined | null | string | { kind?: string; value: string }
): monaco.IMarkdownString | string | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return { value: doc };
  return doc.kind === "markdown"
    ? { value: doc.value, isTrusted: false }
    : doc.value;
}

// ── WorkspaceEdit application ─────────────────────────────────────────────────

function applyWorkspaceEdit(edit: LspWorkspaceEdit): void {
  const map: Record<string, LspTextEdit[]> = { ...(edit.changes ?? {}) };
  for (const dc of edit.documentChanges ?? []) {
    if ("edits" in dc) {
      map[dc.textDocument.uri] = [...(map[dc.textDocument.uri] ?? []), ...dc.edits];
    }
  }
  for (const [uri, edits] of Object.entries(map)) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) model.applyEdits(edits.map(lspEditToMonaco));
  }
}

function workspaceEditToMonaco(edit: LspWorkspaceEdit): monaco.languages.WorkspaceEdit {
  const map: Record<string, LspTextEdit[]> = { ...(edit.changes ?? {}) };
  for (const dc of edit.documentChanges ?? []) {
    if ("edits" in dc) {
      map[dc.textDocument.uri] = [...(map[dc.textDocument.uri] ?? []), ...dc.edits];
    }
  }
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, textEdits] of Object.entries(map)) {
    const resource = monaco.Uri.parse(uri);
    for (const e of textEdits) {
      edits.push({ resource, textEdit: lspEditToMonaco(e), versionId: undefined });
    }
  }
  return { edits };
}

// ── Register MyLang language definition ───────────────────────────────────────

const LANG_ID = "mylang";

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
        [
          /[A-Za-z_$][\w$]*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
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
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
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

// ── Diagnostics (pull model) ──────────────────────────────────────────────────

export function setModelDiagnostics(
  model: monaco.editor.ITextModel,
  diags: LspDiagnostic[]
): void {
  monaco.editor.setModelMarkers(
    model,
    "lsp",
    diags.map((d) => ({
      severity: mapSeverity(d.severity),
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      code: String(d.code ?? ""),
      source: d.source ?? "mylang",
    }))
  );
}

export async function pullDiagnostics(
  lsp: CompilerClient,
  model: monaco.editor.ITextModel
): Promise<void> {
  try {
    const result = await lsp.request<{ items?: LspDiagnostic[] }>(
      "textDocument/diagnostic",
      { textDocument: { uri: model.uri.toString() } }
    );
    if (result?.items) setModelDiagnostics(model, result.items);
  } catch {
    // Server may not support pull diagnostics — that's fine.
  }
}

// ── Register all language feature providers ───────────────────────────────────

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export function registerProviders(
  lsp: CompilerClient,
  legend: SemanticTokensLegend
): void {
  // ── Completion ──────────────────────────────────────────────────────────────
  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position, ctx) {
      try {
        const raw = await lsp.request<
          { items: LspCompletionItem[] } | LspCompletionItem[] | null
        >("textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
          context: { triggerKind: ctx.triggerKind },
        });
        if (!raw) return { suggestions: [] };
        const items = Array.isArray(raw) ? raw : raw.items;
        const word = model.getWordUntilPosition(position);
        const defaultRange = new monaco.Range(
          position.lineNumber, word.startColumn,
          position.lineNumber, word.endColumn
        );
        return {
          suggestions: items.map(
            (item): monaco.languages.CompletionItem => ({
              label: item.label,
              kind: mapCIK(item.kind),
              detail: item.detail,
              documentation: toMarkdown(item.documentation),
              sortText: item.sortText,
              filterText: item.filterText,
              insertText: item.insertText ?? item.label,
              insertTextRules:
                item.insertTextFormat === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
              range: item.textEdit
                ? toMonacoRange(item.textEdit.range)
                : defaultRange,
              additionalTextEdits: item.additionalTextEdits?.map(lspEditToMonaco),
            })
          ),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });

  // ── Hover ───────────────────────────────────────────────────────────────────
  monaco.languages.registerHoverProvider(LANG_ID, {
    async provideHover(model, position) {
      try {
        const result = await lsp.request<LspHover | null>("textDocument/hover", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        });
        if (!result) return null;
        const contents: monaco.IMarkdownString[] = [];
        const raw = result.contents;
        if (typeof raw === "string") {
          contents.push({ value: raw });
        } else if (Array.isArray(raw)) {
          for (const c of raw) {
            contents.push(
              typeof c === "string" ? { value: c } : { value: c.value }
            );
          }
        } else if ("value" in raw) {
          contents.push(
            raw.kind === "markdown"
              ? { value: raw.value, isTrusted: false }
              : { value: "```\n" + raw.value + "\n```" }
          );
        }
        return { contents, range: result.range ? toMonacoRange(result.range) : undefined };
      } catch {
        return null;
      }
    },
  });

  // ── Signature Help ──────────────────────────────────────────────────────────
  monaco.languages.registerSignatureHelpProvider(LANG_ID, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position) {
      try {
        const result = await lsp.request<LspSignatureHelp | null>(
          "textDocument/signatureHelp",
          { textDocument: { uri: model.uri.toString() }, position: toLspPos(position) }
        );
        if (!result) return null;
        return {
          value: {
            signatures: result.signatures.map((s) => ({
              label: s.label,
              documentation: toMarkdown(s.documentation),
              parameters: (s.parameters ?? []).map((p) => ({
                label: p.label,
                documentation: toMarkdown(p.documentation),
              })),
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose: () => undefined,
        };
      } catch {
        return null;
      }
    },
  });

  // ── Go-to Definition ────────────────────────────────────────────────────────
  monaco.languages.registerDefinitionProvider(LANG_ID, {
    async provideDefinition(model, position) {
      try {
        const raw = await lsp.request<LspLocation | LspLocation[] | null>(
          "textDocument/definition",
          { textDocument: { uri: model.uri.toString() }, position: toLspPos(position) }
        );
        if (!raw) return [];
        const locs = Array.isArray(raw) ? raw : [raw];
        return locs.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toMonacoRange(l.range) }));
      } catch {
        return [];
      }
    },
  });

  // ── Type Definition ─────────────────────────────────────────────────────────
  monaco.languages.registerTypeDefinitionProvider(LANG_ID, {
    async provideTypeDefinition(model, position) {
      try {
        const raw = await lsp.request<LspLocation | LspLocation[] | null>(
          "textDocument/typeDefinition",
          { textDocument: { uri: model.uri.toString() }, position: toLspPos(position) }
        );
        if (!raw) return [];
        const locs = Array.isArray(raw) ? raw : [raw];
        return locs.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toMonacoRange(l.range) }));
      } catch {
        return [];
      }
    },
  });

  // ── References ──────────────────────────────────────────────────────────────
  monaco.languages.registerReferenceProvider(LANG_ID, {
    async provideReferences(model, position, ctx) {
      try {
        const raw = await lsp.request<LspLocation[] | null>(
          "textDocument/references",
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPos(position),
            context: { includeDeclaration: ctx.includeDeclaration },
          }
        );
        if (!raw) return [];
        return raw.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toMonacoRange(l.range) }));
      } catch {
        return [];
      }
    },
  });

  // ── Document Highlights ─────────────────────────────────────────────────────
  monaco.languages.registerDocumentHighlightProvider(LANG_ID, {
    async provideDocumentHighlights(model, position) {
      try {
        const raw = await lsp.request<
          Array<{ range: LspRange; kind?: number }> | null
        >("textDocument/documentHighlight", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        });
        if (!raw) return [];
        return raw.map((h) => ({
          range: toMonacoRange(h.range),
          kind:
            h.kind === 2
              ? monaco.languages.DocumentHighlightKind.Write
              : monaco.languages.DocumentHighlightKind.Read,
        }));
      } catch {
        return [];
      }
    },
  });

  // ── Rename ──────────────────────────────────────────────────────────────────
  monaco.languages.registerRenameProvider(LANG_ID, {
    async resolveRenameLocation(model, position) {
      const REJECT: monaco.languages.RenameLocation & { rejectReason: string } =
        { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: "Cannot rename this symbol" };
      try {
        const result = await lsp.request<{ range: LspRange; placeholder: string } | null>(
          "textDocument/prepareRename",
          { textDocument: { uri: model.uri.toString() }, position: toLspPos(position) }
        );
        if (!result) return REJECT;
        return { range: toMonacoRange(result.range), text: result.placeholder };
      } catch {
        return REJECT;
      }
    },
    async provideRenameEdits(model, position, newName) {
      try {
        const result = await lsp.request<LspWorkspaceEdit | null>(
          "textDocument/rename",
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPos(position),
            newName,
          }
        );
        if (!result) return { edits: [] };
        return workspaceEditToMonaco(result);
      } catch {
        return { edits: [] };
      }
    },
  });

  // ── Code Actions ────────────────────────────────────────────────────────────
  monaco.languages.registerCodeActionProvider(LANG_ID, {
    async provideCodeActions(model, range, ctx) {
      try {
        const raw = await lsp.request<LspCodeAction[] | null>(
          "textDocument/codeAction",
          {
            textDocument: { uri: model.uri.toString() },
            range: toLspRange(range),
            context: {
              diagnostics: ctx.markers.map((m) => ({
                range: {
                  start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
                  end:   { line: m.endLineNumber   - 1, character: m.endColumn   - 1 },
                },
                severity:
                  m.severity === monaco.MarkerSeverity.Error ? 1
                  : m.severity === monaco.MarkerSeverity.Warning ? 2
                  : 3,
                message: m.message,
                code: m.code,
              })),
            },
          }
        );
        if (!raw) return { actions: [], dispose: () => undefined };

        const actions: monaco.languages.CodeAction[] = await Promise.all(
          raw.map(async (action) => {
            // Resolve deferred code actions.
            let resolved = action;
            if (action.data !== undefined && !action.edit) {
              try {
                resolved = await lsp.request<LspCodeAction>("codeAction/resolve", action);
              } catch {
                // Use unresolved if resolve fails.
              }
            }
            return {
              title: resolved.title,
              kind: resolved.kind,
              edit: resolved.edit ? workspaceEditToMonaco(resolved.edit) : undefined,
              isPreferred: resolved.kind?.startsWith("quickfix"),
            } satisfies monaco.languages.CodeAction;
          })
        );
        return { actions, dispose: () => undefined };
      } catch {
        return { actions: [], dispose: () => undefined };
      }
    },
  });

  // ── Document Formatting ─────────────────────────────────────────────────────
  monaco.languages.registerDocumentFormattingEditProvider(LANG_ID, {
    async provideDocumentFormattingEdits(model) {
      try {
        const raw = await lsp.request<LspTextEdit[] | null>(
          "textDocument/formatting",
          { textDocument: { uri: model.uri.toString() }, options: { tabSize: 4, insertSpaces: true } }
        );
        return (raw ?? []).map(lspEditToMonaco);
      } catch {
        return [];
      }
    },
  });

  // ── Range Formatting ────────────────────────────────────────────────────────
  monaco.languages.registerDocumentRangeFormattingEditProvider(LANG_ID, {
    async provideDocumentRangeFormattingEdits(model, range) {
      try {
        const raw = await lsp.request<LspTextEdit[] | null>(
          "textDocument/rangeFormatting",
          {
            textDocument: { uri: model.uri.toString() },
            range: toLspRange(range),
            options: { tabSize: 4, insertSpaces: true },
          }
        );
        return (raw ?? []).map(lspEditToMonaco);
      } catch {
        return [];
      }
    },
  });

  // ── On-Type Formatting ──────────────────────────────────────────────────────
  monaco.languages.registerOnTypeFormattingEditProvider(LANG_ID, {
    autoFormatTriggerCharacters: ["\n", "}"],
    async provideOnTypeFormattingEdits(model, position, ch) {
      try {
        const raw = await lsp.request<LspTextEdit[] | null>(
          "textDocument/onTypeFormatting",
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPos(position),
            ch,
            options: { tabSize: 4, insertSpaces: true },
          }
        );
        return (raw ?? []).map(lspEditToMonaco);
      } catch {
        return [];
      }
    },
  });

  // ── Document Symbols ────────────────────────────────────────────────────────
  monaco.languages.registerDocumentSymbolProvider(LANG_ID, {
    async provideDocumentSymbols(model) {
      try {
        const raw = await lsp.request<LspSymbol[] | null>(
          "textDocument/documentSymbol",
          { textDocument: { uri: model.uri.toString() } }
        );
        if (!raw) return [];
        function mapSym(s: LspSymbol): monaco.languages.DocumentSymbol {
          return {
            name: s.name,
            detail: "",
            kind: mapSK(s.kind),
            range: toMonacoRange(s.range),
            selectionRange: toMonacoRange(s.selectionRange),
            tags: [],
            children: (s.children ?? []).map(mapSym),
          };
        }
        return raw.map(mapSym);
      } catch {
        return [];
      }
    },
  });

  // ── Folding Ranges ──────────────────────────────────────────────────────────
  monaco.languages.registerFoldingRangeProvider(LANG_ID, {
    async provideFoldingRanges(model) {
      try {
        const raw = await lsp.request<
          Array<{ startLine: number; endLine: number; kind?: string }> | null
        >("textDocument/foldingRange", { textDocument: { uri: model.uri.toString() } });
        if (!raw) return [];
        return raw.map((r) => ({
          start: r.startLine + 1,
          end:   r.endLine   + 1,
          kind:
            r.kind === "comment"
              ? monaco.languages.FoldingRangeKind.Comment
              : r.kind === "imports"
                ? monaco.languages.FoldingRangeKind.Imports
                : monaco.languages.FoldingRangeKind.Region,
        }));
      } catch {
        return [];
      }
    },
  });

  // ── Selection Ranges ────────────────────────────────────────────────────────
  monaco.languages.registerSelectionRangeProvider(LANG_ID, {
    async provideSelectionRanges(model, positions) {
      try {
        const raw = await lsp.request<LspSelectionRange[] | null>(
          "textDocument/selectionRange",
          { textDocument: { uri: model.uri.toString() }, positions: positions.map(toLspPos) }
        );
        if (!raw) return [];
        return raw.map((sr) => {
          const chain: monaco.languages.SelectionRange[] = [];
          let cur: LspSelectionRange | undefined = sr;
          while (cur) {
            chain.push({ range: toMonacoRange(cur.range) });
            cur = cur.parent;
          }
          return chain;
        });
      } catch {
        return [];
      }
    },
  });

  // ── Inlay Hints ─────────────────────────────────────────────────────────────
  monaco.languages.registerInlayHintsProvider(LANG_ID, {
    async provideInlayHints(model, range) {
      try {
        const raw = await lsp.request<LspInlayHint[] | null>(
          "textDocument/inlayHint",
          { textDocument: { uri: model.uri.toString() }, range: toLspRange(range) }
        );
        if (!raw) return { hints: [], dispose: () => undefined };
        return {
          hints: raw.map(
            (h): monaco.languages.InlayHint => ({
              position: toMonacoPos(h.position),
              label:
                typeof h.label === "string"
                  ? h.label
                  : h.label.map((p) => p.value).join(""),
              kind:
                h.kind === 1
                  ? monaco.languages.InlayHintKind.Type
                  : h.kind === 2
                    ? monaco.languages.InlayHintKind.Parameter
                    : undefined,
              tooltip: toMarkdown(h.tooltip),
              paddingLeft:  h.paddingLeft,
              paddingRight: h.paddingRight,
            })
          ),
          dispose: () => undefined,
        };
      } catch {
        return { hints: [], dispose: () => undefined };
      }
    },
  });

  // ── Semantic Tokens ─────────────────────────────────────────────────────────
  monaco.languages.registerDocumentSemanticTokensProvider(LANG_ID, {
    getLegend: () => legend,
    async provideDocumentSemanticTokens(model) {
      try {
        const raw = await lsp.request<{ data: number[] } | null>(
          "textDocument/semanticTokens/full",
          { textDocument: { uri: model.uri.toString() } }
        );
        if (!raw?.data) return null;
        return { data: new Uint32Array(raw.data) };
      } catch {
        return null;
      }
    },
    releaseDocumentSemanticTokens: () => undefined,
  });

  // ── Code Lens (reference counts) ───────────────────────────────────────────
  monaco.languages.registerCodeLensProvider(LANG_ID, {
    async provideCodeLenses(model) {
      try {
        const raw = await lsp.request<
          Array<{ range: LspRange; command?: { title: string; command: string } }> | null
        >("textDocument/codeLens", { textDocument: { uri: model.uri.toString() } });
        if (!raw) return { lenses: [], dispose: () => undefined };
        return {
          lenses: raw.map((cl) => ({
            range: toMonacoRange(cl.range),
            command: mapCodeLensCommand(cl.command),
          })),
          dispose: () => undefined,
        };
      } catch {
        return { lenses: [], dispose: () => undefined };
      }
    },
  });

  // ── Linked Editing (rename matching pairs in sync) ──────────────────────────
  monaco.languages.registerLinkedEditingRangeProvider(LANG_ID, {
    async provideLinkedEditingRanges(model, position) {
      try {
        const raw = await lsp.request<{
          ranges: LspRange[];
          wordPattern?: string;
        } | null>("textDocument/linkedEditingRange", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        });
        if (!raw?.ranges?.length) return null;
        return {
          ranges: raw.ranges.map(toMonacoRange),
          wordPattern: raw.wordPattern ? new RegExp(raw.wordPattern) : undefined,
        };
      } catch {
        return null;
      }
    },
  });

  // ── workspace/applyEdit request from server ─────────────────────────────────
  lsp.onRequest("workspace/applyEdit", (params) => {
    const p = params as { edit: LspWorkspaceEdit };
    applyWorkspaceEdit(p.edit);
    return { applied: true };
  });
}
