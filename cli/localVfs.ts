import { readFile as nodeReadFile, readdir as nodeReadDir, stat as nodeStat, writeFile as nodeWriteFile, unlink } from "node:fs/promises";
import { setVfs, Vfs, VfsDirEntry, VfsStat } from "../compiler/vfs";

export class LocalVfs extends Vfs {
  override async readFile(path: string): Promise<string> {
    return await nodeReadFile(path, "utf8");
  }

  override async writeFile(path: string, content: string | ArrayBufferView) {
    return await nodeWriteFile(path, content as string | NodeJS.ArrayBufferView);
  }

  override async unlink(path: string) {
    return await unlink(path);
  }

  override async stat(path: string): Promise<VfsStat> {
    try {
      const stats = await nodeStat(path);
      return {
        mtimeMs: stats.mtimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory()
      };
    } catch {
      throw new Error(`File '${path}' doesn't exists`);
    }
  }

  override async readDir(path: string): Promise<VfsDirEntry[]> {
    try {
      const entries = await nodeReadDir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory()
      }));
    } catch {
      throw new Error(`File '${path} doesn't exists`);
    }
  }
}

export const localVfs: Vfs = new LocalVfs();

setVfs(localVfs);
