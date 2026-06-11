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

export class Vfs {
  async readFile(path: string): Promise<string> {
    throw new Error(`readFile: ${path}`)
  }
  async writeFile(_file: string, _data: string | ArrayBufferView): Promise<void> {
    throw new Error(`writeFile: ${_file} ${(_data as any)?.length}`)
  }
  async fileExists(path: string): Promise<boolean> {
    try {
      const stat = await this.stat(path)
      return stat.isFile || stat.isDirectory || false
    } catch {
      return false
    }
  }
  async unlink(_file: string): Promise<void> {
    throw new Error(`unlink ${_file}`)
  }
  async stat(_path: string): Promise<VfsStat> {
    throw new Error(`stat ${_path}`)
  }
  async readDir(_path: string): Promise<VfsDirEntry[]> {
    throw new Error(`readDir ${_path}`)
  }
}

export var globalVfs = {} as { ref: Vfs }

export function vfs() {
  return globalVfs.ref
}

export function setVfs(value: Vfs) {
  globalVfs.ref = value
}
