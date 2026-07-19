import { vfs } from "compiler/vfs";

export async function fileExists(path: string): Promise<boolean> {
  return await vfs().fileExists(path)
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const result = await vfs().stat(path)
    return result.isDirectory || false
  } catch {
    return false
  }
}
