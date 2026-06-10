import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import {
  createFileInWorkspace,
  createFolderInWorkspace,
  deleteWorkspaceEntry,
  findEntryByUri,
  listChildren,
  MAIN_DOCUMENT_URI,
  persistWorkspaceSession,
  persistWorkspaceEntries,
  resolveWorkspaceSession,
  resolveWorkspaceEntries,
  RUNTIME_DOCUMENT_URI,
  WORKSPACE_SESSION_STORAGE_KEY,
  updateFileContent,
  WORKSPACE_STORAGE_KEY,
  type StorageLike,
} from "./workspace";
import { WorkspaceVfs } from "./workspaceVfs";

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
    const restoredMain = findEntryByUri(restored, MAIN_DOCUMENT_URI);
    expect(restoredMain?.kind === "file" ? restoredMain.content : null).toBe("saved");
    expect(storage.getItem(WORKSPACE_STORAGE_KEY)).not.toBeNull();
    expect(listChildren(restored, "/src").map((entry) => entry.label)).toEqual(["util.my"]);
  });

  it("exposes editable files through the Monaco workspace VFS", async () => {
    const entries = createFileInWorkspace(
      createFolderInWorkspace(resolveWorkspaceEntries("default", "runtime", new MemoryStorage()), "/", "src"),
      "/src",
      "Point.my"
    );
    const pointEntry = entries.find((entry) => entry.kind === "file" && entry.path === "/src/Point.my");
    const vfs = new WorkspaceVfs({
      getEntries: () => entries,
      readWorkspaceFile: (uri) => uri === pointEntry?.uri ? "class Point" : null
    });

    expect(await vfs.fileExists("/src/Point.my")).toBe(true);
    expect(await vfs.readFile("/src/Point.my")).toBe("class Point");
    expect((await vfs.readDir("/src"))?.map((entry) => entry.name)).toEqual(["Point.my"]);
  });

  it("creates runtime and user entries in tree order", () => {
    const entries = resolveWorkspaceEntries("default", "runtime", new MemoryStorage());
    expect(listChildren(entries, "/").map((entry) => entry.label)).toEqual(["runtime", "main.my"]);
    expect(listChildren(entries, "/runtime").map((entry) => entry.label)).toEqual(["es2025.d.ts"]);
  });

  it("deletes editable files and nested folders recursively", () => {
    const entries = createFileInWorkspace(
      createFolderInWorkspace(
        createFileInWorkspace(
          createFolderInWorkspace(resolveWorkspaceEntries("default", "runtime", new MemoryStorage()), "/", "src"),
          "/src",
          "util.my"
        ),
        "/src",
        "nested"
      ),
      "/src/nested",
      "deep.my"
    );

    const withoutFile = deleteWorkspaceEntry(entries, "/src/util.my");
    expect(listChildren(withoutFile, "/src").map((entry) => entry.label)).toEqual(["nested"]);

    const withoutFolder = deleteWorkspaceEntry(withoutFile, "/src/nested");
    expect(listChildren(withoutFolder, "/src").map((entry) => entry.label)).toEqual([]);
  });

  it("does not delete read-only runtime entries", () => {
    const entries = resolveWorkspaceEntries("default", "runtime", new MemoryStorage());
    const next = deleteWorkspaceEntry(entries, "/runtime");
    expect(listChildren(next, "/").map((entry) => entry.label)).toEqual(["runtime", "main.my"]);
    expect(findEntryByUri(next, RUNTIME_DOCUMENT_URI)?.kind === "file" ? findEntryByUri(next, RUNTIME_DOCUMENT_URI)?.label : null).toBe("es2025.d.ts");
  });

  it("persists and restores the active file and cursor position", () => {
    const storage = new MemoryStorage();
    const entries = resolveWorkspaceEntries("default", "runtime", storage);

    persistWorkspaceSession({
      activeUri: MAIN_DOCUMENT_URI,
      lineNumber: 12,
      column: 7,
    }, storage);

    expect(resolveWorkspaceSession(entries, storage)).toEqual({
      activeUri: MAIN_DOCUMENT_URI,
      lineNumber: 12,
      column: 7,
    });
    expect(storage.getItem(WORKSPACE_SESSION_STORAGE_KEY)).not.toBeNull();
  });

  it("ignores a persisted session that points to a missing file", () => {
    const storage = new MemoryStorage();
    const entries = resolveWorkspaceEntries("default", "runtime", storage);

    persistWorkspaceSession({
      activeUri: "file:///missing.my",
      lineNumber: 5,
      column: 2,
    }, storage);

    expect(resolveWorkspaceSession(entries, storage)).toBeNull();
  });
});

describe("monaco workspace VFS", () => {
  it("normalizes paths, exposes entry metadata, and falls back to fetched text", async () => {
    const entries = resolveWorkspaceEntries("default", "runtime", new MemoryStorage());
    const vfs = new WorkspaceVfs({
      getEntries: () => entries,
      readWorkspaceFile: () => null,
      fetchText: async (uri) => uri === "file:///external.ts" ? "export const external = 1" : null,
    });

    expect(await vfs.readFile("external.ts")).toBe("export const external = 1");
    expect(await vfs.fileExists("external.ts")).toBe(true);
    expect(await vfs.stat("external.ts")).toEqual({
      mtimeMs: 1991437531,
      isFile: true,
      isDirectory: false,
    });
    expect(await vfs.stat("/runtime")).toEqual({ mtimeMs: 0, isFile: false, isDirectory: true });
    expect((await vfs.readDir("runtime"))?.map((entry) => entry.name)).toEqual(["es2025.d.ts"]);
  });

  it("returns null for missing files and unknown directories", async () => {
    const entries = resolveWorkspaceEntries("default", "runtime", new MemoryStorage());
    const vfs = new WorkspaceVfs({
      getEntries: () => entries,
      readWorkspaceFile: () => null,
      fetchText: async () => null,
    });

    expect(await vfs.readFile("missing.my")).toBeNull();
    expect(await vfs.fileExists("missing.my")).toBe(false);
    expect(await vfs.stat("missing.my")).toBeNull();
    expect(await vfs.readDir("missing")).toBeNull();
  });
});
