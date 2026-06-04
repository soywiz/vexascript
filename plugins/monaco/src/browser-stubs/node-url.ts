/**
 * Browser-compatible replacements for the Node.js "url" module functions
 * used by the compiler LSP modules.
 */

export function fileURLToPath(url: string | { toString(): string }): string {
  const str = typeof url === "string" ? url : url.toString();
  // Strip "file://" prefix (handles file:///path and file://hostname/path).
  return decodeURIComponent(str.replace(/^file:\/\/[^/]*/, ""));
}

export interface FileURL {
  href: string;
  pathname: string;
  toString(): string;
}

export function pathToFileURL(path: string): FileURL {
  const href =
    path.startsWith("/")
      ? "file://" + path
      : "file:///" + path.replace(/\\/g, "/");
  return {
    href,
    pathname: path,
    toString: () => href,
  };
}
