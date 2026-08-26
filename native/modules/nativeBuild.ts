import { LANGUAGE_FILE_EXTENSION } from "../../compiler/language";
import { dirname, extname, resolve } from "../../compiler/utils/path";
import { readFile, readdir } from "./nodeFsPromises";

export interface NativeProgramPaths {
  sourcePath: string;
  buildRoot: string;
  cppPath: string;
  executablePath: string;
}

export type NativeOptimization = "-O0" | "-O1" | "-O2" | "-O3" | "-Os" | "-Oz" | "-Og";

function nativeVexaCacheRoot(): string {
  const home = nativeEnvironmentVariable(process.platform === "win32" ? "USERPROFILE" : "HOME");
  return resolve(home.length > 0 ? home : ".", ".vexascript", "native");
}

function nativeTargetArchitecture(): string {
  switch (process.arch) {
    case "arm64": return "aarch64";
    case "x64": return "x86_64";
    case "ia32": return "x86";
    default: return process.arch;
  }
}

function nativeCompilerCacheSuffix(compiler: "clang++" | "g++"): string {
  return compiler === "clang++" ? "clang" : "gcc";
}

async function nativeRuntimeContentFingerprint(runtimeRoot: string): Promise<string> {
  const sourceNames = (await readdir(runtimeRoot))
    .map((name) => name as string)
    .filter((name) => name.endsWith(".cpp") || name.endsWith(".hpp"))
    .sort();
  let hash = 2166136261;
  for (const sourceName of sourceNames) {
    for (let index = 0; index < sourceName.length; index += 1) {
      hash ^= sourceName.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16777619);
    const contents = await readFile(resolve(runtimeRoot, sourceName)) as Uint8Array;
    for (let index = 0; index < contents.length; index += 1) {
      hash ^= contents[index]!;
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function nativeCompilerCommand(): Promise<"clang++" | "g++"> {
  if (process.platform === "win32") return "g++";
  const result = await nativeRunCommandCapture("clang++", ["--version"], process.cwd());
  return result.code === 0 ? "clang++" : "g++";
}

async function runNativeCompiler(args: string[]): Promise<void> {
  const compiler = await nativeCompilerCommand();
  let result = await nativeRunCommandCapture(compiler, args, process.cwd());
  if (result.code !== 0 && process.platform === "linux" && /internal compiler error/i.test(result.stdout + result.stderr)) {
    result = await nativeRunCommandCapture(compiler === "clang++" ? "g++" : "clang++", args, process.cwd());
  }
  if (result.code !== 0) {
    throw new Error(result.stdout || result.stderr || `${compiler} exited with code ${result.code}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await nativeStatPath(path);
    return true;
  } catch {
    return false;
  }
}

async function runNativeCommand(command: string, args: string[], cwd: string): Promise<void> {
  const result = await nativeRunCommandCapture(command, args, cwd);
  if (result.code !== 0) {
    throw new Error(result.stdout || result.stderr || `${command} ${args.join(" ")} exited with code ${result.code}`);
  }
}

export function resolveNativeProgramPaths(
  input: string,
  out?: string,
  buildDir?: string
): NativeProgramPaths {
  const sourcePath = resolve(process.cwd(), input);
  const extension = extname(sourcePath).toLowerCase();
  if (extension !== LANGUAGE_FILE_EXTENSION && extension !== ".ts") {
    throw new Error(`Native compilation expects a ${LANGUAGE_FILE_EXTENSION} or .ts input file: ${sourcePath}`);
  }
  const buildRoot = buildDir ? resolve(process.cwd(), buildDir) : `${sourcePath}.build`;
  const executablePath = resolve(process.cwd(), out ?? sourcePath.replace(/\.[^.]+$/, ""));
  return {
    sourcePath,
    buildRoot,
    cppPath: resolve(buildRoot, "main.cpp"),
    executablePath,
  };
}

async function ensureDependencySources(
  archive: string,
  cacheRoot: string,
  sourceMarker: string
): Promise<void> {
  if (await pathExists(sourceMarker)) return;
  await nativeCreateDirectory(cacheRoot, true);
  await runNativeCommand("cmake", ["-E", "tar", "xf", archive], cacheRoot);
}

async function ensureOilpan(root: string, compiler: "clang++" | "g++"): Promise<{ gcRoot: string; libraryPath: string }> {
  const archive = resolve(root, "oilpan-20260622.zip");
  const compilerSuffix = nativeCompilerCacheSuffix(compiler);
  const dependencyRoot = resolve(nativeVexaCacheRoot(), `oilpan-20260622-${compilerSuffix}`);
  const extractedRoot = resolve(dependencyRoot, "oilpan-standalone-main");
  const gcRoot = resolve(extractedRoot, "gc");
  const buildRoot = resolve(gcRoot, "build-vexa");
  const generatedLibraryPath = resolve(dependencyRoot, "liboilpan_gc.a");
  const libraryPath = resolve(nativeVexaCacheRoot(), `liboilpan-20260622-${process.platform}-${nativeTargetArchitecture()}-${compilerSuffix}.a`);
  if (await pathExists(libraryPath)) return { gcRoot, libraryPath };

  await ensureDependencySources(archive, dependencyRoot, resolve(gcRoot, "CMakeLists.txt"));
  if (!(await pathExists(libraryPath))) {
    await runNativeCommand("cmake", [
      ...(process.platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
      "-S", gcRoot,
      "-B", buildRoot,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_CXX_COMPILER=${compiler}`,
      `-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${dependencyRoot}`,
    ], process.cwd());
    await runNativeCommand("cmake", ["--build", buildRoot, "--parallel"], process.cwd());
    await nativeCopyFile(generatedLibraryPath, libraryPath);
    await nativeRemovePath(generatedLibraryPath, false);
  }
  return { gcRoot, libraryPath };
}

async function ensureMimalloc(root: string, compiler: "clang++" | "g++"): Promise<string> {
  const archive = resolve(root, "mimalloc-3.4.3.zip");
  const compilerSuffix = nativeCompilerCacheSuffix(compiler);
  const dependencyRoot = resolve(nativeVexaCacheRoot(), `mimalloc-3.4.3-${compilerSuffix}`);
  const extractedRoot = resolve(dependencyRoot, "mimalloc-3.4.3");
  const buildRoot = resolve(extractedRoot, "build-vexa");
  const generatedLibraryPath = resolve(buildRoot, "libmimalloc.a");
  const libraryPath = resolve(nativeVexaCacheRoot(), `libmimalloc-3.4.3-${process.platform}-${nativeTargetArchitecture()}-${compilerSuffix}.a`);
  if (await pathExists(libraryPath)) return libraryPath;

  await ensureDependencySources(archive, dependencyRoot, resolve(extractedRoot, "CMakeLists.txt"));
  if (!(await pathExists(libraryPath))) {
    await runNativeCommand("cmake", [
      ...(process.platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
      "-S", extractedRoot,
      "-B", buildRoot,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_C_COMPILER=${compiler === "clang++" ? "clang" : "gcc"}`,
      "-DMI_BUILD_SHARED=OFF",
      "-DMI_BUILD_TESTS=OFF",
      "-DMI_OVERRIDE=ON",
    ], process.cwd());
    await runNativeCommand("cmake", ["--build", buildRoot, "--target", "mimalloc-static", "--parallel"], process.cwd());
    await nativeCopyFile(generatedLibraryPath, libraryPath);
  }
  return libraryPath;
}

async function ensureRuntime(
  root: string,
  gcRoot: string,
  compiler: "clang++" | "g++",
  optimization: NativeOptimization
): Promise<{ libraryPath: string; pchPath?: string }> {
  const compilerSuffix = nativeCompilerCacheSuffix(compiler);
  const cacheRoot = nativeVexaCacheRoot();
  const runtimeRoot = resolve(root, "runtime");
  const runtimeFingerprint = await nativeRuntimeContentFingerprint(runtimeRoot);
  const artifactPrefix = `vexa-runtime-${runtimeFingerprint}-${optimization.slice(1)}-${process.platform}-${nativeTargetArchitecture()}-${compilerSuffix}`;
  const objectExtension = process.platform === "win32" ? ".obj" : ".o";
  const runtimeSources = (await readdir(runtimeRoot))
    .filter((name) => (name as string).endsWith(".cpp"))
    .map((name) => name as string)
    .sort();
  const legacyObjectPaths = runtimeSources.map((source) =>
    resolve(cacheRoot, `${artifactPrefix}-${source.slice(0, -4)}${objectExtension}`));
  const libraryPath = resolve(cacheRoot, `lib${artifactPrefix}.a`);
  const pchPath = compiler === "clang++" ? resolve(cacheRoot, `${artifactPrefix}.pch`) : "";
  const legacyPaths = [
    resolve(cacheRoot, `${artifactPrefix}-sources`),
    ...legacyObjectPaths,
  ];
  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) await nativeRemovePath(legacyPath, true);
  }
  if (await pathExists(libraryPath) && (pchPath.length === 0 || await pathExists(pchPath))) {
    return { libraryPath, ...(pchPath.length > 0 ? { pchPath } : {}) };
  }

  await nativeCreateDirectory(cacheRoot, true);
  const frontendArgs = [
    "-std=c++20",
    optimization,
    "-DNDEBUG",
    "-fno-rtti",
    "-DCPPGC_IS_STANDALONE=1",
    ...(process.platform === "darwin" ? ["-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO"] : []),
    ...(process.platform === "win32" ? ["-D_WIN32_WINNT=0x0A00", "-DNOMINMAX"] : ["-pthread"]),
    "-DV8_LOGGING_LEVEL=0",
    `-I${root}`,
    `-I${gcRoot}`,
    `-I${resolve(gcRoot, "include")}`,
  ];
  if (!(await pathExists(libraryPath))) {
    const objectRoot = resolve(cacheRoot, `${artifactPrefix}-objects`);
    if (await pathExists(objectRoot)) await nativeRemovePath(objectRoot, true);
    await nativeCreateDirectory(objectRoot, true);
    const objectPaths = runtimeSources.map((source) =>
      resolve(objectRoot, `${source.slice(0, -4)}${objectExtension}`));
    try {
      for (let index = 0; index < runtimeSources.length; ++index) {
        const runtimeSource = runtimeSources[index] ?? "";
        const objectPath = objectPaths[index] ?? "";
        const compileArgs = frontendArgs.slice();
        compileArgs.push(resolve(runtimeRoot, runtimeSource), "-c", "-o", objectPath);
        await runNativeCompiler(compileArgs);
      }
      await runNativeCommand("ar", ["rcs", libraryPath, ...objectPaths], process.cwd());
    } finally {
      if (await pathExists(objectRoot)) await nativeRemovePath(objectRoot, true);
    }
  }
  if (pchPath.length > 0 && !(await pathExists(pchPath))) {
    const pchArgs = frontendArgs.slice();
    pchArgs.push("-x", "c++-header", resolve(runtimeRoot, "runtime.hpp"), "-o", pchPath);
    await runNativeCompiler(pchArgs);
  }
  return { libraryPath, ...(pchPath.length > 0 ? { pchPath } : {}) };
}

export async function compileNativeExecutable(
  cppPaths: string[],
  executablePath: string,
  extraFlags: string[] = [],
  optimization: NativeOptimization = "-O2"
): Promise<void> {
  const root = nativeRuntimeRoot();
  const compiler = await nativeCompilerCommand();
  const oilpan = await ensureOilpan(root, compiler);
  const mimallocLibraryPath = await ensureMimalloc(root, compiler);
  const runtime = await ensureRuntime(root, oilpan.gcRoot, compiler, optimization);
  await nativeCreateDirectory(dirname(executablePath), true);
  const args = [
    "-std=c++20",
    optimization,
    "-DNDEBUG",
    "-fno-rtti",
    "-DCPPGC_IS_STANDALONE=1",
    ...(process.platform === "darwin" ? ["-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO"] : []),
    ...(process.platform === "win32" ? ["-D_WIN32_WINNT=0x0A00", "-DNOMINMAX"] : []),
    ...(process.platform === "win32" ? [] : ["-pthread"]),
    "-DV8_LOGGING_LEVEL=0",
    ...(runtime.pchPath
      ? ["-DVEXA_RUNTIME_PRECOMPILED=1", "-include-pch", runtime.pchPath]
      : []),
    ...cppPaths,
    `-I${root}`,
    `-I${oilpan.gcRoot}`,
    `-I${resolve(oilpan.gcRoot, "include")}`,
    ...(process.platform === "darwin"
      ? [`-Wl,-force_load,${mimallocLibraryPath}`]
      : ["-Wl,--whole-archive", mimallocLibraryPath, "-Wl,--no-whole-archive"]),
    ...(process.platform === "darwin"
      ? [`-Wl,-force_load,${runtime.libraryPath}`]
      : ["-Wl,--whole-archive", runtime.libraryPath, "-Wl,--no-whole-archive"]),
    oilpan.libraryPath,
    ...(process.platform === "win32"
      ? ["-ldbghelp", "-lshlwapi", "-lwinmm"]
      : ["-pthread", ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : ["-ldl"])]),
    ...extraFlags,
    "-o", executablePath,
  ];
  await runNativeCompiler(args);
}
