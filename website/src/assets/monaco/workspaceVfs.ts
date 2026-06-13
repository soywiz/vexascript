import { Vfs, VfsDirEntry, VfsStat } from "compiler/vfs";
import type { WorkspaceEntry } from "./workspace";
import { pathToUri } from "./workspace";
import { normalizeWorkspacePath as normalizePath, workspacePathDirname as dirname } from "./workspacePaths";

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

export class WorkspaceVfs extends Vfs {
  constructor(private readonly options: WorkspaceVfsOptions) {
    super()
  }

  override async readFile(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const uri = pathToUri(normalized);
    const workspaceSource = this.options.readWorkspaceFile(uri);
    if (workspaceSource !== null) {
      return workspaceSource;
    }
    const result = await this.options.fetchText?.(uri)!;
    if (!result) {
      throw new Error(`'${path}' doesn't exists`)
    }
    return result!
  }

  override async stat(path: string): Promise<VfsStat> {
    const normalized = normalizePath(path);
    const entries = this.options.getEntries();
    const entry = entries.find((item) => item.path === normalized);
    if (!entry) {
      const fetched = await this.options.fetchText?.(pathToUri(normalized));
      if (fetched === null || fetched === undefined) {
        throw new Error(`'${path}' doesn't exists`)
      }
        
      return { mtimeMs: contentVersion(fetched), isFile: true, isDirectory: false };
    }
    if (entry.kind === "folder") {
      return { mtimeMs: 0, isFile: false, isDirectory: true };
    }
    const source = this.options.readWorkspaceFile(entry.uri) ?? entry.content;
    return { mtimeMs: contentVersion(source), isFile: true, isDirectory: false };
  }

  override async readDir(path: string): Promise<VfsDirEntry[]> {
    const normalized = normalizePath(path);
    const children = this.options.getEntries().filter((entry) => dirname(entry.path) === normalized && entry.path !== normalized);
    if (children.length === 0 && !this.options.getEntries().some((entry) => entry.path === normalized && entry.kind === "folder")) {
      throw new Error(`'${path}' doesn't exists`)
    }
    return children.map((entry) => ({
      name: entry.label,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "folder"
    }));
  }
}
