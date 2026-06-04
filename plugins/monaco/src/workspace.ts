export const STATIC_WORKSPACE_URI = "file:///main.my";
export const WORKSPACE_STORAGE_KEY = "mylang.monaco.main";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolveWorkspaceContent(
  defaultContent: string,
  storage?: StorageLike,
  storageKey = WORKSPACE_STORAGE_KEY
): string {
  const stored = storage?.getItem(storageKey);
  return stored ?? defaultContent;
}

export function persistWorkspaceContent(
  content: string,
  storage?: StorageLike,
  storageKey = WORKSPACE_STORAGE_KEY
): void {
  storage?.setItem(storageKey, content);
}
