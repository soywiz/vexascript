import { access, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "../compiler/utils/path";
import { LANGUAGE_FILE_EXTENSION } from "../compiler/language";
import { fileURLToPath } from "node:url";
import { runCommand } from "./io";

export interface NativeBuildResult {
  executablePath: string;
  oilpanLibraryPath: string;
}

export interface NativeProgramPaths {
  sourcePath: string;
  buildRoot: string;
  cppPath: string;
  executablePath: string;
}

export function nativeProgramPaths(
  input: string,
  out: string | undefined,
  buildDir: string | undefined,
  cwd = process.cwd()
): NativeProgramPaths {
  const sourcePath = resolve(cwd, input);
  if (extname(sourcePath).toLowerCase() !== LANGUAGE_FILE_EXTENSION) {
    throw new Error(`Native compilation expects a ${LANGUAGE_FILE_EXTENSION} input file: ${sourcePath}`);
  }
  const buildRoot = buildDir ? resolve(cwd, buildDir) : `${sourcePath}.build`;
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  return {
    sourcePath,
    buildRoot,
    cppPath: resolve(buildRoot, "main.cpp"),
    executablePath: out
      ? resolve(cwd, out)
      : sourcePath.replace(/\.[^.]+$/, executableSuffix),
  };
}

function nativeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../native");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureOilpanSources(root: string): Promise<string> {
  const archive = resolve(root, "oilpan-standalone-main.zip");
  if (!(await exists(archive))) {
    throw new Error(`Oilpan source archive was not found: ${archive}`);
  }
  const archiveInfo = await stat(archive);
  const cacheRoot = resolve(
    tmpdir(),
    "vexascript-native",
    `oilpan-${archiveInfo.size}-${Math.trunc(archiveInfo.mtimeMs)}`
  );
  const extractedRoot = resolve(cacheRoot, "oilpan-standalone-main");
  if (await exists(resolve(extractedRoot, "gc", "CMakeLists.txt"))) {
    return extractedRoot;
  }

  await mkdir(cacheRoot, { recursive: true });
  await runCommand("unzip", ["-q", archive, "-d", cacheRoot]);
  return extractedRoot;
}

async function ensureOilpanLibrary(root: string): Promise<{ gcRoot: string; libraryPath: string }> {
  const extractedRoot = await ensureOilpanSources(root);
  const gcRoot = resolve(extractedRoot, "gc");
  const buildRoot = resolve(gcRoot, "build-vexa");
  const libraryPath = resolve(buildRoot, "liboilpan_gc.a");
  if (!(await exists(libraryPath))) {
    await runCommand("cmake", [
      "-S", gcRoot,
      "-B", buildRoot,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_CXX_COMPILER=g++",
    ]);
    await runCommand("cmake", ["--build", buildRoot, "--parallel"]);
  }
  return { gcRoot, libraryPath };
}

function defaultExecutablePath(cppPath: string): string {
  return extname(cppPath).toLowerCase() === ".cpp"
    ? cppPath.slice(0, -".cpp".length)
    : `${cppPath}.native`;
}

export function nativeCompilerArguments(
  cppPath: string,
  executablePath: string,
  root: string,
  gcRoot: string,
  libraryPath: string,
  platform: NodeJS.Platform = process.platform,
  options: { sanitizers?: boolean; debug?: boolean; gcStress?: boolean } = {}
): string[] {
  const instrumented = options.sanitizers === true;
  return [
    "-std=c++20",
    instrumented ? "-O1" : "-O2",
    ...(options.debug || instrumented ? ["-g"] : []),
    ...(instrumented ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : []),
    "-fno-rtti",
    "-DCPPGC_IS_STANDALONE=1",
    "-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO",
    "-DV8_LOGGING_LEVEL=0",
    ...(options.gcStress ? ["-DVEXA_NATIVE_GC_STRESS=1"] : []),
    cppPath,
    `-I${root}`,
    `-I${gcRoot}`,
    `-I${resolve(gcRoot, "include")}`,
    libraryPath,
    "-pthread",
    ...(platform === "darwin" ? ["-framework", "CoreFoundation"] : ["-ldl"]),
    "-o",
    executablePath,
  ];
}

export async function compileNativeExecutable(
  cppPath: string,
  executablePath = defaultExecutablePath(cppPath)
): Promise<NativeBuildResult> {
  const root = nativeRoot();
  const { gcRoot, libraryPath } = await ensureOilpanLibrary(root);
  await mkdir(dirname(executablePath), { recursive: true });

  const args = nativeCompilerArguments(cppPath, executablePath, root, gcRoot, libraryPath, process.platform, {
    sanitizers: process.env["VEXA_NATIVE_SANITIZERS"] === "1",
    debug: process.env["VEXA_NATIVE_DEBUG"] === "1",
    gcStress: process.env["VEXA_NATIVE_GC_STRESS"] === "1",
  });
  await runCommand("g++", args);
  return { executablePath, oilpanLibraryPath: libraryPath };
}
