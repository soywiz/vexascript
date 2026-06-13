import {
  normalizeWorkspacePath as normalizePath,
  workspacePathBasename as basename,
  workspacePathDirname as dirname,
  workspacePathToUri
} from "./workspacePaths";

export const MAIN_DOCUMENT_URI = "file:///main.vx";
export const RUNTIME_DOCUMENT_URI = "file:///es2025.d.ts";
export const WORKSPACE_STORAGE_KEY = "vexa.monaco.workspace.v1";
export const WORKSPACE_SESSION_STORAGE_KEY = "vexa.monaco.workspace-session.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceFolder {
  kind: "folder";
  path: string;
  uri: string;
  label: string;
  readOnly?: boolean;
}

export interface WorkspaceFile {
  kind: "file";
  path: string;
  uri: string;
  label: string;
  language: "vexa";
  content: string;
  readOnly?: boolean;
}

export type WorkspaceEntry = WorkspaceFolder | WorkspaceFile;

interface StoredWorkspaceSnapshot {
  folders: string[];
  files: Array<{
    path: string;
    language: "vexa" | "typescript";
    content: string;
  }>;
}

export interface StoredWorkspaceSessionSnapshot {
  activeUri: string;
  lineNumber: number;
  column: number;
}


export function pathToUri(path: string): string {
  return workspacePathToUri(path);
}

function normalizeEditorLanguage(language?: "vexa" | "typescript"): "vexa" {
  return language === "typescript" ? "vexa" : "vexa";
}

function guessLanguage(_path: string): "vexa" {
  return "vexa";
}

export function createFileEntry(
  path: string,
  content: string,
  options: {
    language?: "vexa" | "typescript";
    readOnly?: boolean;
    uri?: string;
  } = {}
): WorkspaceFile {
  const normalized = normalizePath(path);
  return {
    kind: "file",
    path: normalized,
    uri: options.uri ?? pathToUri(normalized),
    label: basename(normalized),
    language: normalizeEditorLanguage(options.language ?? guessLanguage(normalized)),
    content,
    ...(options.readOnly ? { readOnly: true } : {}),
  };
}

export function createFolderEntry(path: string, readOnly = false): WorkspaceFolder {
  const normalized = normalizePath(path);
  return {
    kind: "folder",
    path: normalized,
    uri: pathToUri(normalized),
    label: basename(normalized),
    ...(readOnly ? { readOnly: true } : {}),
  };
}

function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    if (left.path === "/") return -1;
    if (right.path === "/") return 1;
    if (dirname(left.path) !== dirname(right.path)) {
      return left.path.localeCompare(right.path);
    }
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
}

function ensureFolderPaths(paths: Iterable<string>): string[] {
  const folderPaths = new Set<string>(["/"]);
  for (const path of paths) {
    let current = normalizePath(path);
    while (current !== "/") {
      current = dirname(current);
      folderPaths.add(current);
      if (current === "/") break;
    }
  }
  return Array.from(folderPaths.values()).sort();
}

function serializeEditableWorkspace(entries: WorkspaceEntry[]): StoredWorkspaceSnapshot {
  const editableFolders = entries
    .filter((entry): entry is WorkspaceFolder => entry.kind === "folder" && !entry.readOnly && entry.path !== "/")
    .map((entry) => entry.path);
  const editableFiles = entries
    .filter((entry): entry is WorkspaceFile => entry.kind === "file" && !entry.readOnly)
    .map((entry) => ({
      path: entry.path,
      language: entry.language,
      content: entry.content,
    }));
  return {
    folders: editableFolders,
    files: editableFiles,
  };
}

function deserializeWorkspaceSnapshot(
  snapshotText: string | null,
  defaultMainContent: string
): WorkspaceEntry[] | null {
  if (!snapshotText) return null;
  try {
    const parsed = JSON.parse(snapshotText) as Partial<StoredWorkspaceSnapshot>;
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    const fileEntries = files
      .filter((entry): entry is StoredWorkspaceSnapshot["files"][number] =>
        !!entry &&
        typeof entry.path === "string" &&
        typeof entry.content === "string" &&
        (entry.language === "vexa" || entry.language === "typescript")
      )
      .map((entry) => createFileEntry(entry.path, entry.content, { language: normalizeEditorLanguage(entry.language) }));
    if (fileEntries.length === 0) {
      fileEntries.push(createFileEntry("/main.vx", defaultMainContent, { language: "vexa" }));
    }
    if (!fileEntries.some((entry) => entry.path === "/main.vx")) {
      fileEntries.unshift(createFileEntry("/main.vx", defaultMainContent, { language: "vexa" }));
    }
    const folderPaths = new Set<string>(folders.filter((entry): entry is string => typeof entry === "string"));
    for (const path of ensureFolderPaths([...folderPaths, ...fileEntries.map((entry) => entry.path)])) {
      folderPaths.add(path);
    }
    const folderEntries = Array.from(folderPaths.values()).map((path) => createFolderEntry(path));
    return sortEntries([...folderEntries, ...fileEntries]);
  } catch {
    return null;
  }
}

export function resolveWorkspaceEntries(
  defaultMainContent: string,
  runtimeContent: string,
  storage?: StorageLike,
  storageKey = WORKSPACE_STORAGE_KEY
): WorkspaceEntry[] {
  const editableEntries =
    deserializeWorkspaceSnapshot(storage?.getItem(storageKey) ?? null, defaultMainContent) ??
    sortEntries([
      createFolderEntry("/"),
      createFileEntry("/main.vx", defaultMainContent, { language: "vexa" }),
    ]);

  const runtimeEntries: WorkspaceEntry[] = [
    createFolderEntry("/runtime", true),
    createFileEntry("/runtime/es2025.d.ts", runtimeContent, {
      language: "vexa",
      readOnly: true,
      uri: RUNTIME_DOCUMENT_URI,
    }),
  ];

  return sortEntries([...editableEntries.filter((entry) => entry.path !== "/runtime" && entry.path !== "/runtime/es2025.d.ts"), ...runtimeEntries]);
}

export function persistWorkspaceEntries(
  entries: WorkspaceEntry[],
  storage?: StorageLike,
  storageKey = WORKSPACE_STORAGE_KEY
): void {
  storage?.setItem(storageKey, JSON.stringify(serializeEditableWorkspace(entries)));
}

export function resolveWorkspaceSession(
  entries: WorkspaceEntry[],
  storage?: StorageLike,
  storageKey = WORKSPACE_SESSION_STORAGE_KEY
): StoredWorkspaceSessionSnapshot | null {
  const snapshotText = storage?.getItem(storageKey) ?? null;
  if (!snapshotText) {
    return null;
  }
  try {
    const parsed = JSON.parse(snapshotText) as Partial<StoredWorkspaceSessionSnapshot>;
    if (
      typeof parsed.activeUri !== "string" ||
      typeof parsed.lineNumber !== "number" ||
      typeof parsed.column !== "number"
    ) {
      return null;
    }
    const entry = findEntryByUri(entries, parsed.activeUri);
    if (!entry || entry.kind !== "file") {
      return null;
    }
    return {
      activeUri: parsed.activeUri,
      lineNumber: Math.max(1, Math.floor(parsed.lineNumber)),
      column: Math.max(1, Math.floor(parsed.column)),
    };
  } catch {
    return null;
  }
}

export function persistWorkspaceSession(
  session: StoredWorkspaceSessionSnapshot,
  storage?: StorageLike,
  storageKey = WORKSPACE_SESSION_STORAGE_KEY
): void {
  storage?.setItem(storageKey, JSON.stringify(session));
}

export function clampWorkspaceSessionToFile(
  session: StoredWorkspaceSessionSnapshot,
  content: string
): StoredWorkspaceSessionSnapshot {
  const lines = content.split("\n");
  const safeLineNumber = Math.max(1, Math.min(session.lineNumber, Math.max(1, lines.length)));
  const lineText = lines[safeLineNumber - 1] ?? "";
  const safeColumn = Math.max(1, Math.min(session.column, lineText.length + 1));
  return {
    activeUri: session.activeUri,
    lineNumber: safeLineNumber,
    column: safeColumn,
  };
}

export function listChildren(entries: WorkspaceEntry[], folderPath: string): WorkspaceEntry[] {
  const normalized = normalizePath(folderPath);
  return sortEntries(entries.filter((entry) => dirname(entry.path) === normalized && entry.path !== normalized));
}

export function findEntryByUri(entries: WorkspaceEntry[], uri: string): WorkspaceEntry | undefined {
  return entries.find((entry) => entry.uri === uri);
}

export function updateFileContent(entries: WorkspaceEntry[], uri: string, content: string): WorkspaceEntry[] {
  return entries.map((entry) =>
    entry.kind === "file" && entry.uri === uri
      ? { ...entry, content }
      : entry
  );
}

export function createFileInWorkspace(
  entries: WorkspaceEntry[],
  parentFolderPath: string,
  name: string
): WorkspaceEntry[] {
  const trimmed = name.trim();
  if (!trimmed) return entries;
  const folderPath = normalizePath(parentFolderPath);
  const fullPath = normalizePath(folderPath === "/" ? `/${trimmed}` : `${folderPath}/${trimmed}`);
  if (entries.some((entry) => entry.path === fullPath)) return entries;
  return sortEntries([...entries, createFileEntry(fullPath, "", { language: guessLanguage(fullPath) })]);
}

export function createFolderInWorkspace(
  entries: WorkspaceEntry[],
  parentFolderPath: string,
  name: string
): WorkspaceEntry[] {
  const trimmed = name.trim();
  if (!trimmed) return entries;
  const folderPath = normalizePath(parentFolderPath);
  const fullPath = normalizePath(folderPath === "/" ? `/${trimmed}` : `${folderPath}/${trimmed}`);
  if (entries.some((entry) => entry.path === fullPath)) return entries;
  return sortEntries([...entries, createFolderEntry(fullPath)]);
}

export function deleteWorkspaceEntry(
  entries: WorkspaceEntry[],
  targetPath: string
): WorkspaceEntry[] {
  const normalized = normalizePath(targetPath);
  const target = entries.find((entry) => entry.path === normalized);
  if (!target || target.readOnly || normalized === "/") {
    return entries;
  }
  const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return sortEntries(entries.filter((entry) =>
    entry.path !== normalized &&
    !entry.path.startsWith(prefix)
  ));
}
