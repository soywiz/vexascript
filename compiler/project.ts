import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileExists, isDirectory } from "./utils/fs";

export interface MylangProject {
  projectDir: string;
  dependencies: Record<string, string>;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
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
  };
}

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
  if (!(await fileExists(path))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
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

  // MyLang currently emits classic JSX factory calls. TypeScript projects that
  // use Preact's automatic runtime still describe the intended JSX provider via
  // jsxImportSource, so map that common configuration to Preact's classic
  // factories until MyLang has an automatic JSX runtime emitter.
  if (compilerOptions.jsxImportSource === "preact") {
    return { jsxFactory: "h", jsxFragmentFactory: "Fragment" };
  }

  return {};
}

export async function loadProject(startPath: string): Promise<MylangProject | null> {
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
    ...jsxOptionsFromTsConfig(tsconfig)
  };
}
