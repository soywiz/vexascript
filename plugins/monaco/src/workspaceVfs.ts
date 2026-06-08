import type { Vfs, VfsDirEntry, VfsStat } from "compiler/vfs";
import type { WorkspaceEntry } from "./workspace";
import { pathToUri } from "./workspace";

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/g, "/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.slice(0, lastSlash);
}

function contentVersion(content: string): number {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (Math.imul(hash, 31) + content.charCodeAt(index)) | 0;
  }
  return content.length + (hash >>> 0);
}

export interface WorkspaceVfsOptions {
  getEntries(): WorkspaceEntry[];
  readWorkspaceFile(uri: string): string | null;
  fetchText?(uri: string): Promise<string | null>;
}

export class WorkspaceVfs implements Vfs {
  constructor(private readonly options: WorkspaceVfsOptions) {}

  async readFile(path: string): Promise<string | null> {
    const normalized = normalizePath(path);
    const uri = pathToUri(normalized);
    const workspaceSource = this.options.readWorkspaceFile(uri);
    if (workspaceSource !== null) {
      return workspaceSource;
    }
    return this.options.fetchText?.(uri) ?? null;
  }

  async fileExists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const uri = pathToUri(normalized);
    const entry = this.options.getEntries().find((item) => item.kind === "file" && item.path === normalized);
    if (entry) {
      return true;
    }
    if (this.options.readWorkspaceFile(uri) !== null) {
      return true;
    }
    return (await this.options.fetchText?.(uri)) !== null;
  }

  async stat(path: string): Promise<VfsStat | null> {
    const normalized = normalizePath(path);
    const entries = this.options.getEntries();
    const entry = entries.find((item) => item.path === normalized);
    if (!entry) {
      const fetched = await this.options.fetchText?.(pathToUri(normalized));
      return fetched === null || fetched === undefined
        ? null
        : { mtimeMs: contentVersion(fetched), isFile: true, isDirectory: false };
    }
    if (entry.kind === "folder") {
      return { mtimeMs: 0, isFile: false, isDirectory: true };
    }
    const source = this.options.readWorkspaceFile(entry.uri) ?? entry.content;
    return { mtimeMs: contentVersion(source), isFile: true, isDirectory: false };
  }

  async readDir(path: string): Promise<VfsDirEntry[] | null> {
    const normalized = normalizePath(path);
    const children = this.options.getEntries().filter((entry) => dirname(entry.path) === normalized && entry.path !== normalized);
    if (children.length === 0 && !this.options.getEntries().some((entry) => entry.path === normalized && entry.kind === "folder")) {
      return null;
    }
    return children.map((entry) => ({
      name: entry.label,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "folder"
    }));
  }
}
