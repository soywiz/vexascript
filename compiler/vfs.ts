export class VfsDirEntry {
  constructor(public name: string, public isFile: boolean, public isDirectory: boolean) {}
}

export class VfsStat {
  constructor(public mtimeMs: number, public isFile: boolean = false, public isDirectory: boolean = false) {}
}

function unconfiguredVfsError(): Error {
  return new Error("VFS has not been initialized. Call setVfs(...) before using compiler filesystem APIs.");
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

class UnconfiguredVfs extends Vfs {
  override async readFile(_path: string): Promise<string> {
    throw unconfiguredVfsError();
  }

  override async writeFile(_file: string, _data: string | ArrayBufferView): Promise<void> {
    throw unconfiguredVfsError();
  }

  override async fileExists(_path: string): Promise<boolean> {
    throw unconfiguredVfsError();
  }

  override async unlink(_file: string): Promise<void> {
    throw unconfiguredVfsError();
  }

  override async stat(_path: string): Promise<VfsStat> {
    throw unconfiguredVfsError();
  }

  override async readDir(_path: string): Promise<VfsDirEntry[]> {
    throw unconfiguredVfsError();
  }
}

const unconfiguredVfs = new UnconfiguredVfs()

class VfsReference {
  constructor(public ref: Vfs) {}
}

export const globalVfs = new VfsReference(unconfiguredVfs)

export function vfs() {
  return globalVfs.ref ?? unconfiguredVfs
}

export function setVfs(value: Vfs) {
  globalVfs.ref = value
}
