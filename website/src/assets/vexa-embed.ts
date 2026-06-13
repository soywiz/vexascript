import "monaco-editor/min/vs/editor/editor.main.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import * as monaco from "monaco-editor";
import { createAnalysisSession } from "compiler/lsp/analysisSession";
import { normalizeWorkspacePath as normalizePath, workspacePathBasename as basename, workspacePathDirname as dirname } from "./monaco/workspacePaths";
import { collectTopLevelDeclarationsFromAst } from "compiler/analysis/projectIndex";
import {
  ensureEcmaScriptRuntimeProgram,
  ensureVexaScriptRuntimeProgram,
} from "compiler/runtime/ecmascriptDeclarations";
import { collectCodeActions } from "compiler/lsp/codeActionsAggregate";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems,
} from "compiler/lsp/completion";
import { createAutoAwaitDecorations } from "compiler/lsp/autoAwaitDecorations";
import {
  createDocumentHighlights,
  createFoldingRanges,
  createOnTypeFormattingEdits,
  createSelectionRanges,
} from "compiler/lsp/documentFeatures";
import { collectImportedSymbolTypes, collectImportedTypeDeclarations } from "compiler/lsp/importedDeclarations";
import { createFullDocumentFormatEdit, createRangeFormatEdit } from "compiler/lsp/formatting";
import { createInlayHints } from "compiler/lsp/inlayHints";
import {
  createPrepareRename,
  createHover,
  createDefinitionLocation,
} from "compiler/lsp/navigation";
import {
  resolveDefinitionAcrossFiles,
  resolveReferencesAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveRenameAcrossFiles,
} from "compiler/lsp/crossFileNavigation";
import { createSemanticTokens, VEXA_SEMANTIC_TOKENS_LEGEND } from "compiler/lsp/semanticTokens";
import { createSignatureHelp } from "compiler/lsp/signatureHelp";
import { createDocumentSymbols } from "compiler/lsp/symbols";
import {
  createPortableLanguageConfiguration,
  createPortableMonarchLanguage,
  type PortableLanguageConfiguration,
  type PortableMonarchLanguage,
} from "compiler/syntax";
import {
  bundledDomRuntimeUrl,
  bundledRuntimeUrl,
  bundledVexaRuntimeUrl,
  editorWorkerUrl,
} from "../generated/embed-asset-manifest";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";
import type { SymbolExport } from "compiler/lsp/importFixes";
import { bundleModuleGraph } from "compiler/runtime/moduleGraph";
import { COMPILER_VERSION } from "compiler/compilerVersion";
import { buildPreviewDocument } from "./previewDocument";
import { completionInsertText, markerToDiagnostic } from "./monaco/providerConversions";
import { WorkspaceVfs } from "./monaco/workspaceVfs";
import {
  createFileInWorkspace,
  createFileEntry,
  createFolderInWorkspace,
  createFolderEntry,
  deleteWorkspaceEntry,
  listChildren,
  pathToUri,
  updateFileContent,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "./monaco/workspace";
import { createVexaScriptMonacoTheme, VEXA_MONACO_THEME_NAME } from "./monaco/theme";
import { collectWorkspaceDiagnostics } from "./monaco/workspaceDiagnostics";
import {
  createWorkbenchBrowserHistorySnapshot,
  pushWorkbenchBrowserHistorySnapshot,
  readWorkbenchBrowserHistorySnapshot,
  writeWorkbenchBrowserHistorySnapshot,
  type WorkbenchBrowserHistorySnapshot,
} from "./workbenchBrowserHistory";
import {
  COMPACT_WORKBENCH_MEDIA_QUERY,
  deriveWorkbenchSidebarState,
  workbenchSidebarToggleLabel,
  type WorkbenchSidebarState,
} from "./workbenchSidebar";

interface VexaScriptEmbedFile {
  path: string;
  content: string;
  language?: "vexa" | "typescript";
  readOnly?: boolean;
}

interface EditorHandle {
  editor: monaco.editor.IStandaloneCodeEditor;
  dispose(): void;
  getValue(path?: string): string;
  setValue(content: string, path?: string): void;
}

interface TabbedEditorHandle extends EditorHandle {
  openFile(path: string, selection?: monaco.IRange): void;
}

interface WorkbenchEditorHandle extends TabbedEditorHandle {
  save(): void;
  getEntries(): WorkspaceEntry[];
  run(): Promise<void>;
}

interface SimpleEditorOptions {
  content: string;
  path?: string;
  readOnly?: boolean;
  height?: string;
  inlayHints?: boolean;
  selection?: monaco.IRange;
}

interface WorkspaceEditorOptions {
  files: VexaScriptEmbedFile[];
  activePath?: string;
  height?: string;
  inlayHints?: boolean;
  selection?: monaco.IRange;
}

interface WorkbenchEditorOptions extends WorkspaceEditorOptions {
  allowWorkspaceWrites?: boolean;
  storageKey?: string;
  sessionStorageKey?: string;
}

interface EmbedWorkspaceContext {
  vfs: WorkspaceVfs;
  getSessionForFilePath(filePath: string): ReturnType<typeof createAnalysisSession> | null | Promise<ReturnType<typeof createAnalysisSession> | null>;
  getExportedSymbols(): Promise<SymbolExport[]>;
  getRevision(): number;
}

interface StoredWorkbenchWorkspaceSnapshot {
  entries: WorkspaceEntry[];
}

function inlayHintsStorageKey(storageKey: string): string {
  return `${storageKey}.inlayHints`;
}

let bootstrapped = false;
let modelCounter = 0;
let autoAwaitGlyphStyleInjected = false;
let cachedDomAmbientDeclarations: Statement[] | null = null;
let bundledRuntimeContent: string | null = null;
let bundledVexaRuntimeContent: string | null = null;
let bundledDomRuntimeContent: string | null = null;
let bundledRuntimeLoadPromise: Promise<{ runtime: string; vexa: string; dom: string }> | null = null;
let embeddedRuntimeReady = false;
let embeddedRuntimeReadyPromise: Promise<void> | null = null;
const embedWorkspaceContextsByUri = new Map<string, EmbedWorkspaceContext>();
const modelSessionCache = new Map<string, {
  versionId: number;
  workspaceRevision: number;
  session: Promise<ReturnType<typeof createAnalysisSession>>;
}>();
const DEFAULT_WORKBENCH_STORAGE_KEY = "vexa.embed.workbench.v1";
const DEFAULT_WORKBENCH_SESSION_STORAGE_KEY = "vexa.embed.workbench.session.v1";

const autoAwaitGlyphCollections = new WeakMap<
  monaco.editor.ICodeEditor,
  monaco.editor.IEditorDecorationsCollection
>();
const autoAwaitGlyphRefreshVersions = new WeakMap<
  monaco.editor.ICodeEditor,
  number
>();
const pendingRuntimeReadyRefreshes = new Map<string, Promise<void>>();

const completionItemKind = monaco.languages.CompletionItemKind;
const lspCompletionItemKinds: Record<number, monaco.languages.CompletionItemKind> = {
  1: completionItemKind.Text,
  2: completionItemKind.Method,
  3: completionItemKind.Function,
  4: completionItemKind.Constructor,
  5: completionItemKind.Field,
  6: completionItemKind.Variable,
  7: completionItemKind.Class,
  8: completionItemKind.Interface,
  9: completionItemKind.Module,
  10: completionItemKind.Property,
  13: completionItemKind.Enum,
  14: completionItemKind.Keyword,
  20: completionItemKind.EnumMember,
  24: completionItemKind.Operator,
  25: completionItemKind.TypeParameter,
};

const RUNTIME_LOADING_PLACEHOLDER = "// Loading runtime declarations...\n";

const documentSymbolKind = monaco.languages.SymbolKind;
const lspDocumentSymbolKinds: Record<number, monaco.languages.SymbolKind> = {
  5: documentSymbolKind.Class,
  6: documentSymbolKind.Method,
  7: documentSymbolKind.Property,
  8: documentSymbolKind.Field,
  10: documentSymbolKind.Enum,
  11: documentSymbolKind.Interface,
  12: documentSymbolKind.Function,
  13: documentSymbolKind.Variable,
  22: documentSymbolKind.EnumMember,
};

declare global {
  interface Window {
    VexaScriptEmbeds?: {
      createSimpleEditor(container: HTMLElement | string, options: SimpleEditorOptions): EditorHandle;
      createTabbedEditor(container: HTMLElement | string, options: WorkspaceEditorOptions): TabbedEditorHandle;
      createWorkspaceEditor(container: HTMLElement | string, options: WorkspaceEditorOptions): EditorHandle;
      createWorkbenchEditor(container: HTMLElement | string, options: WorkbenchEditorOptions): WorkbenchEditorHandle;
      monaco: typeof monaco;
    };
  }
}

self.MonacoEnvironment = {
  getWorker(_id: string, _label: string): Worker {
    return new Worker(editorWorkerUrl, { type: "module" });
  },
};

function isRuntimeDeclarationPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "/runtime/dom.d.ts"
    || normalized === "/runtime/es2025.d.ts"
    || normalized === "/runtime/vexascript.d.vx";
}

async function loadTextAsset(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load asset: ${url}`);
  }
  return response.text();
}

function ensureBundledRuntimeContents(): Promise<{ runtime: string; vexa: string; dom: string }> {
  if (bundledRuntimeContent !== null && bundledVexaRuntimeContent !== null && bundledDomRuntimeContent !== null) {
    return Promise.resolve({
      runtime: bundledRuntimeContent,
      vexa: bundledVexaRuntimeContent,
      dom: bundledDomRuntimeContent,
    });
  }
  if (!bundledRuntimeLoadPromise) {
    bundledRuntimeLoadPromise = Promise.all([
      loadTextAsset(bundledRuntimeUrl),
      loadTextAsset(bundledVexaRuntimeUrl),
      loadTextAsset(bundledDomRuntimeUrl),
    ]).then(([runtime, vexa, dom]) => {
      bundledRuntimeContent = runtime;
      bundledVexaRuntimeContent = vexa;
      bundledDomRuntimeContent = dom;
      return { runtime, vexa, dom };
    });
  }
  return bundledRuntimeLoadPromise;
}

function createBundledRuntimeEntries(): WorkspaceEntry[] {
  return [
    createFolderEntry("/runtime", true),
    createFileEntry("/runtime/es2025.d.ts", bundledRuntimeContent ?? RUNTIME_LOADING_PLACEHOLDER, {
      language: "vexa",
      readOnly: true,
      uri: pathToUri("/runtime/es2025.d.ts"),
    }),
    createFileEntry("/runtime/vexascript.d.vx", bundledVexaRuntimeContent ?? RUNTIME_LOADING_PLACEHOLDER, {
      language: "vexa",
      readOnly: true,
      uri: pathToUri("/runtime/vexascript.d.vx"),
    }),
    createFileEntry("/runtime/dom.d.ts", bundledDomRuntimeContent ?? RUNTIME_LOADING_PLACEHOLDER, {
      language: "vexa",
      readOnly: true,
      uri: pathToUri("/runtime/dom.d.ts"),
    }),
  ];
}

function ensureEmbeddedRuntimeReady(): Promise<void> {
  if (embeddedRuntimeReady) {
    return Promise.resolve();
  }
  if (!embeddedRuntimeReadyPromise) {
    embeddedRuntimeReadyPromise = Promise.all([
      ensureBundledRuntimeContents(),
      ensureEcmaScriptRuntimeProgram(),
      ensureVexaScriptRuntimeProgram(),
      getDomAmbientDeclarations(),
    ]).then(() => {
      // Monaco providers can ask for sessions before the bundled runtimes finish
      // loading; drop those stale pre-runtime sessions once initialization completes.
      modelSessionCache.clear();
      embeddedRuntimeReady = true;
    });
  }
  return embeddedRuntimeReadyPromise;
}

function ensureAutoAwaitGlyphStyle(): void {
  if (autoAwaitGlyphStyleInjected) {
    return;
  }
  const style = document.createElement("style");
  style.textContent = `
    .vexa-auto-await-glyph {
      background-repeat: no-repeat;
      background-position: center center;
      background-size: 70%;
      cursor: default;
      background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="%23c586c0" stroke-width="1.2"/><path d="M8 4.2v5.1" fill="none" stroke="%23c586c0" stroke-width="1.4" stroke-linecap="round"/><path d="M5.6 7.1 8 9.6l2.4-2.5" fill="none" stroke="%23c586c0" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    }
  `;
  document.head.append(style);
  autoAwaitGlyphStyleInjected = true;
}

function shouldDebugDiagnosticsRefresh(): boolean {
  try {
    return window.localStorage.getItem("vexa.debug.gutter") === "1";
  } catch {
    return false;
  }
}

function logDiagnosticsRefresh(reason: string, model: monaco.editor.ITextModel): void {
  if (!shouldDebugDiagnosticsRefresh()) {
    return;
  }
  console.debug("[vexa][diagnostics]", reason, model.uri.toString(), `v${model.getVersionId()}`);
}

function toMonacoMonarchLanguage(portable: PortableMonarchLanguage): Record<string, unknown> {
  const tokenizer = Object.fromEntries(
    Object.entries(portable.tokenizer).map(([state, rules]) => [
      state,
      rules.map((rule) => {
        if (rule.token === "@cases" && rule.cases) {
          return [new RegExp(rule.match), { cases: rule.cases }];
        }
        if (rule.next || rule.switchTo) {
          return [
            new RegExp(rule.match),
            {
              token: rule.token,
              ...(rule.next ? { next: rule.next } : {}),
              ...(rule.switchTo ? { switchTo: rule.switchTo } : {}),
            },
          ];
        }
        return [new RegExp(rule.match), rule.token];
      }),
    ])
  );
  return {
    defaultToken: portable.defaultToken,
    keywords: portable.keywords,
    declarationKeywords: portable.declarationKeywords,
    controlKeywords: portable.controlKeywords,
    tokenizer,
  };
}

function toMonacoLanguageConfiguration(portable: PortableLanguageConfiguration): monaco.languages.LanguageConfiguration {
  return {
    comments: portable.comments,
    brackets: portable.brackets,
    autoClosingPairs: portable.autoClosingPairs,
    surroundingPairs: portable.surroundingPairs,
    indentationRules: {
      increaseIndentPattern: new RegExp(portable.indentationRules.increaseIndentPattern),
      decreaseIndentPattern: new RegExp(portable.indentationRules.decreaseIndentPattern),
    },
    onEnterRules: portable.onEnterRules.map((rule) => ({
      ...(rule.afterText ? { afterText: new RegExp(rule.afterText) } : {}),
      beforeText: new RegExp(rule.beforeText),
      action: {
        indentAction: rule.indentAction === "indentOutdent"
          ? monaco.languages.IndentAction.IndentOutdent
          : monaco.languages.IndentAction.Indent,
      },
    })),
  };
}

function registerVexaScript(): void {
  monaco.languages.register({
    id: "vexa",
    extensions: [".vx", ".ts", ".d.ts"],
    aliases: ["VexaScript", "vexa"],
    mimetypes: ["text/x-vexa", "text/typescript", "application/typescript"],
  });
  monaco.languages.setMonarchTokensProvider("vexa", toMonacoMonarchLanguage(createPortableMonarchLanguage()) as monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration("vexa", toMonacoLanguageConfiguration(createPortableLanguageConfiguration()));
}

async function getSessionForModel(model: monaco.editor.ITextModel): Promise<ReturnType<typeof createAnalysisSession>> {
  const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
  const workspaceRevision = workspaceContext?.getRevision() ?? 0;
  const cached = modelSessionCache.get(model.uri.toString());
  if (cached && cached.versionId === model.getVersionId() && cached.workspaceRevision === workspaceRevision) {
    return cached.session;
  }
  const session = (async () => {
    const ambientDeclarations = await getDomAmbientDeclarations();
    const baseSession = createAnalysisSession(model.getValue(), [], new Map(), ambientDeclarations);
    if (!baseSession.ast || !workspaceContext) {
      return baseSession;
    }
    const resolverContext = {
      uri: model.uri.toString(),
      sourceRoots: [],
      vfs: workspaceContext.vfs,
      getSessionForFilePath: workspaceContext.getSessionForFilePath,
      getExportedSymbols: workspaceContext.getExportedSymbols,
    };
    const [externalDeclarations, importedSymbolTypes] = await Promise.all([
      collectImportedTypeDeclarations(baseSession.ast, resolverContext),
      collectImportedSymbolTypes(baseSession.ast, resolverContext),
    ]);
    if (externalDeclarations.length === 0 && importedSymbolTypes.size === 0) {
      return baseSession;
    }
    return createAnalysisSession(model.getValue(), externalDeclarations, importedSymbolTypes, ambientDeclarations);
  })();
  modelSessionCache.set(model.uri.toString(), {
    versionId: model.getVersionId(),
    workspaceRevision,
    session,
  });
  session.catch(() => {
    const current = modelSessionCache.get(model.uri.toString());
    if (current?.session === session) {
      modelSessionCache.delete(model.uri.toString());
    }
  });
  return session;
}

function completionEditRange(
  textEdit: unknown,
  fallbackRange: monaco.IRange
): monaco.IRange {
  if (!textEdit || typeof textEdit !== "object") {
    return fallbackRange;
  }
  if ("range" in textEdit) {
    const editRange = (textEdit as {
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }).range;
    return {
      startLineNumber: editRange.start.line + 1,
      startColumn: editRange.start.character + 1,
      endLineNumber: editRange.end.line + 1,
      endColumn: editRange.end.character + 1,
    };
  }
  if ("insert" in textEdit) {
    const editRange = (textEdit as {
      insert: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }).insert;
    return {
      startLineNumber: editRange.start.line + 1,
      startColumn: editRange.start.character + 1,
      endLineNumber: editRange.end.line + 1,
      endColumn: editRange.end.character + 1,
    };
  }
  return fallbackRange;
}

function toMarkdown(value: unknown): monaco.IMarkdownString | string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return { value };
  }
  if (typeof value === "object" && "kind" in (value as Record<string, unknown>) && "value" in (value as Record<string, unknown>)) {
    const content = value as { kind?: string; value: string };
    return content.kind === "markdown" ? { value: content.value, isTrusted: false } : content.value;
  }
  return undefined;
}

function lspEditToMonaco(edit: {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}): monaco.languages.TextEdit {
  return {
    range: {
      startLineNumber: edit.range.start.line + 1,
      startColumn: edit.range.start.character + 1,
      endLineNumber: edit.range.end.line + 1,
      endColumn: edit.range.end.character + 1,
    },
    text: edit.newText,
  };
}

function toLspRange(range: monaco.IRange) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

function workspaceEditToMonaco(edit: {
  changes?: Record<string, Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }>>;
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
    return {
      range: {
        startLineNumber: value.range.start.line + 1,
        startColumn: value.range.start.character + 1,
        endLineNumber: value.range.end.line + 1,
        endColumn: value.range.end.character + 1,
      },
      text: value.placeholder,
    };
  }
  return null;
}

function resolverContext(model: monaco.editor.ITextModel, workspaceContext?: EmbedWorkspaceContext) {
  return {
    uri: model.uri.toString(),
    sourceRoots: [],
    ...(workspaceContext ? {
      vfs: workspaceContext.vfs,
      getSessionForFilePath: workspaceContext.getSessionForFilePath,
      getExportedSymbols: workspaceContext.getExportedSymbols,
    } : {}),
  };
}

function toMonacoPos(position: { line: number; character: number }): monaco.IPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

function registerCompletionProvider(): void {
  monaco.languages.registerCompletionItemProvider("vexa", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const fallbackRange = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn
      );
      const session = await getSessionForModel(model);
      if (!session.ast || !session.analysis) {
        return {
          suggestions: createKeywordOnlyCompletionItems().map((item) => {
            const insert = completionInsertText(item);
            return {
              ...insert,
              label: item.label,
              kind: lspCompletionItemKinds[item.kind ?? 0] ?? completionItemKind.Text,
              insertTextRules: insert.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              range: fallbackRange,
            };
          }),
        };
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const items = await createCompletionItemsForPosition(
        session.ast,
        position.lineNumber - 1,
        position.column - 1,
        session.analysis,
        [],
        {
          text: model.getValue(),
          ...resolverContext(model, workspaceContext),
          ambientDeclarations: session.ambientDeclarations,
          recoverAnalysisSession: (source) => createAnalysisSession(
            source,
            session.externalDeclarations,
            session.importedSymbolTypes,
            session.ambientDeclarations
          ),
        }
      );
      return {
        suggestions: items.map((item) => {
          const insert = completionInsertText(item);
          return {
            ...insert,
            label: item.label,
            kind: lspCompletionItemKinds[item.kind ?? 0] ?? completionItemKind.Text,
            detail: item.detail,
            documentation: toMarkdown(item.documentation),
            sortText: item.sortText,
            filterText: item.filterText,
            insertTextRules: insert.insertTextFormat === 2
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            range: completionEditRange(item.textEdit, fallbackRange),
            additionalTextEdits: item.additionalTextEdits?.map(lspEditToMonaco),
          };
        }),
      };
    },
  });
}

function registerRenameProvider(): void {
  monaco.languages.registerRenameProvider("vexa", {
    async resolveRenameLocation(model, position) {
      const reject: monaco.languages.RenameLocation & { rejectReason: string } = {
        range: new monaco.Range(1, 1, 1, 1),
        text: "",
        rejectReason: "Cannot rename this symbol",
      };
      const session = await getSessionForModel(model);
      if (!session.analysis) {
        return reject;
      }
      const prepared = createPrepareRename(
        session.analysis,
        position.lineNumber - 1,
        position.column - 1,
        session.ast ?? undefined
      );
      return normalizePrepareRenameResult(prepared) ?? reject;
    },
    async provideRenameEdits(model, position, newName) {
      const session = await getSessionForModel(model);
      if (!session.analysis || !session.ast) {
        return { edits: [] };
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const edit = await resolveRenameAcrossFiles({
        line: position.lineNumber - 1,
        character: position.column - 1,
        session,
        ...resolverContext(model, workspaceContext),
      }, newName);
      if (!edit) {
        return { edits: [] };
      }
      return workspaceEditToMonaco(edit);
    },
  });
}

function registerCodeActionProvider(): void {
  monaco.languages.registerCodeActionProvider("vexa", {
    async provideCodeActions(model, range, context) {
      const session = await getSessionForModel(model);
      if (!session.ast) {
        return { actions: [], dispose: () => {} };
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const diagnostics = context.markers.map((marker) =>
        markerToDiagnostic(marker, monaco.MarkerSeverity)
      );
      const actions = await collectCodeActions({
        text: model.getValue(),
        ast: session.ast,
        analysis: session.analysis,
        range: toLspRange(range),
        diagnostics,
        ...resolverContext(model, workspaceContext),
      });
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
}

function registerFormattingProviders(): void {
  monaco.languages.registerDocumentFormattingEditProvider("vexa", {
    provideDocumentFormattingEdits(model) {
      return [lspEditToMonaco(createFullDocumentFormatEdit(model.getValue()))];
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider("vexa", {
    provideDocumentRangeFormattingEdits(model, range) {
      return [lspEditToMonaco(createRangeFormatEdit(model.getValue(), toLspRange(range)))];
    },
  });

  monaco.languages.registerOnTypeFormattingEditProvider("vexa", {
    autoFormatTriggerCharacters: ["\n", "}"],
    provideOnTypeFormattingEdits(model, position, character) {
      return createOnTypeFormattingEdits(
        model.getValue(),
        { line: position.lineNumber - 1, character: position.column - 1 },
        character
      ).map(lspEditToMonaco);
    },
  });
}

function hoverContentsToMarkdown(contents: unknown): monaco.IMarkdownString[] {
  const entries = Array.isArray(contents) ? contents : [contents];
  const result: monaco.IMarkdownString[] = [];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if (typeof entry === "string") {
      result.push({ value: `\`\`\`vexa\n${entry}\n\`\`\`` });
      continue;
    }
    if (typeof entry === "object") {
      const record = entry as { kind?: string; value?: string; language?: string };
      if (typeof record.value !== "string") {
        continue;
      }
      if (record.kind === "markdown") {
        result.push({ value: record.value, isTrusted: false });
        continue;
      }
      result.push({ value: `\`\`\`${record.language ?? "vexa"}\n${record.value}\n\`\`\`` });
    }
  }
  return result;
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

function registerHoverProvider(): void {
  monaco.languages.registerHoverProvider("vexa", {
    async provideHover(model, position) {
      const session = await getSessionForModel(model);
      if (!session.analysis || !session.ast) {
        return null;
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const hover = workspaceContext
        ? await resolveMemberHoverAcrossFiles({
            line: position.lineNumber - 1,
            character: position.column - 1,
            session,
            ...resolverContext(model, workspaceContext),
          }) ?? createHover(session.analysis, position.lineNumber - 1, position.column - 1, session.ast ?? undefined)
        : createHover(session.analysis, position.lineNumber - 1, position.column - 1, session.ast ?? undefined);
      if (!hover) {
        return null;
      }
      return {
        contents: hoverContentsToMarkdown(hover.contents),
        range: hover.range ? toMonacoRange(hover.range) : undefined,
      };
    },
  });
}

function registerDefinitionProvider(): void {
  const provideDefinition = async (
    model: monaco.editor.ITextModel,
    position: monaco.IPosition
  ): Promise<monaco.languages.Definition> => {
    const session = await getSessionForModel(model);
    if (!session.analysis || !session.ast) {
      return [];
    }
    const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
    const localLocation = createDefinitionLocation(
      session.analysis,
      model.uri.toString(),
      position.lineNumber - 1,
      position.column - 1,
      session.ast ?? undefined
    );
    if (localLocation) {
      return [{ uri: monaco.Uri.parse(localLocation.uri), range: toMonacoRange(localLocation.range) }];
    }
    const location = workspaceContext
      ? await resolveDefinitionAcrossFiles({
          line: position.lineNumber - 1,
          character: position.column - 1,
          session,
          ...resolverContext(model, workspaceContext),
        })
      : null;
    return location
      ? [{ uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) }]
      : [];
  };

  monaco.languages.registerDefinitionProvider("vexa", {
    provideDefinition,
  });
  monaco.languages.registerDeclarationProvider("vexa", {
    provideDeclaration: provideDefinition,
  });
  monaco.languages.registerTypeDefinitionProvider("vexa", {
    provideTypeDefinition: provideDefinition,
  });
  monaco.languages.registerImplementationProvider("vexa", {
    provideImplementation: provideDefinition,
  });
}

function registerSignatureHelpProvider(): void {
  monaco.languages.registerSignatureHelpProvider("vexa", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position) {
      const session = await getSessionForModel(model);
      if (!session.ast || !session.analysis) {
        return null;
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const help = await createSignatureHelp(
        session.ast,
        session.analysis,
        position.lineNumber - 1,
        position.column - 1,
        resolverContext(model, workspaceContext)
      );
      if (!help) {
        return null;
      }
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
}

function registerReferenceAndHighlightProviders(): void {
  monaco.languages.registerReferenceProvider("vexa", {
    async provideReferences(model, position, context) {
      const session = await getSessionForModel(model);
      if (!session.analysis || !session.ast) {
        return [];
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const locations = workspaceContext
        ? await resolveReferencesAcrossFiles(
            {
              line: position.lineNumber - 1,
              character: position.column - 1,
              session,
              ...resolverContext(model, workspaceContext),
            },
            context.includeDeclaration
          )
        : [];
      return locations.map((location) => ({ uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) }));
    },
  });

  monaco.languages.registerDocumentHighlightProvider("vexa", {
    async provideDocumentHighlights(model, position) {
      const session = await getSessionForModel(model);
      if (!session.analysis) {
        return [];
      }
      return createDocumentHighlights(session.analysis, position.lineNumber - 1, position.column - 1).map((highlight) => ({
        range: toMonacoRange(highlight.range),
        kind: highlight.kind === 2
          ? monaco.languages.DocumentHighlightKind.Write
          : monaco.languages.DocumentHighlightKind.Read,
      }));
    },
  });
}

function registerLinkedEditingProvider(): void {
  monaco.languages.registerLinkedEditingRangeProvider("vexa", {
    async provideLinkedEditingRanges(model, position) {
      const session = await getSessionForModel(model);
      if (!session.analysis) {
        return null;
      }
      const ranges = session.analysis.getRenameRangesAt(position.lineNumber - 1, position.column - 1);
      if (ranges.length <= 1) {
        return null;
      }
      return {
        ranges: ranges.map(toMonacoRange),
        wordPattern: /[A-Za-z_][A-Za-z0-9_]*/,
      };
    },
  });
}

function registerDocumentStructureProviders(): void {
  monaco.languages.registerDocumentSymbolProvider("vexa", {
    async provideDocumentSymbols(model) {
      const session = await getSessionForModel(model);
      if (!session.ast) {
        return [];
      }
      const mapSymbol = (symbol: {
        name: string;
        kind: number;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
        children?: unknown[];
      }): monaco.languages.DocumentSymbol => ({
        name: symbol.name,
        detail: "",
        kind: lspDocumentSymbolKinds[symbol.kind] ?? documentSymbolKind.Variable,
        range: toMonacoRange(symbol.range),
        selectionRange: toMonacoRange(symbol.selectionRange),
        tags: [],
        children: (symbol.children as typeof symbol[] | undefined)?.map(mapSymbol) ?? [],
      });
      return createDocumentSymbols(session.ast).map(mapSymbol);
    },
  });

  monaco.languages.registerFoldingRangeProvider("vexa", {
    async provideFoldingRanges(model) {
      const session = await getSessionForModel(model);
      if (!session.ast) {
        return [];
      }
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

  monaco.languages.registerSelectionRangeProvider("vexa", {
    async provideSelectionRanges(model, positions) {
      const session = await getSessionForModel(model);
      if (!session.ast) {
        return [];
      }
      return createSelectionRanges(
        session.ast,
        positions.map((position) => ({ line: position.lineNumber - 1, character: position.column - 1 }))
      ).map((selectionRange) => {
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
}

function registerInlayHintsProvider(): void {
  monaco.languages.registerInlayHintsProvider("vexa", {
    async provideInlayHints(model, range) {
      const session = await getSessionForModel(model);
      if (!session.ast || !session.analysis) {
        return { hints: [], dispose: () => {} };
      }
      const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
      const hints = await createInlayHints(
        session.ast,
        session.analysis,
        toLspRange(range),
        resolverContext(model, workspaceContext)
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
}

function registerSemanticTokensProviders(): void {
  monaco.languages.registerDocumentSemanticTokensProvider("vexa", {
    getLegend: () => VEXA_SEMANTIC_TOKENS_LEGEND,
    async provideDocumentSemanticTokens(model) {
      const session = await getSessionForModel(model);
      const tokens = createSemanticTokens({
        text: model.getValue(),
        ast: session.ast,
        analysis: session.analysis,
      });
      return tokens?.data ? { data: new Uint32Array(tokens.data) } : null;
    },
    releaseDocumentSemanticTokens: () => {},
  });

  monaco.languages.registerDocumentRangeSemanticTokensProvider("vexa", {
    getLegend: () => VEXA_SEMANTIC_TOKENS_LEGEND,
    async provideDocumentRangeSemanticTokens(model, range) {
      const session = await getSessionForModel(model);
      const tokens = createSemanticTokens({
        text: model.getValue(),
        ast: session.ast,
        analysis: session.analysis,
        range: toLspRange(range),
      });
      return tokens?.data ? { data: new Uint32Array(tokens.data) } : { data: new Uint32Array() };
    },
  });
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== "string") {
    return container;
  }
  const element = document.querySelector<HTMLElement>(container);
  if (!element) {
    throw new Error(`VexaScript editor container not found: ${container}`);
  }
  return element;
}

function bootstrapMonaco(): void {
  if (bootstrapped) {
    return;
  }
  void ensureBundledRuntimeContents();
  registerVexaScript();
  registerCompletionProvider();
  registerHoverProvider();
  registerSignatureHelpProvider();
  registerDefinitionProvider();
  registerReferenceAndHighlightProviders();
  registerRenameProvider();
  registerLinkedEditingProvider();
  registerCodeActionProvider();
  registerFormattingProviders();
  registerDocumentStructureProviders();
  registerInlayHintsProvider();
  registerSemanticTokensProviders();
  monaco.editor.defineTheme(VEXA_MONACO_THEME_NAME, createVexaScriptMonacoTheme());
  monaco.editor.setTheme(VEXA_MONACO_THEME_NAME);
  bootstrapped = true;
}

function setContainerHeight(container: HTMLElement, height?: string): void {
  if (height && !container.style.height) {
    container.style.height = height;
  }
  if (!container.style.width) {
    container.style.width = "100%";
  }
  if (!container.style.minHeight) {
    container.style.minHeight = "320px";
  }
}

function stabilizeEditorLayout(editor: monaco.editor.IStandaloneCodeEditor): void {
  editor.layout();
  window.requestAnimationFrame(() => {
    editor.layout();
    window.requestAnimationFrame(() => editor.layout());
  });
}

function applySelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  selection?: monaco.IRange
): void {
  if (!selection) {
    return;
  }
  editor.setSelection(selection);
  editor.revealRangeInCenter(selection);
}

function applySelectionOrPosition(
  editor: monaco.editor.IStandaloneCodeEditor,
  selectionOrPosition?: monaco.IRange | monaco.IPosition
): void {
  if (!selectionOrPosition) {
    return;
  }
  if ("endLineNumber" in selectionOrPosition) {
    editor.setSelection(selectionOrPosition);
    editor.revealRangeInCenter(selectionOrPosition);
    return;
  }
  editor.setPosition(selectionOrPosition);
  editor.revealPositionInCenter(selectionOrPosition);
}

function shouldTriggerMemberCompletionAfterTyping(
  editor: monaco.editor.IStandaloneCodeEditor,
  typedText: string
): boolean {
  if (!/^[A-Za-z_]$/u.test(typedText)) {
    return false;
  }
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) {
    return false;
  }
  const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  return /(?:\?\.|!\.|\.)(?:\s*[A-Za-z_][A-Za-z0-9_]*)$/u.test(linePrefix);
}

function createFoldersForFiles(files: VexaScriptEmbedFile[]): WorkspaceEntry[] {
  const folderPaths = new Set<string>(["/"]);
  for (const file of files) {
    let current = normalizePath(file.path);
    while (current !== "/") {
      current = dirname(current);
      folderPaths.add(current);
    }
  }
  return [...folderPaths].sort().map((path) => createFolderEntry(path));
}

function createEntries(files: VexaScriptEmbedFile[]): WorkspaceEntry[] {
  const normalizedFiles = files.length > 0
    ? files
    : [{ path: "/main.vx", content: "fun main(): string {\n  return \"Hello from VexaScript\"\n}\n" }];
  const fileEntries = normalizedFiles.map((file) => createFileEntry(file.path, file.content, {
    ...(file.language ? { language: file.language === "typescript" ? "vexa" : file.language } : {}),
    ...(file.readOnly ? { readOnly: true } : {}),
  }));
  return [
    ...createFoldersForFiles(normalizedFiles),
    ...fileEntries,
    ...createBundledRuntimeEntries(),
  ];
}

function normalizeDomSourceForParser(source: string): string {
  return source.replace(/`[^`]*`/g, "string");
}

async function getDomAmbientDeclarations(): Promise<Statement[]> {
  if (cachedDomAmbientDeclarations) {
    return cachedDomAmbientDeclarations;
  }
  const { dom } = await ensureBundledRuntimeContents();
  const parsed = parseSource(normalizeDomSourceForParser(dom), { language: "typescript" });
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : []),
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(`Embedded DOM declarations must parse without errors: ${errors.join("; ")}`);
  }
  cachedDomAmbientDeclarations = parsed.ast.body;
  return cachedDomAmbientDeclarations;
}

function serializeEditableWorkbenchEntries(entries: WorkspaceEntry[]): StoredWorkbenchWorkspaceSnapshot {
  return {
    entries: entries.filter((entry) => !entry.readOnly),
  };
}

function deserializeWorkbenchEntries(snapshotText: string | null): WorkspaceEntry[] | null {
  if (!snapshotText) {
    return null;
  }
  try {
    const parsed = JSON.parse(snapshotText) as Partial<StoredWorkbenchWorkspaceSnapshot>;
    if (!Array.isArray(parsed.entries)) {
      return null;
    }
    const entries: WorkspaceEntry[] = [];
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.label !== "string") {
        continue;
      }
      if (entry.kind === "folder") {
        entries.push(createFolderEntry(entry.path, false));
        continue;
      }
      if (
        entry.kind === "file" &&
        typeof entry.content === "string" &&
        (entry.language === "vexa" || entry.language === "typescript")
      ) {
        entries.push(createFileEntry(entry.path, entry.content, { language: entry.language === "typescript" ? "vexa" : entry.language }));
      }
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

function mapSeverity(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

async function updateDiagnostics(model: monaco.editor.ITextModel): Promise<void> {
  if (model.getLanguageId() !== "vexa") {
    monaco.editor.setModelMarkers(model, "vexa", []);
    return;
  }
  const session = await getSessionForModel(model);
  const workspaceContext = embedWorkspaceContextsByUri.get(model.uri.toString());
  const diagnostics = await collectWorkspaceDiagnostics(model, session, workspaceContext);
  monaco.editor.setModelMarkers(
    model,
    "vexa",
    diagnostics.map((diagnostic) => ({
      severity: mapSeverity(diagnostic.severity),
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      message: diagnostic.message,
      code: String(diagnostic.code ?? ""),
      source: diagnostic.source ?? "vexa",
    }))
  );
}

async function updateAutoAwaitGlyphs(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel
): Promise<void> {
  const refreshVersion = (autoAwaitGlyphRefreshVersions.get(editor) ?? 0) + 1;
  autoAwaitGlyphRefreshVersions.set(editor, refreshVersion);
  let collection = autoAwaitGlyphCollections.get(editor);
  if (!collection) {
    collection = editor.createDecorationsCollection();
    autoAwaitGlyphCollections.set(editor, collection);
  }
  if (model.getLanguageId() !== "vexa") {
    collection.clear();
    return;
  }
  const session = await getSessionForModel(model);
  if (autoAwaitGlyphRefreshVersions.get(editor) !== refreshVersion) {
    return;
  }
  if (editor.getModel() !== model || model.isDisposed()) {
    return;
  }
  if (!session.ast || !session.analysis) {
    collection.clear();
    return;
  }
  collection.set(createAutoAwaitDecorations(session.ast, session.analysis).map((decoration) => ({
    range: {
      startLineNumber: decoration.range.start.line + 1,
      startColumn: decoration.range.start.character + 1,
      endLineNumber: decoration.range.end.line + 1,
      endColumn: decoration.range.end.character + 1,
    },
    options: {
      glyphMarginClassName: "vexa-auto-await-glyph",
      glyphMarginHoverMessage: { value: decoration.message },
    },
  })));
  editor.render(true);
}

function refreshDiagnosticsAndGlyphs(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  reason: string
): void {
  if (!embeddedRuntimeReady) {
    const refreshKey = model.uri.toString();
    if (!pendingRuntimeReadyRefreshes.has(refreshKey)) {
      pendingRuntimeReadyRefreshes.set(
        refreshKey,
        ensureEmbeddedRuntimeReady()
          .then(() => {
            pendingRuntimeReadyRefreshes.delete(refreshKey);
            if (model.isDisposed()) {
              return;
            }
            refreshDiagnosticsAndGlyphs(editor, model, `${reason}-runtime-ready`);
          })
          .catch((error) => {
            pendingRuntimeReadyRefreshes.delete(refreshKey);
            console.error("[vexa-embed:runtime-ready]", error);
          })
      );
    }
    return;
  }
  logDiagnosticsRefresh(reason, model);
  void updateDiagnostics(model);
  if (editor.getModel() !== model) {
    return;
  }
  void updateAutoAwaitGlyphs(editor, model);
}

function schedulePostLayoutDiagnosticsRefresh(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  reason = "post-layout"
): void {
  window.requestAnimationFrame(() => {
    refreshDiagnosticsAndGlyphs(editor, model, reason);
  });
}

function wireDiagnostics(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel
): () => void {
  let timer: number | undefined;
  const refresh = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      refreshDiagnosticsAndGlyphs(editor, model, "content-change");
    }, 100);
  };
  const changeDisposable = model.onDidChangeContent(refresh);
  refresh();
  schedulePostLayoutDiagnosticsRefresh(editor, model, "wire-init-post-layout");
  return () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    autoAwaitGlyphCollections.get(editor)?.clear();
    changeDisposable.dispose();
  };
}

function createEditor(
  container: HTMLElement,
  model: monaco.editor.ITextModel,
  readOnly: boolean,
  options: { inlayHints?: boolean } = {}
): monaco.editor.IStandaloneCodeEditor {
  ensureAutoAwaitGlyphStyle();
  const editor = monaco.editor.create(container, {
    model,
    theme: VEXA_MONACO_THEME_NAME,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: "on",
    lineNumbersMinChars: 2,
    lineDecorationsWidth: 12,
    scrollBeyondLastLine: false,
    wordWrap: "off",
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: "selection",
    readOnly,
    scrollbar: { vertical: "visible", horizontal: "visible", alwaysConsumeMouseWheel: false },
    glyphMargin: true,
    inlayHints: { enabled: options.inlayHints ? "on" : "off" },
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
    "semanticHighlighting.enabled": true,
    bracketPairColorization: { enabled: true },
  });
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F6, () => {
    void editor.getAction("editor.action.rename")?.run();
  });
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
    void editor.getAction("editor.action.quickFix")?.run();
  });
  editor.onKeyDown((event) => {
    if (event.altKey && event.keyCode === monaco.KeyCode.Enter) {
      event.preventDefault();
      event.stopPropagation();
      void editor.getAction("editor.action.quickFix")?.run();
    }
  });
  editor.onDidType((typedText) => {
    if (!shouldTriggerMemberCompletionAfterTyping(editor, typedText)) {
      return;
    }
    void Promise.resolve().then(() => {
      editor.trigger("vexa", "editor.action.triggerSuggest", {});
    });
  });
  return editor;
}

function createSimpleEditor(container: HTMLElement | string, options: SimpleEditorOptions): EditorHandle {
  bootstrapMonaco();
  const target = resolveContainer(container);
  setContainerHeight(target, options.height ?? "360px");
  const path = normalizePath(options.path ?? `/snippet-${++modelCounter}.vx`);
  const model = monaco.editor.createModel(options.content, "vexa", monaco.Uri.parse(pathToUri(path)));
  const editor = createEditor(target, model, options.readOnly ?? false, { inlayHints: options.inlayHints });
  const disposeDiagnostics = wireDiagnostics(editor, model);
  applySelection(editor, options.selection);
  stabilizeEditorLayout(editor);
  return {
    editor,
    getValue: () => model.getValue(),
    setValue: (content) => model.setValue(content),
    dispose() {
      disposeDiagnostics();
      editor.dispose();
      model.dispose();
    },
  };
}

function createTabButton(
  entry: WorkspaceFile,
  activeUri: string,
  onSelect: (entry: WorkspaceFile) => void,
  options: { dirty?: boolean } = {}
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vexa-embed-tab${entry.uri === activeUri ? " is-active" : ""}`;
  button.textContent = `${basename(entry.path)}${options.dirty ? " *" : ""}`;
  button.addEventListener("click", () => onSelect(entry));
  return button;
}

function createTabbedEditor(container: HTMLElement | string, options: WorkspaceEditorOptions): TabbedEditorHandle {
  bootstrapMonaco();
  const target = resolveContainer(container);
  target.classList.add("vexa-embed-workspace");
  target.textContent = "";
  setContainerHeight(target, options.height ?? "520px");

  const tabBar = document.createElement("div");
  tabBar.className = "vexa-embed-tabs";
  const editorHost = document.createElement("div");
  editorHost.className = "vexa-embed-editor";
  target.append(tabBar, editorHost);

  const entries = createEntries(options.files);
  const editableFiles = entries.filter((entry): entry is WorkspaceFile => entry.kind === "file" && entry.language === "vexa" && !entry.readOnly);
  const activeEntry = editableFiles.find((entry) => entry.path === normalizePath(options.activePath ?? "")) ?? editableFiles[0];
  if (!activeEntry) {
    throw new Error("VexaScript workspace editor needs at least one editable VexaScript file.");
  }

  const models = new Map<string, monaco.editor.ITextModel>();
  const disposers = new Map<string, () => void>();
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  const ensureModel = (entry: WorkspaceFile): monaco.editor.ITextModel => {
    const existing = models.get(entry.uri);
    if (existing) {
      return existing;
    }
    const model = monaco.editor.createModel(entry.content, entry.language, monaco.Uri.parse(entry.uri));
    models.set(entry.uri, model);
    if (editor) {
      disposers.set(entry.uri, wireDiagnostics(editor, model));
    }
    return model;
  };

  let activeModel = ensureModel(activeEntry);
  editor = createEditor(editorHost, activeModel, false, { inlayHints: options.inlayHints });
  for (const [uri, model] of models.entries()) {
    disposers.set(uri, wireDiagnostics(editor, model));
  }
  applySelection(editor, options.selection);
  stabilizeEditorLayout(editor);

  const renderTabs = (): void => {
    tabBar.textContent = "";
    for (const entry of editableFiles) {
      tabBar.appendChild(createTabButton(entry, activeModel.uri.toString(), (nextEntry) => {
        activeModel = ensureModel(nextEntry);
        editor.setModel(activeModel);
        applySelection(editor, nextEntry.path === activeEntry.path ? options.selection : undefined);
        stabilizeEditorLayout(editor);
        renderTabs();
        updateDiagnostics(activeModel);
        updateAutoAwaitGlyphs(editor, activeModel);
      }));
    }
  };

  renderTabs();
  void updateDiagnostics(activeModel);
  void updateAutoAwaitGlyphs(editor, activeModel);

  return {
    editor,
    openFile(path: string, selection?: monaco.IRange) {
      const nextEntry = editableFiles.find((entry) => entry.path === normalizePath(path));
      if (!nextEntry) {
        throw new Error(`VexaScript workspace file not found: ${path}`);
      }
      activeModel = ensureModel(nextEntry);
      editor.setModel(activeModel);
      applySelection(editor, selection);
      stabilizeEditorLayout(editor);
      renderTabs();
        void updateDiagnostics(activeModel);
        void updateAutoAwaitGlyphs(editor, activeModel);
    },
    getValue(path?: string) {
      if (!path) {
        return activeModel.getValue();
      }
      return models.get(pathToUri(path))?.getValue() ?? "";
    },
    setValue(content: string, path?: string) {
      const uri = path ? pathToUri(path) : activeModel.uri.toString();
      const model = models.get(uri) ?? activeModel;
      model.setValue(content);
    },
    dispose() {
      for (const dispose of disposers.values()) {
        dispose();
      }
      editor.dispose();
      for (const model of models.values()) {
        model.dispose();
      }
    },
  };
}

function createWorkspaceEditor(container: HTMLElement | string, options: WorkspaceEditorOptions): EditorHandle {
  return createTabbedEditor(container, options);
}

function createWorkbenchEditor(container: HTMLElement | string, options: WorkbenchEditorOptions): WorkbenchEditorHandle {
  bootstrapMonaco();
  const target = resolveContainer(container);
  target.classList.add("vexa-embed-workbench");
  target.textContent = "";
  setContainerHeight(target, options.height ?? "720px");

  const shell = document.createElement("div");
  shell.className = "vexa-embed-workbench-shell";
  shell.innerHTML = `
    <div class="vexa-embed-workbench-header">
      <div class="vexa-embed-workbench-title-group">
        <div class="vexa-embed-workbench-title">VexaScript ${COMPILER_VERSION}</div>
        <div class="vexa-embed-workbench-file-name">main.vx</div>
      </div>
      <div class="vexa-embed-workbench-toolbar">
        <button type="button" class="vexa-embed-toolbar-button vexa-embed-toolbar-button-icon-only" data-action="back" title="Back" aria-label="Back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
        <button type="button" class="vexa-embed-toolbar-button vexa-embed-toolbar-button-icon-only" data-action="forward" title="Forward" aria-label="Forward"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <button type="button" class="vexa-embed-toolbar-button vexa-embed-toolbar-button-icon-only" data-action="save" title="Save" aria-label="Save"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i></button>
        <button type="button" class="vexa-embed-toolbar-button vexa-embed-toolbar-button-icon-only" data-action="run" title="Run" aria-label="Run"><i class="fa-solid fa-play" aria-hidden="true"></i></button>
        <button type="button" class="vexa-embed-toolbar-button vexa-embed-toolbar-button-icon-only" data-action="expand" title="Expand" aria-label="Expand"><i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i></button>
        <button type="button" class="vexa-embed-toolbar-button vexa-embed-toolbar-button-icon-only" data-action="more" title="More actions" aria-label="More actions"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>
        <div class="vexa-embed-workbench-toolbar-menu" hidden>
          <button type="button" data-action="menu-format">Format document</button>
          <button type="button" data-action="menu-toggle-inlay-hints">Disable inlay hints</button>
          <button type="button" data-action="menu-reset-workspace">Reset workspace</button>
        </div>
      </div>
    </div>
    <div class="vexa-embed-workbench-tabs"></div>
    <div class="vexa-embed-workbench-body">
      <aside class="vexa-embed-workbench-sidebar">
        <div class="vexa-embed-workbench-sidebar-header">
          <div class="vexa-embed-workbench-sidebar-title">Workspace</div>
          <div class="vexa-embed-workbench-sidebar-actions">
            <button type="button" class="vexa-embed-toolbar-icon" data-action="new-file">+</button>
            <button type="button" class="vexa-embed-toolbar-icon" data-action="new-folder">#</button>
          </div>
        </div>
        <div class="vexa-embed-workbench-tree"></div>
        <div class="vexa-embed-tree-context-menu" hidden>
          <button type="button" data-action="context-new-file">New file</button>
          <button type="button" data-action="context-new-folder">New folder</button>
          <button type="button" data-action="context-delete">Delete</button>
        </div>
      </aside>
      <div class="vexa-embed-workbench-editor-pane">
        <button
          type="button"
          class="vexa-embed-toolbar-button vexa-embed-workbench-sidebar-toggle"
          data-action="toggle-sidebar"
          aria-expanded="false"
          aria-label="Show workspace"
        >Show workspace</button>
        <div class="vexa-embed-workbench-sidebar-backdrop" data-action="sidebar-backdrop" hidden></div>
        <div class="vexa-embed-workbench-editor"></div>
      </div>
      <aside class="vexa-embed-workbench-runner">
        <div class="vexa-embed-workbench-runner-header">
          <div class="vexa-embed-workbench-runner-title">Preview</div>
          <button type="button" class="vexa-embed-toolbar-button" data-action="clear-output">Clear</button>
        </div>
        <iframe class="vexa-embed-workbench-preview" title="VexaScript preview" sandbox="allow-scripts allow-modals"></iframe>
      </aside>
    </div>
  `;
  target.appendChild(shell);

  const entriesStorageKey = options.storageKey ?? DEFAULT_WORKBENCH_STORAGE_KEY;
  const sessionStorageKey = options.sessionStorageKey ?? DEFAULT_WORKBENCH_SESSION_STORAGE_KEY;
  const allowWorkspaceWrites = options.allowWorkspaceWrites ?? true;
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })();

  const createInitialWorkbenchEntries = (): WorkspaceEntry[] => createEntries(options.files);
  const initialEditableEntries = createInitialWorkbenchEntries().filter(
    (entry) =>
      entry.path !== "/runtime"
      && entry.path !== "/runtime/es2025.d.ts"
      && entry.path !== "/runtime/vexascript.d.vx"
      && entry.path !== "/runtime/dom.d.ts"
  );
  const initialWorkbenchSnapshot = JSON.stringify(
    serializeEditableWorkbenchEntries(initialEditableEntries)
  );
  let entries = [
    ...((allowWorkspaceWrites
      ? deserializeWorkbenchEntries(storage?.getItem(entriesStorageKey) ?? null)
      : null) ?? initialEditableEntries),
    ...createBundledRuntimeEntries(),
  ];

  const editableFiles = (): WorkspaceFile[] =>
    entries.filter((entry): entry is WorkspaceFile => entry.kind === "file" && !entry.readOnly);
  const sidebarTree = shell.querySelector<HTMLElement>(".vexa-embed-workbench-tree")!;
  const treeContextMenu = shell.querySelector<HTMLElement>(".vexa-embed-tree-context-menu")!;
  const tabBar = shell.querySelector<HTMLElement>(".vexa-embed-workbench-tabs")!;
  const body = shell.querySelector<HTMLElement>(".vexa-embed-workbench-body")!;
  const sidebar = shell.querySelector<HTMLElement>(".vexa-embed-workbench-sidebar")!;
  const editorHost = shell.querySelector<HTMLElement>(".vexa-embed-workbench-editor")!;
  const sidebarToggleButton = shell.querySelector<HTMLButtonElement>('[data-action="toggle-sidebar"]')!;
  const sidebarBackdrop = shell.querySelector<HTMLElement>('[data-action="sidebar-backdrop"]')!;
  const fileNameLabel = shell.querySelector<HTMLElement>(".vexa-embed-workbench-file-name")!;
  const newFileToolbarButton = shell.querySelector<HTMLButtonElement>('[data-action="new-file"]')!;
  const newFolderToolbarButton = shell.querySelector<HTMLButtonElement>('[data-action="new-folder"]')!;
  const backButton = shell.querySelector<HTMLButtonElement>('[data-action="back"]')!;
  const forwardButton = shell.querySelector<HTMLButtonElement>('[data-action="forward"]')!;
  const saveButton = shell.querySelector<HTMLButtonElement>('[data-action="save"]')!;
  const runButton = shell.querySelector<HTMLButtonElement>('[data-action="run"]')!;
  const expandButton = shell.querySelector<HTMLButtonElement>('[data-action="expand"]')!;
  const moreActionsButton = shell.querySelector<HTMLButtonElement>('[data-action="more"]')!;
  const toolbarMenu = shell.querySelector<HTMLElement>(".vexa-embed-workbench-toolbar-menu")!;
  const menuFormatButton = shell.querySelector<HTMLButtonElement>('[data-action="menu-format"]')!;
  const menuToggleInlayHintsButton = shell.querySelector<HTMLButtonElement>('[data-action="menu-toggle-inlay-hints"]')!;
  const menuResetWorkspaceButton = shell.querySelector<HTMLButtonElement>('[data-action="menu-reset-workspace"]')!;
  const clearOutputButton = shell.querySelector<HTMLButtonElement>('[data-action="clear-output"]')!;
  const contextNewFileButton = shell.querySelector<HTMLButtonElement>('[data-action="context-new-file"]')!;
  const contextNewFolderButton = shell.querySelector<HTMLButtonElement>('[data-action="context-new-folder"]')!;
  const contextDeleteButton = shell.querySelector<HTMLButtonElement>('[data-action="context-delete"]')!;
  const previewFrame = shell.querySelector<HTMLIFrameElement>(".vexa-embed-workbench-preview")!;

  const models = new Map<string, monaco.editor.ITextModel>();
  const disposers = new Map<string, () => void>();
  const contentListeners = new Map<string, monaco.IDisposable>();
  const collapsedFolders = new Set<string>();
  let workspaceRevision = 0;
  let activeUri = pathToUri(normalizePath(options.activePath ?? editableFiles()[0]?.path ?? "/main.vx"));
  const workbenchHistoryId = `vexa-workbench:${entriesStorageKey}`;
  let browserHistorySnapshot = readWorkbenchBrowserHistorySnapshot(window.history.state, workbenchHistoryId)
    ?? createWorkbenchBrowserHistorySnapshot(activeUri);
  let selectedPath = normalizePath(dirname(options.activePath ?? editableFiles()[0]?.path ?? "/main.vx"));
  let contextMenuEntry: WorkspaceEntry | null = null;
  const previewChannelId = `vexa-preview-${Math.random().toString(36).slice(2)}`;
  let savedSnapshot = JSON.stringify(serializeEditableWorkbenchEntries(entries));
  const initialInlayHintsEnabled = (() => {
    const storedValue = storage?.getItem(inlayHintsStorageKey(entriesStorageKey));
    if (storedValue === "true") {
      return true;
    }
    if (storedValue === "false") {
      return false;
    }
    return options.inlayHints ?? false;
  })();
  let inlayHintsEnabled = initialInlayHintsEnabled;
  let sidebarState: WorkbenchSidebarState = { compact: false, open: true };
  let toolbarMenuOpen = false;

  const ensureModel = (entry: WorkspaceFile): monaco.editor.ITextModel => {
    const existing = models.get(entry.uri);
    if (existing) {
      return existing;
    }
    const model = monaco.editor.createModel(entry.content, entry.language, monaco.Uri.parse(entry.uri));
    models.set(entry.uri, model);
    return model;
  };

  const getWorkspaceFileSource = (uri: string): string | null => {
    const model = models.get(uri) ?? monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) {
      return model.getValue();
    }
    const entry = entries.find((candidate) => candidate.kind === "file" && candidate.uri === uri);
    return entry?.kind === "file" ? entry.content : null;
  };

  const workspaceVfs = new WorkspaceVfs({
    getEntries: () => entries,
    readWorkspaceFile: (uri) => getWorkspaceFileSource(uri),
  });

  const getWorkspaceSessionForFilePath = async (filePath: string): Promise<ReturnType<typeof createAnalysisSession> | null> => {
    const uri = pathToUri(filePath);
    const source = getWorkspaceFileSource(uri);
    if (source === null) {
      return null;
    }
    return isRuntimeDeclarationPath(filePath)
      ? createAnalysisSession(source)
      : createAnalysisSession(source, [], new Map(), await getDomAmbientDeclarations());
  };

  const getWorkspaceExportedSymbols = async (): Promise<SymbolExport[]> => {
    const symbols: SymbolExport[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file" || entry.language !== "vexa") {
        continue;
      }
      const session = await getWorkspaceSessionForFilePath(entry.path);
      for (const declaration of collectTopLevelDeclarationsFromAst(session?.ast ?? null)) {
        symbols.push({
          name: declaration.name,
          kind: declaration.kind,
          filePath: entry.path,
          ...(declaration.receiverType ? { receiverType: declaration.receiverType } : {}),
          ...(declaration.memberKind ? { memberKind: declaration.memberKind } : {}),
        });
      }
    }
    return symbols;
  };

  const workspaceContext: EmbedWorkspaceContext = {
    vfs: workspaceVfs,
    getSessionForFilePath: getWorkspaceSessionForFilePath,
    getExportedSymbols: getWorkspaceExportedSymbols,
    getRevision: () => workspaceRevision,
  };

  const initialEntry = editableFiles().find((entry) => entry.uri === activeUri) ?? editableFiles()[0];
  if (!initialEntry) {
    throw new Error("VexaScript workbench editor needs at least one editable file.");
  }
  const editor = createEditor(editorHost, ensureModel(initialEntry), !allowWorkspaceWrites, { inlayHints: inlayHintsEnabled });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    persist();
    refreshToolbarState();
  });
  editor.onKeyDown((event) => {
    if ((event.metaKey || event.ctrlKey) && event.keyCode === monaco.KeyCode.KeyS) {
      event.preventDefault();
      event.stopPropagation();
      persist();
      refreshToolbarState();
    }
  });
  const bindEditableModel = (entry: WorkspaceFile): monaco.editor.ITextModel => {
    const model = ensureModel(entry);
    const hadWorkspaceContext = embedWorkspaceContextsByUri.has(entry.uri);
    embedWorkspaceContextsByUri.set(entry.uri, workspaceContext);
    if (!disposers.has(entry.uri)) {
      disposers.set(entry.uri, wireDiagnostics(editor, model));
    }
    if (!contentListeners.has(entry.uri)) {
      contentListeners.set(entry.uri, model.onDidChangeContent(() => {
        syncEntryContent(entry.uri, model.getValue());
        renderTabs();
        refreshToolbarState();
        renderTree();
      }));
    }
    if (!hadWorkspaceContext) {
      refreshDiagnosticsAndGlyphs(editor, model, "workspace-context-attached");
      schedulePostLayoutDiagnosticsRefresh(editor, model, "workspace-context-post-layout");
    }
    return model;
  };
  for (const entry of editableFiles()) {
    bindEditableModel(entry);
  }

  const persist = (): void => {
    if (!allowWorkspaceWrites) {
      return;
    }
    storage?.setItem(entriesStorageKey, JSON.stringify(serializeEditableWorkbenchEntries(entries)));
    savedSnapshot = JSON.stringify(serializeEditableWorkbenchEntries(entries));
    const position = editor.getPosition();
    if (position) {
      storage?.setItem(sessionStorageKey, JSON.stringify({
        activeUri,
        lineNumber: position.lineNumber,
        column: position.column,
      }));
    }
    renderTabs();
  };

  const isDirty = (): boolean => JSON.stringify(serializeEditableWorkbenchEntries(entries)) !== savedSnapshot;

  const isEntryDirty = (entry: WorkspaceFile): boolean => {
    const saved = deserializeWorkbenchEntries(savedSnapshot)?.find((savedEntry): savedEntry is WorkspaceFile =>
      savedEntry.kind === "file" && savedEntry.uri === entry.uri
    );
    if (!saved) {
      return true;
    }
    return saved.content !== (models.get(entry.uri)?.getValue() ?? entry.content);
  };

  const isExpanded = (): boolean => target.classList.contains("is-expanded");

  const applySidebarState = (): void => {
    body.classList.toggle("is-compact", sidebarState.compact);
    body.classList.toggle("is-sidebar-open", sidebarState.open);
    sidebarToggleButton.hidden = !sidebarState.compact;
    sidebarToggleButton.textContent = workbenchSidebarToggleLabel(sidebarState);
    sidebarToggleButton.setAttribute("aria-label", workbenchSidebarToggleLabel(sidebarState));
    sidebarToggleButton.setAttribute("aria-expanded", String(sidebarState.open));
    sidebarBackdrop.hidden = !(sidebarState.compact && sidebarState.open);
    sidebar.setAttribute("aria-hidden", String(sidebarState.compact && !sidebarState.open));
  };

  const syncExpandButton = (): void => {
    expandButton.title = isExpanded() ? "Collapse" : "Expand";
    expandButton.setAttribute("aria-label", isExpanded() ? "Collapse" : "Expand");
    expandButton.innerHTML = isExpanded()
      ? '<i class="fa-solid fa-down-left-and-up-right-to-center" aria-hidden="true"></i>'
      : '<i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>';
  };

  const syncInlayHintsButton = (): void => {
    menuToggleInlayHintsButton.textContent = inlayHintsEnabled ? "Disable inlay hints" : "Enable inlay hints";
  };

  const hideToolbarMenu = (): void => {
    toolbarMenu.hidden = true;
    toolbarMenuOpen = false;
    moreActionsButton.setAttribute("aria-expanded", "false");
  };

  const showToolbarMenu = (): void => {
    toolbarMenu.hidden = false;
    toolbarMenuOpen = true;
    moreActionsButton.setAttribute("aria-expanded", "true");
  };

  const applyInlayHintsPreference = (): void => {
    editor.updateOptions({
      inlayHints: { enabled: inlayHintsEnabled ? "on" : "off" },
    });
    storage?.setItem(inlayHintsStorageKey(entriesStorageKey), String(inlayHintsEnabled));
    syncInlayHintsButton();
    stabilizeEditorLayout(editor);
    editor.render(true);
  };

  const syncEntryContent = (uri: string, content: string): void => {
    entries = updateFileContent(entries, uri, content);
    modelSessionCache.delete(uri);
    workspaceRevision += 1;
  };

  const refreshBundledRuntimeEntries = async (): Promise<void> => {
    const { runtime, vexa, dom } = await ensureBundledRuntimeContents();
    for (const [path, content] of [
      ["/runtime/es2025.d.ts", runtime],
      ["/runtime/vexascript.d.vx", vexa],
      ["/runtime/dom.d.ts", dom],
    ] as const) {
      const uri = pathToUri(path);
      const existingEntry = entries.find((entry): entry is WorkspaceFile => entry.kind === "file" && entry.path === path);
      if (!existingEntry || existingEntry.content === content) {
        continue;
      }
      entries = updateFileContent(entries, uri, content);
      modelSessionCache.delete(uri);
      workspaceRevision += 1;
      const model = models.get(uri);
      if (model && model.getValue() !== content) {
        model.setValue(content);
      }
    }
    renderTree();
  };

  const postPreviewConsoleCommand = (command: "clear"): void => {
    previewFrame.contentWindow?.postMessage({
      type: "vexa-preview-console-command",
      channelId: previewChannelId,
      command,
    }, "*");
  };

  const clearOutput = (): void => {
    postPreviewConsoleCommand("clear");
  };

  const hideTreeContextMenu = (): void => {
    treeContextMenu.hidden = true;
    contextMenuEntry = null;
  };

  const showTreeContextMenu = (entry: WorkspaceEntry, event: MouseEvent): void => {
    contextMenuEntry = entry;
    selectedPath = entry.path;
    renderTree();
    contextNewFileButton.hidden = !allowWorkspaceWrites || entry.kind !== "folder" || !!entry.readOnly;
    contextNewFolderButton.hidden = !allowWorkspaceWrites || entry.kind !== "folder" || !!entry.readOnly;
    contextDeleteButton.disabled = !allowWorkspaceWrites || !!entry.readOnly || entry.path === "/";
    treeContextMenu.hidden = false;
    treeContextMenu.style.left = `${event.clientX}px`;
    treeContextMenu.style.top = `${event.clientY}px`;
  };

  const runCurrentWorkspace = async (): Promise<void> => {
    clearOutput();
    const activeEntry = entries.find((entry): entry is WorkspaceFile => entry.kind === "file" && entry.uri === activeUri);
    if (!activeEntry) {
      previewFrame.srcdoc = buildPreviewDocument("", previewChannelId);
      postPreviewConsoleCommand("clear");
      return;
    }
    runButton.disabled = true;
    try {
      await ensureEmbeddedRuntimeReady();
      const result = await bundleModuleGraph(activeEntry.path, "optimized", {
        vfs: workspaceVfs,
        ambientDeclarations: await getDomAmbientDeclarations(),
      });
      if (result.errors.length > 0) {
        const seenMessages = new Set<string>();
        for (const diagnostic of result.diagnostics) {
          const message = `${diagnostic.message} at ${diagnostic.line}:${diagnostic.column}`;
          if (seenMessages.has(message)) {
            continue;
          }
          seenMessages.add(message);
        }
        if (seenMessages.size === 0) {
          for (const error of result.errors) {
            if (seenMessages.has(error)) {
              continue;
            }
            seenMessages.add(error);
          }
        }
        previewFrame.srcdoc = buildPreviewDocument(`console.error(${JSON.stringify([...seenMessages].join("\\n"))});`, previewChannelId);
        return;
      }
      if (result.diagnostics.length > 0) {
        const diagnosticsScript = result.diagnostics
          .map((diagnostic) => `console.warn(${JSON.stringify(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`)});`)
          .join("\n");
        previewFrame.srcdoc = buildPreviewDocument(`${diagnosticsScript}\n${result.code}`, previewChannelId);
        return;
      }
      previewFrame.srcdoc = buildPreviewDocument(result.code, previewChannelId);
    } catch (error) {
      previewFrame.srcdoc = buildPreviewDocument(`console.error(${JSON.stringify(error instanceof Error ? error.stack || error.message : String(error))});`, previewChannelId);
    } finally {
      runButton.disabled = false;
    }
  };

  const renderTree = (): void => {
    sidebarTree.textContent = "";
    const renderFolder = (folderPath: string, depth: number): void => {
      for (const entry of listChildren(entries, folderPath)) {
        const row = document.createElement("div");
        row.className = `vexa-embed-tree-row${entry.path === selectedPath ? " is-selected" : ""}${entry.uri === activeUri ? " is-active" : ""}`;
        row.style.paddingLeft = `${12 + depth * 16}px`;
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          showTreeContextMenu(entry, event);
        });

        if (entry.kind === "folder") {
          const disclosure = document.createElement("button");
          disclosure.type = "button";
          disclosure.className = "vexa-embed-tree-disclosure";
          disclosure.textContent = collapsedFolders.has(entry.path) ? "▸" : "▾";
          disclosure.title = collapsedFolders.has(entry.path) ? "Expand folder" : "Collapse folder";
          disclosure.addEventListener("click", (event) => {
            event.stopPropagation();
            if (collapsedFolders.has(entry.path)) {
              collapsedFolders.delete(entry.path);
            } else {
              collapsedFolders.add(entry.path);
            }
            renderTree();
          });
          row.appendChild(disclosure);
        } else {
          const spacer = document.createElement("span");
          spacer.className = "vexa-embed-tree-spacer";
          row.appendChild(spacer);
        }

        const item = document.createElement("button");
        item.type = "button";
        item.className = "vexa-embed-tree-item";
        item.textContent = entry.label;
        item.addEventListener("click", () => {
          selectedPath = entry.path;
          if (entry.kind === "file") {
            openFile(entry.path);
            return;
          }
          renderTree();
        });
        row.appendChild(item);
        sidebarTree.appendChild(row);

        if (entry.kind === "folder" && !collapsedFolders.has(entry.path)) {
          renderFolder(entry.path, depth + 1);
        }
      }
    };
    renderFolder("/", 0);
  };

  const renderTabs = (): void => {
    tabBar.textContent = "";
    for (const entry of editableFiles()) {
      tabBar.appendChild(createTabButton(
        entry,
        activeUri,
        (nextEntry) => {
          openFile(nextEntry.path);
        },
        { dirty: isEntryDirty(entry) }
      ));
    }
  };

  const refreshToolbarState = (): void => {
    backButton.disabled = browserHistorySnapshot.back.length === 0;
    forwardButton.disabled = browserHistorySnapshot.forward.length === 0;
    const activeEntry = entries.find((entry) => entry.uri === activeUri);
    fileNameLabel.textContent = activeEntry?.kind === "file" && isEntryDirty(activeEntry) ? `${activeEntry.label} *` : activeEntry?.label ?? "No file";
    const canFormat = !!allowWorkspaceWrites && activeEntry?.kind === "file" && activeEntry.language === "vexa" && !activeEntry.readOnly;
    saveButton.disabled = !allowWorkspaceWrites || !isDirty();
    newFileToolbarButton.disabled = !allowWorkspaceWrites;
    newFolderToolbarButton.disabled = !allowWorkspaceWrites;
    runButton.disabled = activeEntry?.kind !== "file" || activeEntry.language !== "vexa";
    menuFormatButton.disabled = !canFormat;
    menuResetWorkspaceButton.disabled = !allowWorkspaceWrites;
    syncInlayHintsButton();
  };

  const openFile = (
    path: string,
    selectionOrPosition?: monaco.IRange | monaco.IPosition,
    trackHistory = true
  ): void => {
    const entry = entries.find((candidate): candidate is WorkspaceFile => candidate.kind === "file" && candidate.path === normalizePath(path));
    if (!entry) {
      throw new Error(`VexaScript workbench file not found: ${path}`);
    }
    if (trackHistory && activeUri !== entry.uri) {
      browserHistorySnapshot = pushWorkbenchBrowserHistorySnapshot(browserHistorySnapshot, entry.uri);
      window.history.pushState(
        writeWorkbenchBrowserHistorySnapshot(window.history.state, workbenchHistoryId, browserHistorySnapshot),
        "",
        window.location.href
      );
    }
    activeUri = entry.uri;
    selectedPath = entry.path;
    hideTreeContextMenu();
    hideToolbarMenu();
    const model = entry.readOnly ? ensureModel(entry) : bindEditableModel(entry);
    editor.setModel(model);
    editor.updateOptions({ readOnly: !allowWorkspaceWrites || !!entry.readOnly });
  applySelectionOrPosition(
      editor,
      selectionOrPosition ?? (entry.path === normalizePath(options.activePath ?? "") ? options.selection : undefined)
    );
    stabilizeEditorLayout(editor);
    refreshDiagnosticsAndGlyphs(editor, model, "open-file");
    schedulePostLayoutDiagnosticsRefresh(editor, model, "open-file-post-layout");
    renderTabs();
    renderTree();
    refreshToolbarState();
    if (sidebarState.compact && sidebarState.open) {
      sidebarState = { ...sidebarState, open: false };
      applySidebarState();
      stabilizeEditorLayout(editor);
    }
  };

  const createFolderAtPath = (parentFolderPath: string): void => {
    if (!allowWorkspaceWrites) {
      return;
    }
    const name = window.prompt("New folder name", "newFolder");
    if (!name) {
      return;
    }
    entries = createFolderInWorkspace(entries, parentFolderPath, name);
    const createdPath = normalizePath(parentFolderPath === "/" ? `/${name.trim()}` : `${parentFolderPath}/${name.trim()}`);
    collapsedFolders.delete(parentFolderPath);
    selectedPath = createdPath;
    renderTree();
    refreshToolbarState();
  };

  const deleteEntry = (entry: WorkspaceEntry): void => {
    if (!allowWorkspaceWrites) {
      return;
    }
    const confirmed = window.confirm(
      entry.kind === "folder"
        ? `Delete folder "${entry.label}" and all its contents?`
        : `Delete file "${entry.label}"?`
    );
    if (!confirmed) {
      return;
    }
    const previousEntries = entries;
    entries = deleteWorkspaceEntry(entries, entry.path);
    if (entries.some((candidate) => candidate.path === entry.path)) {
      return;
    }
    workspaceRevision += 1;
    const deletedPrefix = `${entry.path}/`;
    for (const [uri, model] of models.entries()) {
      const candidate = previousEntries.find((workspaceEntry) => workspaceEntry.kind === "file" && workspaceEntry.uri === uri);
      if (!candidate || (candidate.path !== entry.path && !candidate.path.startsWith(deletedPrefix))) {
        continue;
      }
      embedWorkspaceContextsByUri.delete(uri);
      modelSessionCache.delete(uri);
      disposers.get(uri)?.();
      disposers.delete(uri);
      contentListeners.get(uri)?.dispose();
      contentListeners.delete(uri);
      model.dispose();
      models.delete(uri);
    }
    for (const collapsedPath of [...collapsedFolders]) {
      if (collapsedPath === entry.path || collapsedPath.startsWith(deletedPrefix)) {
        collapsedFolders.delete(collapsedPath);
      }
    }
    const activeEntry = entries.find((candidate): candidate is WorkspaceFile => candidate.kind === "file" && candidate.uri === activeUri);
    if (!activeEntry) {
      const nextEntry = editableFiles()[0] ?? entries.find((candidate): candidate is WorkspaceFile => candidate.kind === "file");
      if (nextEntry) {
        openFile(nextEntry.path, undefined, false);
      }
    } else {
      renderTabs();
      renderTree();
      refreshToolbarState();
    }
    selectedPath = dirname(entry.path);
    refreshToolbarState();
    hideTreeContextMenu();
  };

  const resetWorkspace = (): void => {
    if (!allowWorkspaceWrites) {
      return;
    }
    const nextEntriesWithoutRuntime = deserializeWorkbenchEntries(initialWorkbenchSnapshot) ?? initialEditableEntries;
    entries = [
      ...nextEntriesWithoutRuntime,
      ...createBundledRuntimeEntries(),
    ];
    workspaceRevision += 1;
    collapsedFolders.clear();
    contextMenuEntry = null;
    for (const [uri, model] of [...models.entries()]) {
      const nextEntry = entries.find((entry): entry is WorkspaceFile => entry.kind === "file" && entry.uri === uri);
      if (!nextEntry) {
        embedWorkspaceContextsByUri.delete(uri);
        modelSessionCache.delete(uri);
        disposers.get(uri)?.();
        disposers.delete(uri);
        contentListeners.get(uri)?.dispose();
        contentListeners.delete(uri);
        model.dispose();
        models.delete(uri);
        continue;
      }
      if (model.getValue() !== nextEntry.content) {
        model.setValue(nextEntry.content);
      }
    }
    for (const entry of editableFiles()) {
      bindEditableModel(entry);
    }
    const nextActivePath = entries.find((entry): entry is WorkspaceFile => entry.kind === "file" && entry.path === normalizePath(options.activePath ?? ""))
      ?.path ?? editableFiles()[0]?.path;
    if (nextActivePath) {
      openFile(nextActivePath, options.selection, false);
    } else {
      renderTabs();
      renderTree();
      refreshToolbarState();
    }
    hideTreeContextMenu();
    persist();
    refreshToolbarState();
  };

  const editorOpenerDisposable = monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const uri = resource.toString();
      const entry = entries.find((candidate): candidate is WorkspaceFile =>
        candidate.kind === "file" && candidate.uri === uri
      );
      if (!entry) {
        return false;
      }
      openFile(entry.path, selectionOrPosition);
      return editor;
    },
  });

  backButton.addEventListener("click", () => {
    if (browserHistorySnapshot.back.length === 0) {
      return;
    }
    window.history.back();
  });
  forwardButton.addEventListener("click", () => {
    if (browserHistorySnapshot.forward.length === 0) {
      return;
    }
    window.history.forward();
  });
  saveButton.addEventListener("click", () => {
    persist();
    refreshToolbarState();
  });
  const handleResetWorkspace = (): void => {
    if (!allowWorkspaceWrites) {
      return;
    }
    const confirmed = window.confirm("Reset the workspace to the original embedded files? Unsaved local changes will be lost.");
    if (!confirmed) {
      return;
    }
    resetWorkspace();
  };
  runButton.addEventListener("click", () => {
    void runCurrentWorkspace();
  });
  expandButton.addEventListener("click", () => {
    target.classList.toggle("is-expanded");
    document.body.classList.toggle("vexa-workbench-expanded", isExpanded());
    syncExpandButton();
    stabilizeEditorLayout(editor);
  });
  clearOutputButton.addEventListener("click", () => clearOutput());
  moreActionsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (toolbarMenuOpen) {
      hideToolbarMenu();
      return;
    }
    showToolbarMenu();
  });
  menuFormatButton.addEventListener("click", () => {
    hideToolbarMenu();
    void editor.getAction("editor.action.formatDocument")?.run();
  });
  menuToggleInlayHintsButton.addEventListener("click", () => {
    hideToolbarMenu();
    inlayHintsEnabled = !inlayHintsEnabled;
    applyInlayHintsPreference();
  });
  menuResetWorkspaceButton.addEventListener("click", () => {
    hideToolbarMenu();
    handleResetWorkspace();
  });
  sidebarToggleButton.addEventListener("click", () => {
    sidebarState = { ...sidebarState, open: !sidebarState.open };
    applySidebarState();
    stabilizeEditorLayout(editor);
  });
  sidebarBackdrop.addEventListener("click", () => {
    sidebarState = { ...sidebarState, open: false };
    applySidebarState();
    stabilizeEditorLayout(editor);
  });
  shell.querySelector<HTMLButtonElement>('[data-action="new-file"]')?.addEventListener("click", () => {
    if (!allowWorkspaceWrites) {
      return;
    }
    const name = window.prompt("New file name", "newFile.vx");
    if (!name) {
      return;
    }
    const parentFolderPath = contextMenuEntry?.kind === "folder"
      ? contextMenuEntry.path
      : selectedPath && entries.find((entry) => entry.path === selectedPath)?.kind === "folder"
        ? selectedPath
        : "/";
    entries = createFileInWorkspace(entries, parentFolderPath, name);
    const createdPath = normalizePath(parentFolderPath === "/" ? `/${name.trim()}` : `${parentFolderPath}/${name.trim()}`);
    collapsedFolders.delete(parentFolderPath);
    const nextEntry = entries.find((entry) => entry.path === createdPath);
    if (nextEntry?.kind === "file") {
      bindEditableModel(nextEntry);
      renderTabs();
      renderTree();
      openFile(nextEntry.path);
    }
    hideTreeContextMenu();
  });
  shell.querySelector<HTMLButtonElement>('[data-action="new-folder"]')?.addEventListener("click", () => {
    if (!allowWorkspaceWrites) {
      return;
    }
    const selectedEntry = entries.find((entry) => entry.path === selectedPath);
    const parentFolderPath = selectedEntry?.kind === "folder" ? selectedEntry.path : dirname(selectedPath || "/");
    createFolderAtPath(parentFolderPath);
  });
  contextNewFileButton.addEventListener("click", () => {
    if (contextMenuEntry?.kind === "folder" && !contextMenuEntry.readOnly) {
      const name = window.prompt("New file name", "newFile.vx");
      if (name) {
        entries = createFileInWorkspace(entries, contextMenuEntry.path, name);
        const createdPath = normalizePath(
          contextMenuEntry.path === "/"
            ? `/${name.trim()}`
            : `${contextMenuEntry.path}/${name.trim()}`
        );
        collapsedFolders.delete(contextMenuEntry.path);
        const nextEntry = entries.find((entry) => entry.path === createdPath);
        if (nextEntry?.kind === "file") {
          bindEditableModel(nextEntry);
          renderTabs();
          renderTree();
          openFile(nextEntry.path);
        }
      }
    }
    hideTreeContextMenu();
  });
  contextNewFolderButton.addEventListener("click", () => {
    if (contextMenuEntry?.kind === "folder" && !contextMenuEntry.readOnly) {
      createFolderAtPath(contextMenuEntry.path);
    }
    hideTreeContextMenu();
  });
  contextDeleteButton.addEventListener("click", () => {
    if (contextMenuEntry) {
      deleteEntry(contextMenuEntry);
    }
  });
  window.addEventListener("click", (event) => {
    if (event.target instanceof Node && toolbarMenu.contains(event.target)) {
      return;
    }
    if (event.target instanceof Node && moreActionsButton.contains(event.target)) {
      return;
    }
    hideToolbarMenu();
    if (event.target instanceof Node && treeContextMenu.contains(event.target)) {
      return;
    }
    hideTreeContextMenu();
  });
  window.addEventListener("blur", () => hideTreeContextMenu());
  window.addEventListener("blur", () => hideToolbarMenu());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideTreeContextMenu();
      hideToolbarMenu();
      if (sidebarState.compact && sidebarState.open) {
        sidebarState = { ...sidebarState, open: false };
        applySidebarState();
        stabilizeEditorLayout(editor);
      }
    }
  });
  const handleBrowserPopState = (event: PopStateEvent): void => {
    const snapshot = readWorkbenchBrowserHistorySnapshot(event.state, workbenchHistoryId);
    if (!snapshot || snapshot.current === activeUri) {
      return;
    }
    const nextEntry = entries.find((entry): entry is WorkspaceFile =>
      entry.kind === "file" && entry.uri === snapshot.current
    );
    if (!nextEntry) {
      return;
    }
    browserHistorySnapshot = snapshot;
    openFile(nextEntry.path, undefined, false);
  };
  window.addEventListener("popstate", handleBrowserPopState);

  syncExpandButton();
  applyInlayHintsPreference();
  const compactSidebarMedia = window.matchMedia(COMPACT_WORKBENCH_MEDIA_QUERY);
  const handleViewportToggle = (): void => {
    sidebarState = deriveWorkbenchSidebarState(sidebarState, compactSidebarMedia.matches);
    applySidebarState();
    syncExpandButton();
    stabilizeEditorLayout(editor);
  };
  window.addEventListener("resize", handleViewportToggle);
  compactSidebarMedia.addEventListener("change", handleViewportToggle);
  handleViewportToggle();
  browserHistorySnapshot = createWorkbenchBrowserHistorySnapshot(activeUri);
  window.history.replaceState(
    writeWorkbenchBrowserHistorySnapshot(window.history.state, workbenchHistoryId, browserHistorySnapshot),
    "",
    window.location.href
  );
  void ensureEmbeddedRuntimeReady()
    .then(async () => {
      await refreshBundledRuntimeEntries();
      openFile(initialEntry.path, options.selection, false);
      await runCurrentWorkspace();
    })
    .catch((error) => {
      appendOutput("error", error instanceof Error ? error.stack || error.message : String(error));
    });

  return {
    editor,
    openFile,
    async run() {
      await runCurrentWorkspace();
    },
    save() {
      persist();
    },
    getEntries() {
      return [...entries];
    },
    getValue(path?: string) {
      if (!path) {
        return editor.getModel()?.getValue() ?? "";
      }
      return models.get(pathToUri(path))?.getValue() ?? "";
    },
    setValue(content: string, path?: string) {
      const uri = path ? pathToUri(path) : activeUri;
      const model = models.get(uri);
      if (model) {
        model.setValue(content);
      }
    },
    dispose() {
      for (const dispose of disposers.values()) {
        dispose();
      }
      document.body.classList.remove("vexa-workbench-expanded");
      window.removeEventListener("popstate", handleBrowserPopState);
      window.removeEventListener("resize", handleViewportToggle);
      compactSidebarMedia.removeEventListener("change", handleViewportToggle);
      editorOpenerDisposable.dispose();
      editor.dispose();
      for (const uri of models.keys()) {
        embedWorkspaceContextsByUri.delete(uri);
      }
      for (const listener of contentListeners.values()) {
        listener.dispose();
      }
      for (const model of models.values()) {
        model.dispose();
      }
    },
  };
}

window.VexaScriptEmbeds = {
  createSimpleEditor,
  createTabbedEditor,
  createWorkspaceEditor,
  createWorkbenchEditor,
  monaco,
};
