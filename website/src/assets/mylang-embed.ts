/// <reference types="vite/client" />

import "monaco-editor/min/vs/editor/editor.main.css";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as monaco from "monaco-editor";
import { createAnalysisSession } from "compiler/lsp/analysisSession";
import { collectCodeActions } from "compiler/lsp/codeActionsAggregate";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems,
} from "compiler/lsp/completion";
import { collectDiagnosticsFromSession } from "compiler/lsp/diagnostics";
import {
  createPrepareRename,
  createRenameWorkspaceEdit,
} from "compiler/lsp/navigation";
import {
  createPortableLanguageConfiguration,
  createPortableMonarchLanguage,
  type PortableLanguageConfiguration,
  type PortableMonarchLanguage,
} from "compiler/syntax";
import { markerToDiagnostic } from "../../../plugins/monaco/src/providerConversions";
import {
  createFileEntry,
  createFolderEntry,
  pathToUri,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "../../../plugins/monaco/src/workspace";
import { createMyLangMonacoTheme, MYLANG_MONACO_THEME_NAME } from "../../../plugins/monaco/src/theme";
import bundledRuntime from "../../../compiler/runtime/es2025.d.ts?raw";

interface MyLangEmbedFile {
  path: string;
  content: string;
  language?: "mylang" | "typescript";
  readOnly?: boolean;
}

interface EditorHandle {
  editor: monaco.editor.IStandaloneCodeEditor;
  dispose(): void;
  getValue(path?: string): string;
  setValue(content: string, path?: string): void;
}

interface SimpleEditorOptions {
  content: string;
  path?: string;
  readOnly?: boolean;
  height?: string;
  selection?: monaco.IRange;
}

interface WorkspaceEditorOptions {
  files: MyLangEmbedFile[];
  activePath?: string;
  height?: string;
  selection?: monaco.IRange;
}

let bootstrapped = false;
let modelCounter = 0;

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

declare global {
  interface Window {
    MyLangEmbeds?: {
      createSimpleEditor(container: HTMLElement | string, options: SimpleEditorOptions): EditorHandle;
      createWorkspaceEditor(container: HTMLElement | string, options: WorkspaceEditorOptions): EditorHandle;
      monaco: typeof monaco;
    };
  }
}

self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/g, "/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  return normalized.slice(lastSlash + 1);
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

function registerMyLang(): void {
  monaco.languages.register({
    id: "mylang",
    extensions: [".my"],
    aliases: ["MyLang", "mylang"],
    mimetypes: ["text/x-mylang"],
  });
  monaco.languages.setMonarchTokensProvider("mylang", toMonacoMonarchLanguage(createPortableMonarchLanguage()) as monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration("mylang", toMonacoLanguageConfiguration(createPortableLanguageConfiguration()));
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

function registerCompletionProvider(): void {
  monaco.languages.registerCompletionItemProvider("mylang", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const fallbackRange = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn
      );
      const session = createAnalysisSession(model.getValue());
      if (!session.ast || !session.analysis) {
        return {
          suggestions: createKeywordOnlyCompletionItems().map((item) => ({
            label: item.label,
            kind: lspCompletionItemKinds[item.kind ?? 0] ?? completionItemKind.Text,
            insertText: item.insertText ?? item.label,
            range: fallbackRange,
          })),
        };
      }
      const items = await createCompletionItemsForPosition(
        session.ast,
        position.lineNumber - 1,
        position.column - 1,
        session.analysis,
        [],
        {
          text: model.getValue(),
          recoverAnalysisSession: (source) => createAnalysisSession(
            source,
            session.externalDeclarations,
            session.importedSymbolTypes,
            session.ambientDeclarations
          ),
        }
      );
      return {
        suggestions: items.map((item) => ({
          label: item.label,
          kind: lspCompletionItemKinds[item.kind ?? 0] ?? completionItemKind.Text,
          detail: item.detail,
          documentation: toMarkdown(item.documentation),
          sortText: item.sortText,
          filterText: item.filterText,
          insertText: item.insertText ?? item.label,
          insertTextRules: item.insertTextFormat === 2
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          range: completionEditRange(item.textEdit, fallbackRange),
          additionalTextEdits: item.additionalTextEdits?.map(lspEditToMonaco),
        })),
      };
    },
  });
}

function registerRenameProvider(): void {
  monaco.languages.registerRenameProvider("mylang", {
    async resolveRenameLocation(model, position) {
      const reject: monaco.languages.RenameLocation & { rejectReason: string } = {
        range: new monaco.Range(1, 1, 1, 1),
        text: "",
        rejectReason: "Cannot rename this symbol",
      };
      const session = createAnalysisSession(model.getValue());
      if (!session.analysis) {
        return reject;
      }
      const prepared = createPrepareRename(
        session.analysis,
        position.lineNumber - 1,
        position.column - 1
      );
      return normalizePrepareRenameResult(prepared) ?? reject;
    },
    async provideRenameEdits(model, position, newName) {
      const session = createAnalysisSession(model.getValue());
      if (!session.analysis) {
        return { edits: [] };
      }
      const edit = createRenameWorkspaceEdit(
        session.analysis,
        model.uri.toString(),
        position.lineNumber - 1,
        position.column - 1,
        newName
      );
      if (!edit) {
        return { edits: [] };
      }
      return workspaceEditToMonaco(edit);
    },
  });
}

function registerCodeActionProvider(): void {
  monaco.languages.registerCodeActionProvider("mylang", {
    async provideCodeActions(model, range, context) {
      const session = createAnalysisSession(model.getValue());
      if (!session.ast) {
        return { actions: [], dispose: () => {} };
      }
      const diagnostics = context.markers.map((marker) =>
        markerToDiagnostic(marker, monaco.MarkerSeverity)
      );
      const actions = await collectCodeActions({
        uri: model.uri.toString(),
        text: model.getValue(),
        ast: session.ast,
        analysis: session.analysis,
        range: toLspRange(range),
        diagnostics,
        sourceRoots: [],
        getSessionForFilePath: () => null,
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

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== "string") {
    return container;
  }
  const element = document.querySelector<HTMLElement>(container);
  if (!element) {
    throw new Error(`MyLang editor container not found: ${container}`);
  }
  return element;
}

function bootstrapMonaco(): void {
  if (bootstrapped) {
    return;
  }
  registerMyLang();
  registerCompletionProvider();
  registerRenameProvider();
  registerCodeActionProvider();
  monaco.editor.defineTheme(MYLANG_MONACO_THEME_NAME, createMyLangMonacoTheme());
  monaco.editor.setTheme(MYLANG_MONACO_THEME_NAME);
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

function createFoldersForFiles(files: MyLangEmbedFile[]): WorkspaceEntry[] {
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

function createEntries(files: MyLangEmbedFile[]): WorkspaceEntry[] {
  const normalizedFiles = files.length > 0
    ? files
    : [{ path: "/main.my", content: "fun main(): string {\n  return \"Hello from MyLang\"\n}\n" }];
  const fileEntries = normalizedFiles.map((file) => createFileEntry(file.path, file.content, {
    ...(file.language ? { language: file.language } : {}),
    ...(file.readOnly ? { readOnly: true } : {}),
  }));
  return [
    ...createFoldersForFiles(normalizedFiles),
    ...fileEntries,
    createFolderEntry("/runtime", true),
    createFileEntry("/runtime/es2025.d.ts", bundledRuntime, {
      language: "typescript",
      readOnly: true,
      uri: "file:///es2025.d.ts",
    }),
  ];
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

function updateDiagnostics(model: monaco.editor.ITextModel): void {
  if (model.getLanguageId() !== "mylang") {
    monaco.editor.setModelMarkers(model, "mylang", []);
    return;
  }
  const session = createAnalysisSession(model.getValue());
  const diagnostics = collectDiagnosticsFromSession(
    session,
    model.getValue(),
    (offset) => {
      const position = model.getPositionAt(offset);
      return { line: position.lineNumber - 1, character: position.column - 1 };
    }
  );
  monaco.editor.setModelMarkers(
    model,
    "mylang",
    diagnostics.map((diagnostic) => ({
      severity: mapSeverity(diagnostic.severity),
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      message: diagnostic.message,
      code: String(diagnostic.code ?? ""),
      source: diagnostic.source ?? "mylang",
    }))
  );
}

function wireDiagnostics(model: monaco.editor.ITextModel): () => void {
  let timer: number | undefined;
  const refresh = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => updateDiagnostics(model), 100);
  };
  const changeDisposable = model.onDidChangeContent(refresh);
  refresh();
  return () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    changeDisposable.dispose();
  };
}

function createEditor(container: HTMLElement, model: monaco.editor.ITextModel, readOnly: boolean): monaco.editor.IStandaloneCodeEditor {
  const editor = monaco.editor.create(container, {
    model,
    theme: MYLANG_MONACO_THEME_NAME,
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
    scrollbar: { vertical: "visible", horizontal: "visible" },
    glyphMargin: true,
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
  return editor;
}

function createSimpleEditor(container: HTMLElement | string, options: SimpleEditorOptions): EditorHandle {
  bootstrapMonaco();
  const target = resolveContainer(container);
  setContainerHeight(target, options.height ?? "360px");
  const path = normalizePath(options.path ?? `/snippet-${++modelCounter}.my`);
  const model = monaco.editor.createModel(options.content, "mylang", monaco.Uri.parse(pathToUri(path)));
  const editor = createEditor(target, model, options.readOnly ?? false);
  const disposeDiagnostics = wireDiagnostics(model);
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

function createTabButton(entry: WorkspaceFile, activeUri: string, onSelect: (entry: WorkspaceFile) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mylang-embed-tab${entry.uri === activeUri ? " is-active" : ""}`;
  button.textContent = basename(entry.path);
  button.addEventListener("click", () => onSelect(entry));
  return button;
}

function createWorkspaceEditor(container: HTMLElement | string, options: WorkspaceEditorOptions): EditorHandle {
  bootstrapMonaco();
  const target = resolveContainer(container);
  target.classList.add("mylang-embed-workspace");
  target.textContent = "";
  setContainerHeight(target, options.height ?? "520px");

  const tabBar = document.createElement("div");
  tabBar.className = "mylang-embed-tabs";
  const editorHost = document.createElement("div");
  editorHost.className = "mylang-embed-editor";
  target.append(tabBar, editorHost);

  const entries = createEntries(options.files);
  const editableFiles = entries.filter((entry): entry is WorkspaceFile => entry.kind === "file" && entry.language === "mylang" && !entry.readOnly);
  const activeEntry = editableFiles.find((entry) => entry.path === normalizePath(options.activePath ?? "")) ?? editableFiles[0];
  if (!activeEntry) {
    throw new Error("MyLang workspace editor needs at least one editable MyLang file.");
  }

  const models = new Map<string, monaco.editor.ITextModel>();
  const disposers = new Map<string, () => void>();
  const ensureModel = (entry: WorkspaceFile): monaco.editor.ITextModel => {
    const existing = models.get(entry.uri);
    if (existing) {
      return existing;
    }
    const model = monaco.editor.createModel(entry.content, entry.language, monaco.Uri.parse(entry.uri));
    models.set(entry.uri, model);
    disposers.set(entry.uri, wireDiagnostics(model));
    return model;
  };

  let activeModel = ensureModel(activeEntry);
  const editor = createEditor(editorHost, activeModel, false);
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
      }));
    }
  };

  renderTabs();
  updateDiagnostics(activeModel);

  return {
    editor,
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

window.MyLangEmbeds = {
  createSimpleEditor,
  createWorkspaceEditor,
  monaco,
};
