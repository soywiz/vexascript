import { LANGUAGE_FILE_EXTENSION } from "../../compiler/language";
import { dirname, extname, resolve } from "../../compiler/utils/path";

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
  await nativeCreateDirectory(dirname(executablePath), true);
  const args = [
    "-std=c++20",
    optimization,
    "-DNDEBUG",
    "-fno-rtti",
    "-DCPPGC_IS_STANDALONE=1",
    ...(process.platform === "darwin" ? ["-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO"] : []),
    ...(process.platform === "win32" ? ["-D_WIN32_WINNT=0x0A00", "-DNOMINMAX"] : []),
    "-DV8_LOGGING_LEVEL=0",
    ...cppPaths,
    `-I${root}`,
    `-I${oilpan.gcRoot}`,
    `-I${resolve(oilpan.gcRoot, "include")}`,
    ...(process.platform === "darwin"
      ? [`-Wl,-force_load,${mimallocLibraryPath}`]
      : ["-Wl,--whole-archive", mimallocLibraryPath, "-Wl,--no-whole-archive"]),
    oilpan.libraryPath,
    ...(process.platform === "win32"
      ? ["-ldbghelp", "-lshlwapi", "-lwinmm"]
      : ["-pthread", ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : ["-ldl"])]),
    ...extraFlags,
    "-o", executablePath,
  ];
  await runNativeCompiler(args);
}
