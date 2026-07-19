export async function readFile(path: string, _options?: unknown): Promise<any> {
  return await readTextFile(path);
}

export async function writeFile(path: string, contents: any, _options?: unknown): Promise<void> {
  await writeTextFile(path, contents as string);
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await nativeCreateDirectory(path, options?.recursive === true);
}

export async function stat(path: string): Promise<any> {
  const value = await nativeStatPath(path);
  return {
    mtimeMs: value.mtimeMs,
    isFile: () => value.isFile,
    isDirectory: () => value.isDirectory,
  };
}

export async function readdir(path: string, options?: { withFileTypes?: boolean }): Promise<any[]> {
  const entries = await nativeReadDirectory(path);
  if (options?.withFileTypes !== true) return entries.map((entry: any) => entry.name);
  return entries.map((entry: any) => ({
    name: entry.name,
    isFile: () => entry.isFile,
    isDirectory: () => entry.isDirectory,
  }));
}

export async function unlink(path: string): Promise<void> {
  await nativeRemovePath(path, false);
}

export async function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
  try {
    await nativeRemovePath(path, options?.recursive === true);
  } catch (error) {
    if (options?.force !== true) throw error;
  }
}

export async function copyFile(source: string, target: string): Promise<void> {
  await nativeCopyFile(source, target);
}

export async function access(path: string): Promise<void> {
  await nativeStatPath(path);
}
