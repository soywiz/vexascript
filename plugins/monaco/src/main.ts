/// <reference types="vite/client" />

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor";
import bundledSample from "../sample/main.my?raw";
import {
  getHoverInfo,
  pullDiagnostics,
  registerLanguage,
  registerProviders,
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

declare global {
  interface HTMLElement {
    __mylangMonacoTest?: Window["__mylangMonacoTest"];
  }

  interface Window {
    __mylangMonacoTest?: {
      getMarkers(): Array<{
        message: string;
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      }>;
      getHoverAt(position: { lineNumber: number; column: number }): Promise<{
        contents: string[];
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        } | null;
      } | null>;
      getPosition(): { lineNumber: number; column: number } | null;
      getValue(): string;
      runAction(actionId: string): Promise<void>;
      setPosition(position: { lineNumber: number; column: number }): void;
      setValue(value: string): Promise<void>;
      waitForDiagnostics(): Promise<void>;
    };
  }
}

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

function toEditorRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
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
  setStatus("Compiler Connected", "connected");

  let diagnosticsTimer: number | undefined;
  let pendingDiagnosticsResolve: (() => void) | null = null;

  const runDiagnostics = (): void => {
    pullDiagnostics(model, sessionCache);
    const currentSaved = resolveWorkspaceContent(bundledSample, storage, WORKSPACE_STORAGE_KEY);
    updateDirtyState(model.getValue() !== currentSaved);
    pendingDiagnosticsResolve?.();
    pendingDiagnosticsResolve = null;
  };

  model.onDidChangeContent(() => {
    if (diagnosticsTimer !== undefined) {
      window.clearTimeout(diagnosticsTimer);
    }
    diagnosticsTimer = window.setTimeout(() => {
      runDiagnostics();
    }, 150);
  });

  const testApi: NonNullable<Window["__mylangMonacoTest"]> = {
    getMarkers() {
      return monaco.editor.getModelMarkers({ resource: model.uri }).map((marker) => ({
        message: marker.message,
        startLineNumber: marker.startLineNumber,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLineNumber,
        endColumn: marker.endColumn,
      }));
    },
    async getHoverAt(position) {
      const hover = getHoverInfo(model, position, sessionCache);
      if (!hover) {
        return null;
      }
      const contents = Array.isArray(hover.contents)
        ? hover.contents.map((content) => typeof content === "string" ? content : content.value)
        : [typeof hover.contents === "string" ? hover.contents : hover.contents.value];
      return {
        contents,
        range: hover.range ? toEditorRange(hover.range) : null,
      };
    },
    getPosition() {
      return editor.getPosition();
    },
    getValue() {
      return model.getValue();
    },
    async runAction(actionId) {
      await editor.getAction(actionId)?.run();
    },
    setPosition(position) {
      editor.setPosition(position);
      editor.focus();
    },
    async setValue(value) {
      model.setValue(value);
      await this.waitForDiagnostics();
    },
    async waitForDiagnostics() {
      if (diagnosticsTimer !== undefined) {
        window.clearTimeout(diagnosticsTimer);
        diagnosticsTimer = undefined;
      }
      await new Promise<void>((resolve) => {
        pendingDiagnosticsResolve = resolve;
        window.setTimeout(() => runDiagnostics(), 0);
      });
    },
  };
  window.__mylangMonacoTest = testApi;
  container.__mylangMonacoTest = testApi;
  container.dataset.testReady = "true";

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
