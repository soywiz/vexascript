function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function currentWorkingDirectory(): string {
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    return normalizeSlashes(process.cwd());
  }
  return "/";
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function normalizePath(path: string): string {
  const normalized = normalizeSlashes(path);
  const drive = /^[A-Za-z]:\//.test(normalized) ? normalized.slice(0, 2) : undefined;
  const absolute = isAbsolutePath(normalized);
  const parts = (drive ? normalized.slice(2) : normalized).split("/");
  const output: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (output.length > 0 && output[output.length - 1] !== "..") {
        output.pop();
      } else if (!absolute) {
        output.push("..");
      }
      continue;
    }
    output.push(part);
  }

  if (drive) {
    return output.length > 0 ? `${drive}/${output.join("/")}` : `${drive}/`;
  }
  if (absolute) {
    return output.length > 0 ? `/${output.join("/")}` : "/";
  }
  return output.join("/") || ".";
}

function pathParts(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === "/" || normalized === ".") {
    return normalized === "/" ? [] : ["."];
  }
  return normalized.split("/").filter((part) => part.length > 0);
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  if (normalized === ".") {
    return ".";
  }
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return ".";
  }
  if (index === 0) {
    return "/";
  }
  if (index === 2 && /^[A-Za-z]:\//.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized) || normalized === ".") {
    return normalized === "/" ? "" : ".";
  }
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function extname(path: string): string {
  const base = basename(path);
  if (base === "" || base === "." || base === "..") {
    return "";
  }
  const index = base.lastIndexOf(".");
  if (index <= 0) {
    return "";
  }
  return base.slice(index);
}

export function resolve(...paths: string[]): string {
  let resolved = "";

  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const current = normalizeSlashes(paths[index] ?? "");
    if (current.length === 0) {
      continue;
    }
    resolved = resolved.length > 0 ? `${current}/${resolved}` : current;
    if (isAbsolutePath(current)) {
      return normalizePath(resolved);
    }
  }

  return normalizePath(`${currentWorkingDirectory()}/${resolved}`);
}

export function fileURLToPath(url: string | URL): string {
  const href = typeof url === "string" ? url : url.href;
  const parsed = new URL(href);
  if (parsed.protocol !== "file:") {
    throw new TypeError(`Expected file URL but received ${parsed.protocol}`);
  }
  return normalizePath(decodeURIComponent(parsed.pathname));
}

export function pathToFileURL(path: string): URL {
  const absolutePath = resolve(path);
  const encodedPath = absolutePath
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
  return new URL(`file://${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`);
}

export function relative(from: string, to: string): string {
  const fromPath = resolve(from);
  const toPath = resolve(to);

  if (fromPath === toPath) {
    return "";
  }

  const fromParts = pathParts(fromPath).filter((part) => part !== ".");
  const toParts = pathParts(toPath).filter((part) => part !== ".");
  let shared = 0;

  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }

  const up = new Array(fromParts.length - shared).fill("..");
  const down = toParts.slice(shared);
  const result = [...up, ...down].join("/");
  return result || "";
}
