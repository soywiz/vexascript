// Node.js custom loader: transpiles TypeScript with esbuild and redirects
// "vitest" imports to our minimal shim.
import { transform } from "esbuild";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { resolve as pathResolve, dirname } from "path";

const root = process.cwd();

const vitestURL = pathToFileURL(pathResolve(root, "vitest.ts")).href;

// Directories that may be used as baseUrl roots (from tsconfig baseUrl: ".")
const BASE_URL_ROOTS = ["compiler", "testFixtures"];

function tryRootRelative(specifier) {
  // Check if specifier starts with a known root directory
  const first = specifier.split("/")[0];
  if (!BASE_URL_ROOTS.includes(first)) return null;

  const base = pathResolve(root, specifier);
  for (const ext of ["", ".ts", ".js"]) {
    if (existsSync(base + ext)) return pathToFileURL(base + ext).href;
  }
  // Try index file
  for (const ext of [".ts", ".js"]) {
    const idx = pathResolve(root, specifier, "index" + ext);
    if (existsSync(idx)) return pathToFileURL(idx).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vitest") {
    return { url: vitestURL, shortCircuit: true };
  }

  // Handle baseUrl-relative imports (e.g. "compiler/parser/parser")
  const rootRelative = tryRootRelative(specifier);
  if (rootRelative) {
    return { url: rootRelative, shortCircuit: true };
  }

  // Try normal resolution first
  try {
    return await nextResolve(specifier, context);
  } catch {
    // Fall back: try replacing .js extension with .ts (bundler-style resolution)
    if (specifier.endsWith(".js")) {
      try {
        return await nextResolve(specifier.slice(0, -3) + ".ts", context);
      } catch {}
    }
    // Try appending .ts for bare specifiers
    try {
      return await nextResolve(specifier + ".ts", context);
    } catch {}
    // Re-throw original error
    return nextResolve(specifier, context);
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, "utf8");
    const result = await transform(source, {
      format: "esm",
      loader: url.endsWith(".tsx") ? "tsx" : "ts",
      target: "node20",
      sourcemap: "inline",
      define: {
        __dirname: JSON.stringify(dirname(filePath)),
        __filename: JSON.stringify(filePath),
      },
    });
    return { format: "module", source: result.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
