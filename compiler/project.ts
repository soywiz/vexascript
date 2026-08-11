import { dirname, resolve } from "./utils/path";
import { vfs, type Vfs } from "./vfs";
import { canonicalSyntaxFromConfig, type CanonicalSyntax } from "./canonicalSyntax";

export interface VexaProject {
  projectDir: string;
  dependencies: Record<string, string>;
  importMappings?: Record<string, string>;
  nativeImportMappings?: Record<string, string>;
  baseUrl?: string;
  globalSymbols?: VexaGlobalSymbols;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
  libs: string[];
  types: string[];
  bundleEntrypoint?: string;
  buildOutputDir?: string;
  serveMappings: VexaServeMapping[];
  canonicalSyntax?: CanonicalSyntax;
}

export interface VexaServeMapping {
  from: string;
  to: string;
}

export interface VexaGlobalSymbols {
  paths: string[];
  emit: "globalThis" | "assume";
}

type CompilerOptionsRecord = Record<string, any> & {
  jsx?: unknown;
  jsxFactory?: unknown;
  jsxFragmentFactory?: unknown;
  jsxImportSource?: unknown;
  lib?: unknown;
  types?: unknown;
  baseUrl?: unknown;
};
type PackageJsonConfig = Record<string, any> & {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};
type CompilerOptionsConfig = Record<string, any> & { compilerOptions?: CompilerOptionsRecord };
type TsConfigJson = CompilerOptionsConfig;
type VexaScriptConfigJson = CompilerOptionsConfig & {
  entrypoint?: unknown;
  outDir?: unknown;
  outputDir?: unknown;
  imports?: unknown;
  importMappings?: unknown;
  nativeImports?: unknown;
  globalSymbols?: unknown;
  serveMappings?: unknown;
  canonicalSyntax?: unknown;
};

class CachedJsonFile {
  constructor(public mtimeMs: number, public value: unknown | null) {}
}

const jsonFileCaches = new WeakMap<Vfs, Map<string, CachedJsonFile>>();

function stringRecord(section: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(section ?? {})) {
    if (typeof version === "string") {
      result[name] = version;
    }
  }
  return result;
}

function jsonFileCache(activeVfs: Vfs): Map<string, CachedJsonFile> {
  let cache = jsonFileCaches.get(activeVfs);
  if (!cache) {
    cache = new Map<string, CachedJsonFile>();
    jsonFileCaches.set(activeVfs, cache);
  }
  return cache;
}

async function readJsonFile<T>(path: string, activeVfs: Vfs): Promise<T | null> {
  let mtimeMs: number = -1;
  try {
    mtimeMs = (await activeVfs.stat(path)).mtimeMs;
  } catch {
    return null;
  }

  const cache = jsonFileCache(activeVfs);
  const cached = cache.get(path);
  if (cached?.mtimeMs === mtimeMs) {
    return cached.value as T | null;
  }

  try {
    const value = JSON.parse(await activeVfs.readFile(path)) as T;
    cache.set(path, new CachedJsonFile(mtimeMs, value));
    return value;
  } catch {
    cache.set(path, new CachedJsonFile(mtimeMs, null));
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

function libsFromConfig(config: CompilerOptionsConfig | null): string[] {
  const lib = config?.compilerOptions?.lib;
  if (!Array.isArray(lib)) {
    return [];
  }

  return lib.filter((entry): entry is string => typeof entry === "string");
}

function typesFromConfig(config: CompilerOptionsConfig | null): string[] {
  const types = config?.compilerOptions?.types;
  if (!Array.isArray(types)) {
    return [];
  }

  return types.filter((entry): entry is string => typeof entry === "string");
}

function jsxOptionsFromConfig(config: CompilerOptionsConfig | null): {
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
} {
  const compilerOptions = config?.compilerOptions;
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

  // VexaScript emits classic JSX factory calls. TypeScript projects that use
  // Preact's automatic runtime still describe the provider via jsxImportSource,
  // so use private factory names that the module graph binds to Preact's classic
  // exports without requiring user imports or colliding with local identifiers.
  if (compilerOptions.jsxImportSource === "preact") {
    return {
      jsxFactory: "__vexaJsxFactory",
      jsxFragmentFactory: "__vexaJsxFragment",
      jsxImportSource: "preact"
    };
  }

  return {};
}

function mergeCompilerOptionsConfigs(
  tsconfig: TsConfigJson | null,
  vexaConfig: VexaScriptConfigJson | null
): CompilerOptionsConfig | null {
  const compilerOptions = {
    ...(tsconfig?.compilerOptions ?? {}),
    ...(vexaConfig?.compilerOptions ?? {})
  };
  return Object.keys(compilerOptions).length > 0 ? { compilerOptions } : null;
}

function normalizeServeMappingTarget(target: string): string | null {
  const normalized = resolve("/", target).slice(1);
  return normalized.length > 0 ? normalized : null;
}

function normalizeServeMapping(configDir: string, fromValue: unknown, toValue: unknown): VexaServeMapping | null {
  const from = typeof fromValue === "string"
    ? resolve(configDir, fromValue)
    : null;
  const to = typeof toValue === "string"
    ? normalizeServeMappingTarget(toValue)
    : null;
  return from && to ? { from, to } : null;
}

function serveMappingsFromConfig(configDir: string, config: VexaScriptConfigJson | null): VexaServeMapping[] {
  const mappings: VexaServeMapping[] = [];
  const serveMappings = config?.serveMappings;
  if (Array.isArray(serveMappings)) {
    for (const entry of serveMappings) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const mapping = normalizeServeMapping(
        configDir,
        (entry as { from?: unknown }).from,
        (entry as { to?: unknown }).to
      );
      if (mapping) {
        mappings.push(mapping);
      }
    }
    return mappings;
  }

  if (!serveMappings || typeof serveMappings !== "object") {
    return mappings;
  }

  for (const [fromValue, toValue] of Object.entries(serveMappings as Record<string, unknown>)) {
    const mapping = normalizeServeMapping(configDir, fromValue, toValue);
    if (mapping) {
      mappings.push(mapping);
    }
  }
  return mappings;
}

function resolvedImportMappings(configDir: string, rawMappings: unknown): Record<string, string> {
  if (!rawMappings || typeof rawMappings !== "object" || Array.isArray(rawMappings)) {
    return {};
  }
  const mappings: Record<string, string> = {};
  const sourceMappings = rawMappings as Record<string, unknown>;
  for (const specifier of Object.keys(sourceMappings)) {
    const target = sourceMappings[specifier];
    if (typeof target === "string" && specifier.length > 0) {
      mappings[specifier] = resolve(configDir, target);
    }
  }
  return mappings;
}

function importMappingsFromConfig(configDir: string, config: VexaScriptConfigJson | null): Record<string, string> {
  return resolvedImportMappings(configDir, config?.importMappings ?? config?.imports);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function globalSymbolsFromConfig(configDir: string, config: VexaScriptConfigJson | null): VexaGlobalSymbols {
  const globalSymbols = config?.globalSymbols;
  if (Array.isArray(globalSymbols)) {
    return {
      paths: stringArray(globalSymbols).map((entry) => resolve(configDir, entry)),
      emit: "globalThis"
    };
  }
  if (!globalSymbols || typeof globalSymbols !== "object") {
    return { paths: [], emit: "globalThis" };
  }
  const record = globalSymbols as Record<string, unknown>;
  const paths = stringArray(record["paths"] ?? record["files"] ?? record["include"]).map((entry) => resolve(configDir, entry));
  const emit = record["emit"] === "assume" ? "assume" : "globalThis";
  return { paths, emit };
}

export async function loadProject(startPath: string, activeVfs: Vfs = vfs()): Promise<VexaProject | null> {
  let startPathIsFile = false;
  try {
    startPathIsFile = (await activeVfs.stat(startPath)).isFile;
  } catch {
    // A missing start path is treated as a directory candidate, matching the
    // previous project-discovery behavior.
  }
  const startDir = startPathIsFile ? dirname(startPath) : startPath;

  let dir = resolve(startDir);
  let packageDir: string | null = null;
  let tsconfig: TsConfigJson | null = null;
  let tsconfigDir: string | null = null;
  let vexaConfigDir: string | null = null;
  let vexaConfig: VexaScriptConfigJson | null = null;
  let dependencies: Record<string, string> = {};
  while (true) {
    if (!packageDir) {
      const packageJsonPath = resolve(dir, "package.json");
      const pkg = await readJsonFile<PackageJsonConfig>(packageJsonPath, activeVfs);
      if (pkg) {
        packageDir = dir;
        dependencies = mergeDependencies(pkg);
      }
    }

    if (!tsconfig) {
      tsconfig = await readJsonFile<TsConfigJson>(resolve(dir, "tsconfig.json"), activeVfs);
      if (tsconfig) {
        tsconfigDir = dir;
      }
    }

    if (!vexaConfig) {
      const candidate = await readJsonFile<VexaScriptConfigJson>(resolve(dir, "vexascript.json"), activeVfs);
      if (candidate) {
        vexaConfig = candidate;
        vexaConfigDir = dir;
      }
    }

    if (packageDir && tsconfig && vexaConfig) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!packageDir && !tsconfig && !vexaConfig) {
    return null;
  }

  const config = mergeCompilerOptionsConfigs(tsconfig, vexaConfig);
  const configDir = resolve(vexaConfigDir ?? startDir);
  const bundleEntrypoint = typeof vexaConfig?.entrypoint === "string" ? resolve(configDir, vexaConfig.entrypoint) : undefined;
  const configuredBuildOutputDir = typeof vexaConfig?.outDir === "string"
    ? vexaConfig.outDir
    : typeof vexaConfig?.outputDir === "string"
      ? vexaConfig.outputDir
      : undefined;
  const buildOutputDir = configuredBuildOutputDir ? resolve(configDir, configuredBuildOutputDir) : undefined;
  const serveMappings = serveMappingsFromConfig(configDir, vexaConfig);
  const importMappings = importMappingsFromConfig(configDir, vexaConfig);
  const nativeImportMappings = resolvedImportMappings(configDir, vexaConfig?.nativeImports);
  const globalSymbols = globalSymbolsFromConfig(configDir, vexaConfig);
  const canonicalSyntax = canonicalSyntaxFromConfig(vexaConfig?.canonicalSyntax);
  const configuredBaseUrl = typeof vexaConfig?.compilerOptions?.baseUrl === "string"
    ? vexaConfig.compilerOptions.baseUrl
    : typeof tsconfig?.compilerOptions?.baseUrl === "string"
      ? tsconfig.compilerOptions.baseUrl
      : undefined;
  const baseUrlConfigDir = typeof vexaConfig?.compilerOptions?.baseUrl === "string"
    ? vexaConfigDir ?? startDir
    : tsconfigDir ?? startDir;
  const baseUrl = configuredBaseUrl ? resolve(baseUrlConfigDir, configuredBaseUrl) : undefined;

  return {
    projectDir: packageDir ?? resolve(startDir),
    dependencies,
    ...(Object.keys(importMappings).length > 0 ? { importMappings } : {}),
    ...(Object.keys(nativeImportMappings).length > 0 ? { nativeImportMappings } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(globalSymbols.paths.length > 0 ? { globalSymbols } : {}),
    libs: libsFromConfig(config),
    types: typesFromConfig(config),
    serveMappings,
    ...(canonicalSyntax ? { canonicalSyntax } : {}),
    ...(bundleEntrypoint !== undefined ? { bundleEntrypoint } : {}),
    ...(buildOutputDir !== undefined ? { buildOutputDir } : {}),
    ...jsxOptionsFromConfig(config)
  };
}
