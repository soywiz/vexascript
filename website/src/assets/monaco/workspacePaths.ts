/**
 * Path helpers for browser virtual workspaces (Monaco workspace tabs, website
 * embeds). Unlike `compiler/utils/path.ts`, these treat paths as opaque
 * workspace keys: they force a leading slash and collapse duplicate slashes
 * but never resolve `.`/`..` segments or consult a working directory.
 */

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/g, "/");
}

export function workspacePathDirname(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.slice(0, lastSlash);
}

export function workspacePathBasename(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

export function workspacePathToUri(path: string): string {
  return `file://${normalizeWorkspacePath(path)}`;
}
