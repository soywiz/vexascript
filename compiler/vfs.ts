import { readFile as nodeReadFile, readdir as nodeReadDir, stat as nodeStat } from "node:fs/promises";

export interface VfsDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface VfsStat {
  mtimeMs: number;
  isFile?: boolean;
  isDirectory?: boolean;
}

export interface Vfs {
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  stat(path: string): Promise<VfsStat | null>;
  readDir(path: string): Promise<VfsDirEntry[] | null>;
}

export class LocalVfs implements Vfs {
  async readFile(path: string): Promise<string | null> {
    try {
      return await nodeReadFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const stats = await nodeStat(path);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<VfsStat | null> {
    try {
      const stats = await nodeStat(path);
      return {
        mtimeMs: stats.mtimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory()
      };
    } catch {
      return null;
    }
  }

  async readDir(path: string): Promise<VfsDirEntry[] | null> {
    try {
      const entries = await nodeReadDir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory()
      }));
    } catch {
      return null;
    }
  }
}

export const localVfs: Vfs = new LocalVfs();
