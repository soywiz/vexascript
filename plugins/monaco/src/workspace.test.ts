import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
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
} from "./workspace";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("monaco static workspace", () => {
  it("uses bundled content when storage is empty", () => {
    const entries = resolveWorkspaceEntries("default", "runtime", new MemoryStorage());
    expect(findEntryByUri(entries, MAIN_DOCUMENT_URI)).toEqual({
      kind: "file",
      path: "/main.my",
      uri: MAIN_DOCUMENT_URI,
      label: "main.my",
      language: "mylang",
      content: "default",
    });
    expect(findEntryByUri(entries, RUNTIME_DOCUMENT_URI)).toEqual({
      kind: "file",
      path: "/runtime/es2025.d.ts",
      uri: RUNTIME_DOCUMENT_URI,
      label: "es2025.d.ts",
      language: "typescript",
      content: "runtime",
      readOnly: true,
    });
  });

  it("persists editable workspace files and restores them", () => {
    const storage = new MemoryStorage();
    const initial = resolveWorkspaceEntries("default", "runtime", storage);
    const withFolder = createFolderInWorkspace(initial, "/", "src");
    const withFile = createFileInWorkspace(withFolder, "/src", "util.my");
    const edited = updateFileContent(withFile, MAIN_DOCUMENT_URI, "saved");
    persistWorkspaceEntries(edited, storage);

    const restored = resolveWorkspaceEntries("default", "runtime", storage);
    expect(findEntryByUri(restored, MAIN_DOCUMENT_URI)?.kind === "file" ? findEntryByUri(restored, MAIN_DOCUMENT_URI)?.content : null).toBe("saved");
    expect(storage.getItem(WORKSPACE_STORAGE_KEY)).not.toBeNull();
    expect(listChildren(restored, "/src").map((entry) => entry.label)).toEqual(["util.my"]);
  });

  it("creates runtime and user entries in tree order", () => {
    const entries = resolveWorkspaceEntries("default", "runtime", new MemoryStorage());
    expect(listChildren(entries, "/").map((entry) => entry.label)).toEqual(["runtime", "main.my"]);
    expect(listChildren(entries, "/runtime").map((entry) => entry.label)).toEqual(["es2025.d.ts"]);
  });
});
