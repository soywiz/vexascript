/// <reference types="vite/client" />

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor";
import bundledSample from "../sample/main.my?raw";
import {
  pullDiagnostics,
  registerLanguage,
  registerProviders,
  updateAutoAwaitGlyphs,
} from "./compiler-providers";
import {
  persistWorkspaceContent,
  resolveWorkspaceContent,
  STATIC_WORKSPACE_URI,
  WORKSPACE_STORAGE_KEY,
} from "./workspace";

self.MonacoEnvironment = {
  getWorker(_id: string, _label: string): Worker {
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

function updateDirtyState(isDirty: boolean): void {
  const fileName = document.querySelector(".file-name");
  if (fileName) {
    fileName.textContent = isDirty ? "main.my*" : "main.my";
  }
}

async function main(): Promise<void> {
  setStatus("Loading compiler…", "connecting");

  registerLanguage();
  const sessionCache = registerProviders();

  const storage = localStorageOrUndefined();
  const initialContent = resolveWorkspaceContent(
    bundledSample,
    storage,
    WORKSPACE_STORAGE_KEY
  );

  const model = monaco.editor.createModel(
    initialContent,
    "mylang",
    monaco.Uri.parse(STATIC_WORKSPACE_URI)
  );

  const container = document.getElementById("editor-container")!;
  const editor = monaco.editor.create(container, {
    model,
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

  const savedBaseline = resolveWorkspaceContent(bundledSample, storage, WORKSPACE_STORAGE_KEY);
  updateDirtyState(model.getValue() !== savedBaseline);
  pullDiagnostics(model, sessionCache);
  updateAutoAwaitGlyphs(editor, sessionCache);
  setStatus("Compiler Connected", "connected");

  let diagnosticsTimer: number | undefined;
  model.onDidChangeContent(() => {
    if (diagnosticsTimer !== undefined) {
      window.clearTimeout(diagnosticsTimer);
    }
    diagnosticsTimer = window.setTimeout(() => {
      pullDiagnostics(model, sessionCache);
      updateAutoAwaitGlyphs(editor, sessionCache);
      const currentSaved = resolveWorkspaceContent(bundledSample, storage, WORKSPACE_STORAGE_KEY);
      updateDirtyState(model.getValue() !== currentSaved);
    }, 150);
  });

  document.getElementById("btn-format")?.addEventListener("click", () => {
    void editor.getAction("editor.action.formatDocument")?.run();
  });

  document.getElementById("btn-save")?.addEventListener("click", () => {
    persistWorkspaceContent(model.getValue(), storage, WORKSPACE_STORAGE_KEY);
    updateDirtyState(false);
    showToast("Saved to local storage");
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    document.getElementById("btn-save")?.click();
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  setStatus("Error: " + String(error), "error");
});
