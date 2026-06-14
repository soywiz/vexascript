import { fileExists, isDirectory } from "./utils/fs";
import { dirname, resolve } from "./utils/path";
import { vfs } from "./vfs";

export interface VexaProject {
  projectDir: string;
  dependencies: Record<string, string>;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  libs: string[];
  types: string[];
}

interface PackageJsonConfig {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface TsConfigJson {
  compilerOptions?: {
    jsx?: unknown;
    jsxFactory?: unknown;
    jsxFragmentFactory?: unknown;
    jsxImportSource?: unknown;
    lib?: unknown;
    types?: unknown;
  };
}

interface CachedJsonFile<T> {
  mtimeMs: number;
  value: T | null;
}

const jsonFileCache = new Map<string, CachedJsonFile<unknown>>();

function stringRecord(section: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(section ?? {})) {
    if (typeof version === "string") {
      result[name] = version;
    }
  }
  return result;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  let mtimeMs = -1;
  try {
    mtimeMs = (await vfs().stat(path)).mtimeMs;
  } catch {
    return null;
  }

  const cached = jsonFileCache.get(path);
  if (cached?.mtimeMs === mtimeMs) {
    return cached.value as T | null;
  }

  try {
    const value = JSON.parse(await vfs().readFile(path)) as T;
    jsonFileCache.set(path, { mtimeMs, value });
    return value;
  } catch {
    jsonFileCache.set(path, { mtimeMs, value: null });
    return null;
  }
}

function mergeDependencies(pkg: PackageJsonConfig | null): Record<string, string> {
  if (!pkg) {
    return {};
  }
  return {
    ...stringRecord(pkg.dependencies),
    ...stringRecord(pkg.optionalDependencies),
    ...stringRecord(pkg.peerDependencies)
  };
}

function libsFromTsConfig(tsconfig: TsConfigJson | null): string[] {
  const lib = tsconfig?.compilerOptions?.lib;
  if (!Array.isArray(lib)) {
    return [];
  }

  return lib.filter((entry): entry is string => typeof entry === "string");
}

function typesFromTsConfig(tsconfig: TsConfigJson | null): string[] {
  const types = tsconfig?.compilerOptions?.types;
  if (!Array.isArray(types)) {
    return [];
  }

  return types.filter((entry): entry is string => typeof entry === "string");
}

function jsxOptionsFromTsConfig(tsconfig: TsConfigJson | null): { jsxFactory?: string; jsxFragmentFactory?: string } {
  const compilerOptions = tsconfig?.compilerOptions;
  if (!compilerOptions) {
    return {};
  }

  const jsxFactory = typeof compilerOptions.jsxFactory === "string"
    ? compilerOptions.jsxFactory
    : undefined;
  const jsxFragmentFactory = typeof compilerOptions.jsxFragmentFactory === "string"
    ? compilerOptions.jsxFragmentFactory
    : undefined;
  if (jsxFactory || jsxFragmentFactory) {
    return {
      ...(jsxFactory ? { jsxFactory } : {}),
      ...(jsxFragmentFactory ? { jsxFragmentFactory } : {})
    };
  }

  // VexaScript currently emits classic JSX factory calls. TypeScript projects that
  // use Preact's automatic runtime still describe the intended JSX provider via
  // jsxImportSource, so map that common configuration to Preact's classic
  // factories until VexaScript has an automatic JSX runtime emitter.
  if (compilerOptions.jsxImportSource === "preact") {
    return { jsxFactory: "h", jsxFragmentFactory: "Fragment" };
  }

  return {};
}

export async function loadProject(startPath: string): Promise<VexaProject | null> {
  const startDir = (await fileExists(startPath) && !(await isDirectory(startPath)))
    ? dirname(startPath)
    : startPath;

  let dir = resolve(startDir);
  let packageDir: string | null = null;
  let tsconfig: TsConfigJson | null = null;
  let dependencies: Record<string, string> = {};
  while (true) {
    if (!packageDir) {
      const packageJsonPath = resolve(dir, "package.json");
      const pkg = await readJsonFile<PackageJsonConfig>(packageJsonPath);
      if (pkg) {
        packageDir = dir;
        dependencies = mergeDependencies(pkg);
      }
    }

    if (!tsconfig) {
      tsconfig = await readJsonFile<TsConfigJson>(resolve(dir, "tsconfig.json"));
    }

    if (packageDir && tsconfig) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!packageDir && !tsconfig) {
    return null;
  }

  return {
    projectDir: packageDir ?? resolve(startDir),
    dependencies,
    libs: libsFromTsConfig(tsconfig),
    types: typesFromTsConfig(tsconfig),
    ...jsxOptionsFromTsConfig(tsconfig)
  };
}
