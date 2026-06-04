/**
 * Browser stub for the Node.js "fs" module.
 * All file-system operations return "not found" — cross-file LSP features
 * are disabled in the browser worker and will gracefully return empty results.
 */

export function existsSync(_path: string): boolean {
  return false;
}

export function readdirSync(
  _path: string,
  _options?: unknown
): string[] {
  return [];
}

export function readFileSync(
  _path: string,
  _options?: unknown
): string {
  return "";
}

export function statSync(_path: string): never {
  const err: NodeJS.ErrnoException = Object.assign(
    new Error("ENOENT: no such file or directory, stat '" + _path + "'"),
    { code: "ENOENT" }
  );
  throw err;
}

export function writeFileSync(
  _path: string,
  _data: unknown,
  _options?: unknown
): void {
  // no-op in browser
}

const fs = { existsSync, readdirSync, readFileSync, statSync, writeFileSync };
export default fs;
