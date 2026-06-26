import { fileExists, isDirectory } from "./utils/fs";
import { dirname, resolve } from "./utils/path";
import { vfs } from "./vfs";

export interface VexaProject {
  projectDir: string;
  dependencies: Record<string, string>;
  importMappings?: Record<string, string>;
  globalSymbols?: VexaGlobalSymbols;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  libs: string[];
  types: string[];
  bundleEntrypoint?: string;
  buildOutputDir?: string;
  serveMappings: VexaServeMapping[];
}

export interface VexaServeMapping {
  from: string;
  to: string;
}

export interface VexaGlobalSymbols {
  paths: string[];
  emit: "globalThis" | "assume";
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

interface CompilerOptionsConfig {
  compilerOptions?: {
    jsx?: unknown;
    jsxFactory?: unknown;
    jsxFragmentFactory?: unknown;
    jsxImportSource?: unknown;
    lib?: unknown;
    types?: unknown;
  };
}

interface VexaScriptConfigJson extends CompilerOptionsConfig {
  entrypoint?: unknown;
  outDir?: unknown;
  outputDir?: unknown;
  imports?: unknown;
  importMappings?: unknown;
  globalSymbols?: unknown;
  serveMappings?: unknown;
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

function jsxOptionsFromConfig(config: CompilerOptionsConfig | null): { jsxFactory?: string; jsxFragmentFactory?: string } {
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

  // VexaScript currently emits classic JSX factory calls. TypeScript projects that
  // use Preact's automatic runtime still describe the intended JSX provider via
  // jsxImportSource, so map that common configuration to Preact's classic
  // factories until VexaScript has an automatic JSX runtime emitter.
  if (compilerOptions.jsxImportSource === "preact") {
    return { jsxFactory: "h", jsxFragmentFactory: "Fragment" };
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

function importMappingsFromConfig(configDir: string, config: VexaScriptConfigJson | null): Record<string, string> {
  const rawMappings = config?.importMappings ?? config?.imports;
  if (!rawMappings || typeof rawMappings !== "object" || Array.isArray(rawMappings)) {
    return {};
  }
  const mappings: Record<string, string> = {};
  for (const [specifier, target] of Object.entries(rawMappings as Record<string, unknown>)) {
    if (typeof target === "string" && specifier.length > 0) {
      mappings[specifier] = resolve(configDir, target);
    }
  }
  return mappings;
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

export async function loadProject(startPath: string): Promise<VexaProject | null> {
  const startDir = (await fileExists(startPath) && !(await isDirectory(startPath)))
    ? dirname(startPath)
    : startPath;

  let dir = resolve(startDir);
  let packageDir: string | null = null;
  let tsconfig: TsConfigJson | null = null;
  let vexaConfigDir: string | null = null;
  let vexaConfig: VexaScriptConfigJson | null = null;
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

    if (!vexaConfig) {
      const candidate = await readJsonFile<VexaScriptConfigJson>(resolve(dir, "vexascript.json"));
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
  const globalSymbols = globalSymbolsFromConfig(configDir, vexaConfig);

  return {
    projectDir: packageDir ?? resolve(startDir),
    dependencies,
    ...(Object.keys(importMappings).length > 0 ? { importMappings } : {}),
    ...(globalSymbols.paths.length > 0 ? { globalSymbols } : {}),
    libs: libsFromConfig(config),
    types: typesFromConfig(config),
    serveMappings,
    ...(bundleEntrypoint ? { bundleEntrypoint } : {}),
    ...(buildOutputDir ? { buildOutputDir } : {}),
    ...jsxOptionsFromConfig(config)
  };
}
