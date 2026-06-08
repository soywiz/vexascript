/**
 * Browser stub for Node.js file-system promises APIs.
 * Cross-file features treat the browser as having no local disk access and
 * gracefully fall back when these operations reject or return empty results.
 */

function createEnoentError(operation: string, path: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${operation} '${path}'`),
    { code: "ENOENT" }
  );
}

export async function access(path: string): Promise<void> {
  throw createEnoentError("access", path);
}

export async function readFile(path: string, _options?: unknown): Promise<string> {
  throw createEnoentError("open", path);
}

export async function readdir(_path: string, _options?: unknown): Promise<string[]> {
  return [];
}

export async function stat(path: string): Promise<never> {
  throw createEnoentError("stat", path);
}

export async function writeFile(_path: string, _data: unknown, _options?: unknown): Promise<void> {
  // no-op in browser
}

export async function unlink(path: string): Promise<void> {
  throw createEnoentError("unlink", path);
}

const fsPromises = { access, readFile, readdir, stat, writeFile, unlink };
export default fsPromises;
