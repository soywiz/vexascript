import { LANGUAGE_FILE_EXTENSION } from "../../compiler/language";
import { dirname, extname, resolve } from "../../compiler/utils/path";

export interface NativeProgramPaths {
  sourcePath: string;
  buildRoot: string;
  cppPath: string;
  executablePath: string;
}

export type NativeOptimization = "-O0" | "-O1" | "-O2" | "-O3" | "-Os" | "-Oz" | "-Og";

function nativeTempRoot(): string {
  return "/tmp";
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

async function ensureOilpan(root: string): Promise<{ gcRoot: string; libraryPath: string }> {
  const archive = resolve(root, "oilpan-standalone-main.zip");
  const info = await nativeStatPath(archive);
  const cacheRoot = resolve(nativeTempRoot(), "vexascript-native", `oilpan-${info.mtimeMs}`);
  const extractedRoot = resolve(cacheRoot, "oilpan-standalone-main");
  const gcRoot = resolve(extractedRoot, "gc");
  const buildRoot = resolve(gcRoot, "build-vexa");
  const libraryPath = resolve(buildRoot, "liboilpan_gc.a");
  if (await pathExists(libraryPath)) return { gcRoot, libraryPath };

  await ensureDependencySources(archive, cacheRoot, resolve(gcRoot, "CMakeLists.txt"));
  if (!(await pathExists(libraryPath))) {
    await runNativeCommand("cmake", [
      "-S", gcRoot,
      "-B", buildRoot,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_CXX_COMPILER=g++",
    ], process.cwd());
    await runNativeCommand("cmake", ["--build", buildRoot, "--parallel"], process.cwd());
  }
  return { gcRoot, libraryPath };
}

async function ensureMimalloc(root: string): Promise<string> {
  const archive = resolve(root, "mimalloc-3.4.3.zip");
  const info = await nativeStatPath(archive);
  const cacheRoot = resolve(nativeTempRoot(), "vexascript-native", `mimalloc-3.4.3-${info.mtimeMs}`);
  const extractedRoot = resolve(cacheRoot, "mimalloc-3.4.3");
  const buildRoot = resolve(extractedRoot, "build-vexa");
  const objectPath = resolve(buildRoot, "mimalloc.o");
  if (await pathExists(objectPath)) return objectPath;

  await ensureDependencySources(archive, cacheRoot, resolve(extractedRoot, "CMakeLists.txt"));
  if (!(await pathExists(objectPath))) {
    await runNativeCommand("cmake", [
      "-S", extractedRoot,
      "-B", buildRoot,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_C_COMPILER=gcc",
      "-DMI_BUILD_SHARED=OFF",
      "-DMI_BUILD_TESTS=OFF",
      "-DMI_OVERRIDE=ON",
    ], process.cwd());
    await runNativeCommand("cmake", ["--build", buildRoot, "--target", "mimalloc-obj-target", "--parallel"], process.cwd());
  }
  return objectPath;
}

export async function compileNativeExecutable(
  cppPath: string,
  executablePath: string,
  extraFlags: string[] = [],
  optimization: NativeOptimization = "-O2"
): Promise<void> {
  const root = nativeRuntimeRoot();
  const oilpan = await ensureOilpan(root);
  const mimallocObjectPath = await ensureMimalloc(root);
  await nativeCreateDirectory(dirname(executablePath), true);
  const args = [
    "-std=c++20",
    optimization,
    "-DNDEBUG",
    "-fno-rtti",
    "-DCPPGC_IS_STANDALONE=1",
    "-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO",
    "-DV8_LOGGING_LEVEL=0",
    cppPath,
    `-I${root}`,
    `-I${oilpan.gcRoot}`,
    `-I${resolve(oilpan.gcRoot, "include")}`,
    mimallocObjectPath,
    oilpan.libraryPath,
    "-pthread",
    "-framework", "CoreFoundation",
    "-ldl",
    ...extraFlags,
    "-o", executablePath,
  ];
  await runNativeCommand("g++", args, process.cwd());
}
