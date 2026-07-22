import { access, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, posix, resolve, win32 } from "node:path";
import { LANGUAGE_FILE_EXTENSION } from "../compiler/language";
import { fileURLToPath } from "node:url";
import { runCommand } from "./io";

export interface NativeBuildResult {
  executablePath: string;
  oilpanLibraryPath: string;
  mimallocObjectPath?: string;
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
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform
): NativeProgramPaths {
  const path = platform === "win32" ? win32 : posix;
  const sourcePath = path.resolve(cwd, input);
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  if (sourceExtension !== LANGUAGE_FILE_EXTENSION && sourceExtension !== ".ts") {
    throw new Error(`Native compilation expects a ${LANGUAGE_FILE_EXTENSION} or .ts input file: ${sourcePath}`);
  }
  const buildRoot = buildDir ? path.resolve(cwd, buildDir) : `${sourcePath}.build`;
  const selectedExecutablePath = out
    ? path.resolve(cwd, out)
    : sourcePath.replace(/\.[^.]+$/, "");
  const executablePath = platform === "win32" && path.extname(selectedExecutablePath) === ""
    ? `${selectedExecutablePath}.exe`
    : selectedExecutablePath;
  return {
    sourcePath,
    buildRoot,
    cppPath: path.resolve(buildRoot, "main.cpp"),
    executablePath,
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

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export async function withNativeBuildLock<T>(
  lockRoot: string,
  action: () => Promise<T>
): Promise<T> {
  await mkdir(dirname(lockRoot), { recursive: true });
  const startedAt = Date.now();
  const staleAfterMs = 10 * 60 * 1000;
  const timeoutMs = 15 * 60 * 1000;

  while (true) {
    try {
      await mkdir(lockRoot);
      break;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      try {
        const lockInfo = await stat(lockRoot);
        if (Date.now() - lockInfo.mtimeMs > staleAfterMs) {
          await rm(lockRoot, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (errnoCode(statError) !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for native build cache lock: ${lockRoot}`);
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
}

async function nativeArchiveCachePaths(
  root: string,
  archiveName: string,
  cachePrefix: string,
  extractedDirectory: string
): Promise<{
  archive: string;
  cacheRoot: string;
  extractedRoot: string;
}> {
  const archive = resolve(root, archiveName);
  if (!(await exists(archive))) {
    throw new Error(`Native dependency source archive was not found: ${archive}`);
  }
  const archiveInfo = await stat(archive);
  const cacheRoot = resolve(
    tmpdir(),
    "vexascript-native",
    `${cachePrefix}-${archiveInfo.size}-${Math.trunc(archiveInfo.mtimeMs)}`
  );
  const extractedRoot = resolve(cacheRoot, extractedDirectory);
  return { archive, cacheRoot, extractedRoot };
}

async function ensureNativeDependencySources(
  archive: string,
  cacheRoot: string,
  sourceMarker: string
): Promise<void> {
  if (await exists(sourceMarker)) return;

  await mkdir(cacheRoot, { recursive: true });
  await runCommand("cmake", ["-E", "tar", "xf", archive], { cwd: cacheRoot });
}

export function nativeCmakeConfigureArguments(
  gcRoot: string,
  buildRoot: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return [
    ...(platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
    "-S", gcRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_CXX_COMPILER=g++",
  ];
}

async function ensureOilpanLibrary(root: string): Promise<{ gcRoot: string; libraryPath: string }> {
  const { archive, cacheRoot, extractedRoot } = await nativeArchiveCachePaths(
    root,
    "oilpan-standalone-main.zip",
    "oilpan",
    "oilpan-standalone-main"
  );
  const gcRoot = resolve(extractedRoot, "gc");
  const buildRoot = resolve(gcRoot, "build-vexa");
  const libraryPath = resolve(buildRoot, "liboilpan_gc.a");
  if (await exists(libraryPath)) {
    return { gcRoot, libraryPath };
  }

  await withNativeBuildLock(`${cacheRoot}.lock`, async () => {
    await ensureNativeDependencySources(archive, cacheRoot, resolve(gcRoot, "CMakeLists.txt"));
    if (await exists(libraryPath)) return;
    await runCommand("cmake", nativeCmakeConfigureArguments(gcRoot, buildRoot));
    await runCommand("cmake", ["--build", buildRoot, "--parallel"]);
  });
  return { gcRoot, libraryPath };
}

function defaultExecutablePath(cppPath: string): string {
  return extname(cppPath).toLowerCase() === ".cpp"
    ? cppPath.slice(0, -".cpp".length)
    : `${cppPath}.native`;
}

interface NativeCompilerOptions {
  sanitizers?: boolean;
  debug?: boolean;
  gcStress?: boolean;
  mimallocObjectPath?: string;
  extraFlags?: string[];
}

export function nativeMimallocCmakeConfigureArguments(
  sourceRoot: string,
  buildRoot: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return [
    ...(platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
    "-S", sourceRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_C_COMPILER=gcc",
    "-DMI_BUILD_SHARED=OFF",
    "-DMI_BUILD_TESTS=OFF",
    "-DMI_OVERRIDE=ON",
  ];
}

async function ensureMimallocObject(root: string, platform: NodeJS.Platform): Promise<string> {
  const { archive, cacheRoot, extractedRoot } = await nativeArchiveCachePaths(
    root,
    "mimalloc-3.4.3.zip",
    "mimalloc-3.4.3",
    "mimalloc-3.4.3"
  );
  const buildRoot = resolve(extractedRoot, "build-vexa");
  const objectPath = resolve(buildRoot, platform === "win32" ? "mimalloc.obj" : "mimalloc.o");
  if (await exists(objectPath)) return objectPath;

  await withNativeBuildLock(`${cacheRoot}.lock`, async () => {
    await ensureNativeDependencySources(archive, cacheRoot, resolve(extractedRoot, "CMakeLists.txt"));
    if (await exists(objectPath)) return;
    await runCommand("cmake", nativeMimallocCmakeConfigureArguments(extractedRoot, buildRoot, platform));
    await runCommand("cmake", ["--build", buildRoot, "--target", "mimalloc-obj-target", "--parallel"]);
  });
  return objectPath;
}

function nativeCompilerFrontendArguments(
  cppPath: string,
  root: string,
  gcRoot: string,
  platform: NodeJS.Platform,
  options: NativeCompilerOptions,
  optimization: "-O0" | "-O1" | "-O2"
): string[] {
  const instrumented = options.sanitizers === true;
  const path = platform === "win32" ? win32 : posix;
  return [
    "-std=c++20",
    optimization,
    ...(!instrumented && !options.debug ? ["-DNDEBUG"] : []),
    ...(options.debug || instrumented ? ["-g"] : []),
    ...(instrumented ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : []),
    ...(platform === "darwin" ? ["-Wno-inconsistent-missing-override", "-Wno-trigraphs"] : []),
    "-fno-rtti",
    "-DCPPGC_IS_STANDALONE=1",
    ...(platform === "darwin" ? ["-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO"] : []),
    ...(platform === "win32" ? ["-D_WIN32_WINNT=0x0A00"] : []),
    "-DV8_LOGGING_LEVEL=0",
    ...(options.debug || instrumented ? ["-DVEXA_NATIVE_DEBUG=1"] : []),
    ...(options.gcStress ? ["-DVEXA_NATIVE_GC_STRESS=1"] : []),
    cppPath,
    `-I${root}`,
    `-I${gcRoot}`,
    `-I${path.resolve(gcRoot, "include")}`,
  ];
}

export function nativeCompilerArguments(
  cppPath: string,
  executablePath: string,
  root: string,
  gcRoot: string,
  libraryPath: string,
  platform: NodeJS.Platform = process.platform,
  options: NativeCompilerOptions = {}
): string[] {
  const instrumented = options.sanitizers === true;
  return [
    ...nativeCompilerFrontendArguments(
      cppPath,
      root,
      gcRoot,
      platform,
      options,
      instrumented ? "-O1" : "-O2"
    ),
    ...(!instrumented && options.mimallocObjectPath ? [options.mimallocObjectPath] : []),
    libraryPath,
    ...(platform === "win32" ? [] : ["-pthread"]),
    ...(platform === "darwin"
      ? ["-framework", "CoreFoundation"]
      : platform === "win32"
        ? ["-ldbghelp", "-lshlwapi", "-lwinmm"]
        : ["-ldl"]),
    ...(options.extraFlags ?? []),
    "-o",
    executablePath,
  ];
}

export function nativeSyntaxCompiler(platform: NodeJS.Platform = process.platform): string {
  // GCC 13 can ICE in build_special_member_call while parsing the complete
  // generated self-host coroutine graph. Clang validates the same C++20 source,
  // while normal Linux native builds and focused runtime tests still exercise GCC.
  return platform === "linux" ? "clang++" : "g++";
}

export async function validateNativeCppSyntax(
  cppPath: string,
  options: NativeCompilerOptions = {}
): Promise<void> {
  const root = nativeRoot();
  const { gcRoot } = await ensureOilpanLibrary(root);
  await runCommand(nativeSyntaxCompiler(), [
    ...nativeCompilerFrontendArguments(cppPath, root, gcRoot, process.platform, options, "-O0"),
    "-fsyntax-only",
  ]);
}

export async function compileNativeExecutable(
  cppPath: string,
  executablePath = defaultExecutablePath(cppPath),
  extraFlags: string[] = []
): Promise<NativeBuildResult> {
  const root = nativeRoot();
  const sanitizers = process.env["VEXA_NATIVE_SANITIZERS"] === "1";
  const [{ gcRoot, libraryPath }, mimallocObjectPath] = await Promise.all([
    ensureOilpanLibrary(root),
    sanitizers ? Promise.resolve(undefined) : ensureMimallocObject(root, process.platform),
  ]);
  await mkdir(dirname(executablePath), { recursive: true });

  const args = nativeCompilerArguments(cppPath, executablePath, root, gcRoot, libraryPath, process.platform, {
    sanitizers,
    debug: process.env["VEXA_NATIVE_DEBUG"] === "1",
    gcStress: process.env["VEXA_NATIVE_GC_STRESS"] === "1",
    extraFlags,
    ...(mimallocObjectPath ? { mimallocObjectPath } : {}),
  });
  await runCommand("g++", args);
  return {
    executablePath,
    oilpanLibraryPath: libraryPath,
    ...(mimallocObjectPath ? { mimallocObjectPath } : {}),
  };
}
