/**
 * Browser-compatible subset of Node.js "path" module (POSIX-style).
 * Only the functions actually used by the compiler LSP modules are implemented.
 */

export function basename(p: string, ext?: string): string {
  const normalized = p.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? "";
  if (ext && base.endsWith(ext)) return base.slice(0, -ext.length);
  return base;
}

export function dirname(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return normalized.slice(0, idx);
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return "";
  return base.slice(idx);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join("/"));
}

export function resolve(...parts: string[]): string {
  let result = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = (parts[i] ?? "").replace(/\\/g, "/");
    result = result ? p + "/" + result : p;
    if (p.startsWith("/")) break;
  }
  return normalize(result || ".");
}

export function relative(from: string, to: string): string {
  const f = normalize(from.replace(/\\/g, "/")).split("/").filter(Boolean);
  const t = normalize(to.replace(/\\/g, "/")).split("/").filter(Boolean);
  let common = 0;
  while (common < f.length && f[common] === t[common]) common++;
  const up = f.length - common;
  const rel = [...Array(up).fill(".."), ...t.slice(common)];
  return rel.join("/") || ".";
}

function normalize(p: string): string {
  const leading = p.startsWith("/") ? "/" : "";
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!leading) out.push("..");
    } else if (part !== "." && part !== "") {
      out.push(part);
    }
  }
  return leading + (out.join("/") || (leading ? "" : "."));
}

export const sep = "/";
export const delimiter = ":";

const path = { basename, dirname, extname, join, resolve, relative, sep, delimiter };
export default path;
