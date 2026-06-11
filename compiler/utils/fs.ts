import { vfs } from "compiler/vfs";

export async function fileExists(path: string): Promise<boolean> {
  return vfs().fileExists(path)
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await vfs().stat(path))?.isDirectory || false
  } catch {
    return false
  }
}
