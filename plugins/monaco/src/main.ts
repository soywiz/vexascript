/// <reference types="vite/client" />

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as monaco from "monaco-editor";
import { createAnalysisSession, type AnalysisSession } from "compiler/lsp/analysisSession";
import { collectTopLevelDeclarationsFromAst } from "compiler/analysis/projectIndex";
import type { SymbolExport } from "compiler/lsp/importFixes";
import { WorkspaceVfs } from "./workspaceVfs";
import bundledSample from "../sample/main.my?raw";
import bundledRuntime from "../../../compiler/runtime/es2025.d.ts?raw";
import {
  pullDiagnostics,
  registerLanguage,
  registerProviders,
  updateAutoAwaitGlyphs,
} from "./compiler-providers";
import {
  createMyLangMonacoTheme,
  MYLANG_MONACO_THEME_NAME,
} from "./theme";
import {
  createFileInWorkspace,
  createFolderInWorkspace,
  deleteWorkspaceEntry,
  findEntryByUri,
  listChildren,
  MAIN_DOCUMENT_URI,
  clampWorkspaceSessionToFile,
  persistWorkspaceSession,
  persistWorkspaceEntries,
  pathToUri,
  resolveWorkspaceSession,
  resolveWorkspaceEntries,
  RUNTIME_DOCUMENT_URI,
  WORKSPACE_SESSION_STORAGE_KEY,
  updateFileContent,
  WORKSPACE_STORAGE_KEY,
  type StorageLike,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "./workspace";
import {
  pushNavigationTarget,
  sameNavigationTarget,
  stepBack,
  stepForward,
  type NavigationHistoryState,
  type NavigationTarget,
} from "./navigationHistory";
import { registerEditorShortcuts } from "./editorShortcuts";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

function setStatus(text: string, state: "connecting" | "connected" | "error" | ""): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = "status " + state;
}

function showToast(msg: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function filePathToWorkspaceUri(filePath: string): string {
  return pathToUri(filePath);
}

function isEditableMyLangFile(entry: WorkspaceEntry | undefined): entry is WorkspaceFile {
  return !!entry && entry.kind === "file" && !entry.readOnly && entry.language === "mylang";
}

function updateActiveFileLabel(entry: WorkspaceEntry | undefined, isDirty: boolean): void {
  const fileName = document.querySelector(".file-name");
  if (!fileName) return;
  const label = entry?.label ?? "No file";
  fileName.textContent = isDirty ? `${label}*` : label;
}

function setToolbarState(entry: WorkspaceEntry | undefined): void {
  const formatButton = document.getElementById("btn-format") as HTMLButtonElement | null;
  const saveButton = document.getElementById("btn-save") as HTMLButtonElement | null;
  const enabled = isEditableMyLangFile(entry);
  if (formatButton) formatButton.disabled = !enabled;
  if (saveButton) saveButton.disabled = !enabled;
}

function setNavigationButtonsState(history: NavigationHistoryState): void {
  const backButton = document.getElementById("btn-nav-back") as HTMLButtonElement | null;
  const forwardButton = document.getElementById("btn-nav-forward") as HTMLButtonElement | null;
  if (backButton) backButton.disabled = history.backStack.length === 0;
  if (forwardButton) forwardButton.disabled = history.forwardStack.length === 0;
}

function renderTabs(
  openTabs: string[],
  entries: WorkspaceEntry[],
  activeUri: string | null,
  onSelect: (uri: string) => void,
  onClose: (uri: string) => void
): void {
  const container = document.getElementById("tabs");
  if (!container) return;
  container.innerHTML = "";
  for (const uri of openTabs) {
    const entry = findEntryByUri(entries, uri);
    if (!entry || entry.kind !== "file") continue;
    const button = window.document.createElement("button");
    button.className = "tab" + (entry.uri === activeUri ? " active" : "");

    const label = window.document.createElement("span");
    label.className = "tab-label";
    label.textContent = entry.label;
    button.appendChild(label);

    const close = window.document.createElement("span");
    close.className = "tab-close";
    close.textContent = "x";
    close.title = "Close tab";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      onClose(entry.uri);
    });
    button.appendChild(close);

    if (entry.readOnly) {
      button.title = "Read-only runtime declarations";
    }
    button.addEventListener("click", () => onSelect(entry.uri));
    container.appendChild(button);
  }
}

function renderTree(
  entries: WorkspaceEntry[],
  activeUri: string | null,
  selectedPath: string,
  onSelectEntry: (entry: WorkspaceEntry) => void,
  onContextMenu: (entry: WorkspaceEntry, event: MouseEvent) => void
): void {
  const container = document.getElementById("file-tree");
  if (!container) return;
  container.innerHTML = "";

  const appendFolder = (folderPath: string, depth: number): void => {
    for (const entry of listChildren(entries, folderPath)) {
      const item = window.document.createElement("button");
      item.className = "tree-item" +
        (entry.path === selectedPath ? " selected" : "") +
        (entry.uri === activeUri ? " active" : "");
      item.style.paddingLeft = `${12 + depth * 16}px`;
      item.type = "button";
      item.textContent = entry.kind === "folder" ? `▾ ${entry.label}` : entry.label;
      item.addEventListener("click", () => onSelectEntry(entry));
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        onContextMenu(entry, event);
      });
      container.appendChild(item);
      if (entry.kind === "folder") {
        appendFolder(entry.path, depth + 1);
      }
    }
  };

  appendFolder("/", 0);
}

async function main(): Promise<void> {
  setStatus("Loading compiler…", "connecting");

  registerLanguage();
  monaco.editor.defineTheme(MYLANG_MONACO_THEME_NAME, createMyLangMonacoTheme());
  monaco.editor.setTheme(MYLANG_MONACO_THEME_NAME);

  const storage = localStorageOrUndefined();
  let entries = resolveWorkspaceEntries(bundledSample, bundledRuntime, storage, WORKSPACE_STORAGE_KEY);
  const models = new Map<string, monaco.editor.ITextModel>();
  const workspaceSessionCache = new Map<string, { content: string; session: AnalysisSession }>();
  const restoredSession = resolveWorkspaceSession(entries, storage, WORKSPACE_SESSION_STORAGE_KEY);
  let openTabs = [restoredSession?.activeUri ?? MAIN_DOCUMENT_URI];
  let activeUri: string | null = restoredSession?.activeUri ?? MAIN_DOCUMENT_URI;
  let selectedPath = "/";
  let savedSnapshot = JSON.stringify(entries);
  let diagnosticsTimer: number | undefined;
  let contextMenuEntry: WorkspaceEntry | null = null;
  let navigationHistory: NavigationHistoryState = {
    backStack: [],
    current: { uri: MAIN_DOCUMENT_URI, lineNumber: 1, column: 1 },
    forwardStack: [],
  };

  const getWorkspaceFileSource = (uri: string): string | null => {
    const model = models.get(uri) ?? monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) {
      return model.getValue();
    }
    const entry = findEntryByUri(entries, uri);
    return entry?.kind === "file" ? entry.content : null;
  };

  const workspaceVfs = new WorkspaceVfs({
    getEntries: () => entries,
    readWorkspaceFile: (uri) => getWorkspaceFileSource(uri),
    fetchText: async (uri) => {
      try {
        const response = await fetch(uri);
        return response.ok ? await response.text() : null;
      } catch {
        return null;
      }
    },
  });

  const getWorkspaceSessionForFilePath = (filePath: string): AnalysisSession | null => {
    const uri = filePathToWorkspaceUri(filePath);
    const source = getWorkspaceFileSource(uri);
    if (source === null) {
      return null;
    }
    const cached = workspaceSessionCache.get(uri);
    if (cached && cached.content === source) {
      return cached.session;
    }
    const session = createAnalysisSession(source);
    workspaceSessionCache.set(uri, { content: source, session });
    return session;
  };

  const getWorkspaceExportedSymbols = async (): Promise<SymbolExport[]> => {
    const symbols: SymbolExport[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file" || entry.language !== "mylang") {
        continue;
      }
      const filePath = entry.path;
      const session = getWorkspaceSessionForFilePath(filePath);
      for (const declaration of collectTopLevelDeclarationsFromAst(session?.ast ?? null)) {
        symbols.push({
          name: declaration.name,
          kind: declaration.kind,
          filePath,
          ...(declaration.receiverType ? { receiverType: declaration.receiverType } : {}),
          ...(declaration.memberKind ? { memberKind: declaration.memberKind } : {}),
        });
      }
    }
    return symbols;
  };

  const providerWorkspaceContext = {
    vfs: workspaceVfs,
    getSessionForFilePath: getWorkspaceSessionForFilePath,
    getExportedSymbols: getWorkspaceExportedSymbols,
  };
  const sessionCache = registerProviders(providerWorkspaceContext);

  const ensureModel = (uri: string): monaco.editor.ITextModel | null => {
    const existing = models.get(uri) ?? monaco.editor.getModel(monaco.Uri.parse(uri));
    if (existing) {
      models.set(uri, existing);
      return existing;
    }
    const entry = findEntryByUri(entries, uri);
    if (!entry || entry.kind !== "file") return null;
    const model = monaco.editor.createModel(
      entry.content,
      entry.language,
      monaco.Uri.parse(entry.uri)
    );
    if (!entry.readOnly) {
      model.onDidChangeContent(() => {
        entries = updateFileContent(entries, entry.uri, model.getValue());
        renderTree(
          entries,
          activeUri,
          selectedPath,
          handleTreeSelection,
          showTreeContextMenu
        );
        renderTabs(openTabs, entries, activeUri, selectDocument, closeTab);
        const activeEntry = activeUri ? findEntryByUri(entries, activeUri) : undefined;
        updateActiveFileLabel(activeEntry, JSON.stringify(entries) !== savedSnapshot);
        if (diagnosticsTimer !== undefined) {
          window.clearTimeout(diagnosticsTimer);
        }
        diagnosticsTimer = window.setTimeout(() => {
          if (activeUri === entry.uri && isEditableMyLangFile(activeEntry)) {
            void pullDiagnostics(model, sessionCache, providerWorkspaceContext);
            void updateAutoAwaitGlyphs(editor, sessionCache, providerWorkspaceContext);
          }
        }, 150);
      });
    }
    models.set(uri, model);
    return model;
  };

  const initialModel = ensureModel(MAIN_DOCUMENT_URI);
  if (!initialModel) {
    throw new Error("Main workspace model could not be created");
  }
  ensureModel(RUNTIME_DOCUMENT_URI);
  const restoredInitialSession = restoredSession
    ? clampWorkspaceSessionToFile(
        restoredSession,
        getWorkspaceFileSource(restoredSession.activeUri) ?? initialModel.getValue()
      )
    : null;
  const startupModel = ensureModel(restoredInitialSession?.activeUri ?? MAIN_DOCUMENT_URI) ?? initialModel;

  const editorContainer = document.getElementById("editor-container")!;
  const editor = monaco.editor.create(editorContainer, {
    model: startupModel,
    theme: MYLANG_MONACO_THEME_NAME,
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 14,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "off",
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: "selection",
    "semanticHighlighting.enabled": true,
    scrollbar: { vertical: "visible", horizontal: "visible" },
    glyphMargin: true,
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
    bracketPairColorization: { enabled: true },
  });

  const applySelection = (selectionOrPosition?: monaco.IRange | monaco.IPosition): void => {
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
  };

  const persistEditorSession = (): void => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) {
      return;
    }
    persistWorkspaceSession(
      {
        activeUri: model.uri.toString(),
        lineNumber: position.lineNumber,
        column: position.column,
      },
      storage,
      WORKSPACE_SESSION_STORAGE_KEY
    );
  };

  const selectionOrPositionToTarget = (
    uri: string,
    selectionOrPosition?: monaco.IRange | monaco.IPosition
  ): NavigationTarget => {
    if (!selectionOrPosition) {
      return { uri };
    }
    if ("endLineNumber" in selectionOrPosition) {
      return {
        uri,
        lineNumber: selectionOrPosition.startLineNumber,
        column: selectionOrPosition.startColumn,
        endLineNumber: selectionOrPosition.endLineNumber,
        endColumn: selectionOrPosition.endColumn,
      };
    }
    return {
      uri,
      lineNumber: selectionOrPosition.lineNumber,
      column: selectionOrPosition.column,
    };
  };

  const currentEditorTarget = (): NavigationTarget | null => {
    const model = editor.getModel();
    if (!model) {
      return activeUri ? { uri: activeUri } : null;
    }
    const position = editor.getPosition();
    return {
      uri: model.uri.toString(),
      lineNumber: position?.lineNumber,
      column: position?.column,
    };
  };

  const syncEditorState = (): void => {
    const activeEntry = activeUri ? findEntryByUri(entries, activeUri) : undefined;
    updateActiveFileLabel(activeEntry, JSON.stringify(entries) !== savedSnapshot);
    setToolbarState(activeEntry);
    setNavigationButtonsState(navigationHistory);
    renderTabs(openTabs, entries, activeUri, selectDocument, closeTab);
    renderTree(
      entries,
      activeUri,
      selectedPath,
      handleTreeSelection,
      showTreeContextMenu
    );
  };

  const selectDocument = (
    uri: string,
    selectionOrPosition?: monaco.IRange | monaco.IPosition,
    options: { trackHistory?: boolean } = {}
  ): void => {
    const model = ensureModel(uri);
    const entry = findEntryByUri(entries, uri);
    if (!model || !entry || entry.kind !== "file") return;
    if (!openTabs.includes(uri)) {
      openTabs = [...openTabs, uri];
    }
    activeUri = uri;
    selectedPath = entry.path;
    editor.setModel(model);
    editor.updateOptions({ readOnly: !!entry.readOnly });
    applySelection(selectionOrPosition);
    editor.focus();
    if (options.trackHistory !== false) {
      const target = selectionOrPositionToTarget(uri, selectionOrPosition);
      navigationHistory = pushNavigationTarget(navigationHistory, target);
    }
    persistEditorSession();
    syncEditorState();
    if (isEditableMyLangFile(entry)) {
      void pullDiagnostics(model, sessionCache, providerWorkspaceContext);
      void updateAutoAwaitGlyphs(editor, sessionCache, providerWorkspaceContext);
    }
  };

  const navigateHistory = (direction: "back" | "forward"): void => {
    const updatedHistory = direction === "back"
      ? stepBack(navigationHistory)
      : stepForward(navigationHistory);
    if (updatedHistory === navigationHistory || !updatedHistory.current) {
      return;
    }
    navigationHistory = updatedHistory;
    const target = updatedHistory.current;
    const selection = target.lineNumber && target.column
      ? target.endLineNumber && target.endColumn
        ? {
            startLineNumber: target.lineNumber,
            startColumn: target.column,
            endLineNumber: target.endLineNumber,
            endColumn: target.endColumn,
          }
        : {
            lineNumber: target.lineNumber,
            column: target.column,
          }
      : undefined;
    selectDocument(target.uri, selection, { trackHistory: false });
  };

  const hideTreeContextMenu = (): void => {
    const menu = document.getElementById("tree-context-menu");
    if (!menu) {
      return;
    }
    menu.style.display = "none";
    contextMenuEntry = null;
  };

  const showTreeContextMenu = (entry: WorkspaceEntry, event: MouseEvent): void => {
    const menu = document.getElementById("tree-context-menu");
    if (!menu) {
      return;
    }
    contextMenuEntry = entry;
    selectedPath = entry.path;
    syncEditorState();
    menu.style.display = "block";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const openAction = document.getElementById("tree-context-open") as HTMLButtonElement | null;
    const deleteAction = document.getElementById("tree-context-delete") as HTMLButtonElement | null;
    if (openAction) {
      openAction.disabled = entry.kind !== "file";
    }
    if (deleteAction) {
      deleteAction.disabled = !!entry.readOnly || entry.path === "/";
    }
  };

  const deleteEntry = (entry: WorkspaceEntry): void => {
    const confirmed = window.confirm(
      entry.kind === "folder"
        ? `Delete folder "${entry.label}" and all its contents?`
        : `Delete file "${entry.label}"?`
    );
    if (!confirmed) {
      return;
    }
    const previousEntries = entries;
    const deletedUri = entry.kind === "file" ? entry.uri : null;
    entries = deleteWorkspaceEntry(entries, entry.path);
    if (entries.some((candidate) => candidate.path === entry.path)) {
      showToast("Read-only entries cannot be deleted");
      return;
    }
    if (deletedUri) {
      const model = models.get(deletedUri);
      model?.dispose();
      models.delete(deletedUri);
      openTabs = openTabs.filter((uri) => uri !== deletedUri);
      if (activeUri === deletedUri) {
        activeUri = openTabs[openTabs.length - 1] ?? MAIN_DOCUMENT_URI;
        if (activeUri) {
          selectDocument(activeUri, undefined, { trackHistory: false });
          return;
        }
      }
    } else {
      const deletedPrefix = `${entry.path}/`;
      const deletedUris = openTabs.filter((uri) => {
        const candidate = findEntryByUri(previousEntries, uri);
        return !!candidate && candidate.path.startsWith(deletedPrefix);
      });
      for (const uri of deletedUris) {
        const model = models.get(uri);
        model?.dispose();
        models.delete(uri);
      }
      openTabs = openTabs.filter((uri) => !deletedUris.includes(uri));
      if (activeUri) {
        const activeEntry = findEntryByUri(entries, activeUri);
        if (!activeEntry) {
          activeUri = openTabs[openTabs.length - 1] ?? MAIN_DOCUMENT_URI;
          if (activeUri) {
            selectDocument(activeUri, undefined, { trackHistory: false });
            return;
          }
        }
      }
    }
    selectedPath = "/";
    syncEditorState();
  };

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const currentTarget = currentEditorTarget();
      if (currentTarget && !sameNavigationTarget(navigationHistory.current, currentTarget)) {
        navigationHistory = pushNavigationTarget(navigationHistory, currentTarget);
      }
      const uri = resource.toString();
      const entry = findEntryByUri(entries, uri);
      if (!entry || entry.kind !== "file") {
        return false;
      }
      selectDocument(uri, selectionOrPosition);
      return true;
    },
  });

  editor.onDidChangeModel((event) => {
    const nextUri = event.newModelUrl?.toString() ?? null;
    if (!nextUri) {
      return;
    }
    const entry = findEntryByUri(entries, nextUri);
    if (!entry || entry.kind !== "file") {
      return;
    }
    if (!openTabs.includes(nextUri)) {
      openTabs = [...openTabs, nextUri];
    }
    activeUri = nextUri;
    selectedPath = entry.path;
    persistEditorSession();
    syncEditorState();
  });

  editor.onDidChangeCursorPosition(() => {
    persistEditorSession();
  });

  const closeTab = (uri: string): void => {
    if (openTabs.length <= 1) return;
    const closingIndex = openTabs.indexOf(uri);
    if (closingIndex < 0) return;
    openTabs = openTabs.filter((tabUri) => tabUri !== uri);
    if (activeUri === uri) {
      activeUri = openTabs[Math.max(0, closingIndex - 1)] ?? openTabs[0] ?? null;
      if (activeUri) {
        selectDocument(activeUri);
        return;
      }
    }
    syncEditorState();
  };

  const handleTreeSelection = (entry: WorkspaceEntry): void => {
    selectedPath = entry.path;
    if (entry.kind === "file") {
      selectDocument(entry.uri);
      return;
    }
    syncEditorState();
  };

  const createWorkspaceEntry = (kind: "file" | "folder"): void => {
    const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? entries[0];
    const parentFolderPath = selectedEntry?.kind === "folder" ? selectedEntry.path : selectedEntry ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf("/")) || "/" : "/";
    const name = window.prompt(kind === "file" ? "New file name" : "New folder name", kind === "file" ? "newFile.my" : "newFolder");
    if (!name) return;
    entries = kind === "file"
      ? createFileInWorkspace(entries, parentFolderPath, name)
      : createFolderInWorkspace(entries, parentFolderPath, name);
    const createdPath = parentFolderPath === "/" ? `/${name.trim()}` : `${parentFolderPath}/${name.trim()}`;
    selectedPath = createdPath.replace(/\/+/g, "/");
    syncEditorState();
    if (kind === "file") {
      const createdEntry = entries.find((entry) => entry.path === selectedPath);
      if (createdEntry?.kind === "file") {
        selectDocument(createdEntry.uri);
      }
    }
  };

  if (restoredInitialSession?.activeUri) {
    activeUri = restoredInitialSession.activeUri;
    const restoredEntry = findEntryByUri(entries, restoredInitialSession.activeUri);
    if (restoredEntry) {
      selectedPath = restoredEntry.path;
    }
  }
  applySelection(restoredInitialSession
    ? { lineNumber: restoredInitialSession.lineNumber, column: restoredInitialSession.column }
    : undefined);
  editor.focus();
  void pullDiagnostics(startupModel, sessionCache, providerWorkspaceContext);
  void updateAutoAwaitGlyphs(editor, sessionCache, providerWorkspaceContext);
  persistEditorSession();
  syncEditorState();
  setStatus("Compiler Connected", "connected");

  document.getElementById("btn-format")?.addEventListener("click", () => {
    void editor.getAction("editor.action.formatDocument")?.run();
  });

  document.getElementById("btn-save")?.addEventListener("click", () => {
    persistWorkspaceEntries(entries, storage, WORKSPACE_STORAGE_KEY);
    savedSnapshot = JSON.stringify(entries);
    syncEditorState();
    showToast("Workspace saved to local storage");
  });

  document.getElementById("btn-new-file")?.addEventListener("click", () => createWorkspaceEntry("file"));
  document.getElementById("btn-new-folder")?.addEventListener("click", () => createWorkspaceEntry("folder"));
  document.getElementById("btn-nav-back")?.addEventListener("click", () => navigateHistory("back"));
  document.getElementById("btn-nav-forward")?.addEventListener("click", () => navigateHistory("forward"));
  document.getElementById("tree-context-open")?.addEventListener("click", () => {
    if (contextMenuEntry?.kind === "file") {
      selectDocument(contextMenuEntry.uri);
    }
    hideTreeContextMenu();
  });
  document.getElementById("tree-context-delete")?.addEventListener("click", () => {
    if (contextMenuEntry) {
      deleteEntry(contextMenuEntry);
    }
    hideTreeContextMenu();
  });
  window.addEventListener("click", () => hideTreeContextMenu());
  window.addEventListener("blur", () => hideTreeContextMenu());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideTreeContextMenu();
    }
  });

  registerEditorShortcuts(editor, monaco, {
    navigateHistory,
    saveWorkspace: () => document.getElementById("btn-save")?.click(),
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  setStatus("Error: " + String(error), "error");
});
