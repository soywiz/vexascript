/// <reference types="vite/client" />

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import * as monaco from "monaco-editor";
import bundledSample from "../sample/main.my?raw";
import bundledRuntime from "../../../compiler/runtime/es2025.d.ts?raw";
import {
  pullDiagnostics,
  registerLanguage,
  registerProviders,
  updateAutoAwaitGlyphs,
} from "./compiler-providers";
import {
  createFileInWorkspace,
  createFolderInWorkspace,
  findEntryByUri,
  listChildren,
  MAIN_DOCUMENT_URI,
  persistWorkspaceEntries,
  resolveWorkspaceEntries,
  RUNTIME_DOCUMENT_URI,
  updateFileContent,
  WORKSPACE_STORAGE_KEY,
  type StorageLike,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "./workspace";

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
  onSelectEntry: (entry: WorkspaceEntry) => void
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
  const sessionCache = registerProviders();

  const storage = localStorageOrUndefined();
  let entries = resolveWorkspaceEntries(bundledSample, bundledRuntime, storage, WORKSPACE_STORAGE_KEY);
  const models = new Map<string, monaco.editor.ITextModel>();
  let openTabs = [MAIN_DOCUMENT_URI];
  let activeUri: string | null = MAIN_DOCUMENT_URI;
  let selectedPath = "/";
  let savedSnapshot = JSON.stringify(entries);
  let diagnosticsTimer: number | undefined;

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
        renderTree(entries, activeUri, selectedPath, handleTreeSelection);
        renderTabs(openTabs, entries, activeUri, selectDocument, closeTab);
        const activeEntry = activeUri ? findEntryByUri(entries, activeUri) : undefined;
        updateActiveFileLabel(activeEntry, JSON.stringify(entries) !== savedSnapshot);
        if (diagnosticsTimer !== undefined) {
          window.clearTimeout(diagnosticsTimer);
        }
        diagnosticsTimer = window.setTimeout(() => {
          if (activeUri === entry.uri && isEditableMyLangFile(activeEntry)) {
            pullDiagnostics(model, sessionCache);
            updateAutoAwaitGlyphs(editor, sessionCache);
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

  const editorContainer = document.getElementById("editor-container")!;
  const editor = monaco.editor.create(editorContainer, {
    model: initialModel,
    theme: "vs-dark",
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

  const syncEditorState = (): void => {
    const activeEntry = activeUri ? findEntryByUri(entries, activeUri) : undefined;
    updateActiveFileLabel(activeEntry, JSON.stringify(entries) !== savedSnapshot);
    setToolbarState(activeEntry);
    renderTabs(openTabs, entries, activeUri, selectDocument, closeTab);
    renderTree(entries, activeUri, selectedPath, handleTreeSelection);
  };

  const selectDocument = (uri: string): void => {
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
    syncEditorState();
    if (isEditableMyLangFile(entry)) {
      pullDiagnostics(model, sessionCache);
      updateAutoAwaitGlyphs(editor, sessionCache);
    }
  };

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

  pullDiagnostics(initialModel, sessionCache);
  updateAutoAwaitGlyphs(editor, sessionCache);
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

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    document.getElementById("btn-save")?.click();
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  setStatus("Error: " + String(error), "error");
});
