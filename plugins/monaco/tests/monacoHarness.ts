import { expect, type Page } from "@playwright/test";

export interface EditorPosition {
  lineNumber: number;
  column: number;
}

declare global {
  interface Window {
    __mylangMonacoTest?: MonacoTestApi;
  }
}

interface EditorPositionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface MonacoTestApi {
  setValue(value: string): Promise<void> | void;
  getValue(): string;
  setPosition(position: EditorPosition): Promise<void> | void;
  getPosition(): EditorPosition | null;
  runAction(actionId: string): Promise<void>;
  getHoverAt(position: EditorPosition): Promise<{ contents: string[]; range: EditorPositionRange | null } | null>;
  getMarkers(): Array<{ message: string; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }>;
  waitForDiagnostics(): Promise<void>;
}

export async function gotoMonaco(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Compiler Connected")).toBeVisible();
  await expect(page.locator("#editor-container")).toHaveAttribute("data-test-ready", "true");
}

export async function setEditorValue(page: Page, value: string): Promise<void> {
  await page.evaluate(async (nextValue) => {
    const container = document.getElementById("editor-container") as HTMLElement & {
      __mylangMonacoTest?: MonacoTestApi;
    } | null;
    const api = container?.__mylangMonacoTest ?? window.__mylangMonacoTest;
    if (!api) {
      throw new Error("Monaco test API is not ready");
    }
    await api.setValue(nextValue);
    await api.waitForDiagnostics();
  }, value);
}

export async function setEditorPosition(page: Page, position: EditorPosition): Promise<void> {
  await page.evaluate(async (nextPosition) => {
    const container = document.getElementById("editor-container") as HTMLElement & {
      __mylangMonacoTest?: MonacoTestApi;
    } | null;
    const api = container?.__mylangMonacoTest ?? window.__mylangMonacoTest;
    if (!api) {
      throw new Error("Monaco test API is not ready");
    }
    await api.setPosition(nextPosition);
  }, position);
}

export async function getEditorPosition(page: Page): Promise<EditorPosition | null> {
  return page.evaluate(() => {
    const container = document.getElementById("editor-container") as HTMLElement & {
      __mylangMonacoTest?: MonacoTestApi;
    } | null;
    const api = container?.__mylangMonacoTest ?? window.__mylangMonacoTest;
    if (!api) {
      throw new Error("Monaco test API is not ready");
    }
    return api.getPosition();
  });
}

export async function runEditorAction(page: Page, actionId: string): Promise<void> {
  await page.evaluate(async (nextActionId) => {
    const container = document.getElementById("editor-container") as HTMLElement & {
      __mylangMonacoTest?: MonacoTestApi;
    } | null;
    const api = container?.__mylangMonacoTest ?? window.__mylangMonacoTest;
    if (!api) {
      throw new Error("Monaco test API is not ready");
    }
    await api.runAction(nextActionId);
  }, actionId);
}

export async function getHoverText(
  page: Page,
  position: EditorPosition
): Promise<string[] | null> {
  return page.evaluate(async (nextPosition) => {
    const container = document.getElementById("editor-container") as HTMLElement & {
      __mylangMonacoTest?: MonacoTestApi;
    } | null;
    const api = container?.__mylangMonacoTest ?? window.__mylangMonacoTest;
    if (!api) {
      throw new Error("Monaco test API is not ready");
    }
    const hover = await api.getHoverAt(nextPosition);
    return hover?.contents ?? null;
  }, position);
}

export async function getMarkerMessages(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const container = document.getElementById("editor-container") as HTMLElement & {
      __mylangMonacoTest?: MonacoTestApi;
    } | null;
    const api = container?.__mylangMonacoTest ?? window.__mylangMonacoTest;
    if (!api) {
      throw new Error("Monaco test API is not ready");
    }
    return api.getMarkers().map((marker) => marker.message);
  });
}
