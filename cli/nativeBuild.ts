import { access, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { basename, dirname, extname, posix, resolve, win32 } from "node:path";
import { LANGUAGE_FILE_EXTENSION } from "../compiler/language";
import { fileURLToPath } from "node:url";
import { nativeCompilerCommand, runCommand, runCommandCapture } from "./io";

export interface NativeBuildResult {
  executablePath: string;
  oilpanLibraryPath: string;
  mimallocLibraryPath?: string;
  compiler: "g++" | "clang++" | "g++ + clang++" | "clang++ + g++";
  fallbackCompiler?: "g++" | "clang++";
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

function pathForPlatform(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

export function nativeDependencyCacheRoot(
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  return pathForPlatform(platform).resolve(homeDirectory, ".vexascript", "native");
}

export function nativeDependencyCachePath(
  cachePrefix: string,
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  return pathForPlatform(platform).resolve(nativeDependencyCacheRoot(homeDirectory, platform), cachePrefix);
}

export function nativeDependencyArtifactPath(
  name: string,
  extension: string,
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
  homeDirectory = homedir()
): string {
  return pathForPlatform(platform).resolve(
    nativeDependencyCacheRoot(homeDirectory, platform),
    `${name}-${platform}-${nativeTargetArchitecture(architecture)}${extension}`
  );
}

export function nativeTargetArchitecture(architecture = process.arch): string {
  switch (architecture) {
    case "arm64": return "aarch64";
    case "x64": return "x86_64";
    case "ia32": return "x86";
    default: return architecture;
  }
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
  const cacheRoot = nativeDependencyCachePath(cachePrefix);
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
  platform: NodeJS.Platform = process.platform,
  options: { archiveOutputDirectory?: string } = {}
): string[] {
  return [
    ...(platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
    "-S", gcRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_CXX_COMPILER=g++",
    ...(options.archiveOutputDirectory ? [`-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${options.archiveOutputDirectory}`] : []),
  ];
}

async function ensureOilpanLibrary(root: string): Promise<{ gcRoot: string; libraryPath: string }> {
  const { archive, cacheRoot, extractedRoot } = await nativeArchiveCachePaths(
    root,
    "oilpan-20260622.zip",
    "oilpan-20260622",
    "oilpan-standalone-main"
  );
  const gcRoot = resolve(extractedRoot, "gc");
  const buildRoot = resolve(gcRoot, "build-vexa");
  const libraryPath = nativeDependencyArtifactPath("liboilpan-20260622", ".a");
  if (await exists(libraryPath)) {
    return { gcRoot, libraryPath };
  }

  await withNativeBuildLock(`${cacheRoot}.lock`, async () => {
    await ensureNativeDependencySources(archive, cacheRoot, resolve(gcRoot, "CMakeLists.txt"));
    if (await exists(libraryPath)) return;
    await runCommand("cmake", nativeCmakeConfigureArguments(gcRoot, buildRoot, process.platform, {
      archiveOutputDirectory: nativeDependencyCacheRoot(),
    }));
    await runCommand("cmake", ["--build", buildRoot, "--parallel"]);
    await rename(resolve(nativeDependencyCacheRoot(), "liboilpan_gc.a"), libraryPath);
  });
  return { gcRoot, libraryPath };
}

function defaultExecutablePath(cppPath: string): string {
  return extname(cppPath).toLowerCase() === ".cpp"
    ? cppPath.slice(0, -".cpp".length)
    : `${cppPath}.native`;
}

export type NativeOptimization = "-O0" | "-O1" | "-O2" | "-O3" | "-Os" | "-Oz" | "-Og";

interface NativeCompilerOptions {
  sanitizers?: boolean;
  debug?: boolean;
  gcStress?: boolean;
  optimization?: NativeOptimization;
  mimallocLibraryPath?: string;
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

async function ensureMimallocLibrary(root: string, platform: NodeJS.Platform): Promise<string> {
  const { archive, cacheRoot, extractedRoot } = await nativeArchiveCachePaths(
    root,
    "mimalloc-3.4.3.zip",
    "mimalloc-3.4.3",
    "mimalloc-3.4.3"
  );
  const buildRoot = resolve(extractedRoot, "build-vexa");
  const builtLibraryPath = resolve(buildRoot, "libmimalloc.a");
  const libraryPath = nativeDependencyArtifactPath("libmimalloc-3.4.3", ".a", platform);
  if (await exists(libraryPath)) return libraryPath;

  await withNativeBuildLock(`${cacheRoot}.lock`, async () => {
    await ensureNativeDependencySources(archive, cacheRoot, resolve(extractedRoot, "CMakeLists.txt"));
    if (await exists(libraryPath)) return;
    await runCommand("cmake", nativeMimallocCmakeConfigureArguments(extractedRoot, buildRoot, platform));
    await runCommand("cmake", ["--build", buildRoot, "--target", "mimalloc-static", "--parallel"]);
    await copyFile(builtLibraryPath, libraryPath);
  });
  return libraryPath;
}

function nativeMimallocLinkArguments(libraryPath: string, platform: NodeJS.Platform): string[] {
  return platform === "darwin"
    ? [`-Wl,-force_load,${libraryPath}`]
    : ["-Wl,--whole-archive", libraryPath, "-Wl,--no-whole-archive"];
}

function nativeCompilerFrontendArguments(
  cppPaths: string | readonly string[],
  root: string,
  gcRoot: string,
  platform: NodeJS.Platform,
  options: NativeCompilerOptions,
  optimization: NativeOptimization
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
    ...(platform === "win32" ? ["-D_WIN32_WINNT=0x0A00", "-DNOMINMAX"] : []),
    "-DV8_LOGGING_LEVEL=0",
    ...(options.debug || instrumented ? ["-DVEXA_NATIVE_DEBUG=1"] : []),
    ...(options.gcStress ? ["-DVEXA_NATIVE_GC_STRESS=1"] : []),
    ...(typeof cppPaths === "string" ? [cppPaths] : cppPaths),
    `-I${root}`,
    `-I${gcRoot}`,
    `-I${path.resolve(gcRoot, "include")}`,
  ];
}

export function nativeCompilerArguments(
  cppPaths: string | readonly string[],
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
      cppPaths,
      root,
      gcRoot,
      platform,
      options,
      options.optimization ?? (instrumented ? "-O1" : "-O2")
    ),
    ...(!instrumented && options.mimallocLibraryPath
      ? nativeMimallocLinkArguments(options.mimallocLibraryPath, platform)
      : []),
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

export async function nativeCompiler(platform: NodeJS.Platform = process.platform): Promise<"g++" | "clang++"> {
  return await nativeCompilerCommand(platform);
}

export function nativeSyntaxCompiler(platform: NodeJS.Platform = process.platform): "clang++" | "g++" {
  return platform === "linux" ? "clang++" : "g++";
}

interface PreparedNativeBuildDependencies {
  root: string;
  gcRoot: string;
  oilpanLibraryPath: string;
  mimallocLibraryPath?: string;
}

async function preparedNativeBuildDependencies(): Promise<PreparedNativeBuildDependencies> {
  const root = nativeRoot();
  const sanitizers = process.env["VEXA_NATIVE_SANITIZERS"] === "1";
  const [{ gcRoot, libraryPath: oilpanLibraryPath }, mimallocLibraryPath] = await Promise.all([
    ensureOilpanLibrary(root),
    sanitizers ? Promise.resolve(undefined) : ensureMimallocLibrary(root, process.platform),
  ]);
  return {
    root,
    gcRoot,
    oilpanLibraryPath,
    ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
  };
}

export async function prepareNativeBuildDependencies(): Promise<void> {
  await preparedNativeBuildDependencies();
}

export async function validateNativeCppSyntax(
  cppPaths: string | readonly string[],
  options: NativeCompilerOptions = {}
): Promise<void> {
  const root = nativeRoot();
  const { gcRoot } = await ensureOilpanLibrary(root);
  for (const cppPath of typeof cppPaths === "string" ? [cppPaths] : cppPaths) {
    await runCommand(nativeSyntaxCompiler(), [
      ...nativeCompilerFrontendArguments(cppPath, root, gcRoot, process.platform, options, "-O0"),
      "-fsyntax-only",
    ]);
  }
}

export async function compileNativeExecutable(
  cppPaths: string | readonly string[],
  executablePath = defaultExecutablePath(typeof cppPaths === "string" ? cppPaths : cppPaths[0] ?? "main.cpp"),
  extraFlags: string[] = [],
  optimization?: NativeOptimization
): Promise<NativeBuildResult> {
  const sanitizers = process.env["VEXA_NATIVE_SANITIZERS"] === "1";
  const { root, gcRoot, oilpanLibraryPath, mimallocLibraryPath } = await preparedNativeBuildDependencies();
  const compiler = await nativeCompiler(process.platform);
  await mkdir(dirname(executablePath), { recursive: true });

  if (typeof cppPaths !== "string" && cppPaths.length > 1) {
    const objectRoot = resolve(dirname(executablePath), ".vexa-objects", basename(executablePath));
    await mkdir(objectRoot, { recursive: true });
    const objectExtension = process.platform === "win32" ? ".obj" : ".o";
    const objectPaths = cppPaths.map((_path, index) => resolve(objectRoot, `${String(index).padStart(4, "0")}${objectExtension}`));
    let fallbackCompiler: "g++" | "clang++" | undefined;
    let usedCompiler = compiler;
    let nextSourceIndex = 0;
    let compilationStopped = false;
    const compileNext = async (): Promise<void> => {
      while (!compilationStopped && nextSourceIndex < cppPaths.length) {
        const index = nextSourceIndex;
        nextSourceIndex += 1;
        const sourcePath = cppPaths[index]!;
        const objectPath = objectPaths[index]!;
        const compileArgs = [
          ...nativeCompilerFrontendArguments(sourcePath, root, gcRoot, process.platform, {
            sanitizers,
            debug: process.env["VEXA_NATIVE_DEBUG"] === "1",
            gcStress: process.env["VEXA_NATIVE_GC_STRESS"] === "1",
            ...(optimization ? { optimization } : {}),
          }, optimization ?? (sanitizers ? "-O1" : "-O2")),
          ...extraFlags,
          "-c",
          "-o",
          objectPath,
        ];
        try {
          const result = await runCommandCapture(usedCompiler, compileArgs);
          if (result.code === 0) continue;
          const compilerOutput = `${result.stdout}\n${result.stderr}`;
          if (process.platform === "linux" && /internal compiler error/i.test(compilerOutput)) {
            fallbackCompiler = compiler === "clang++" ? "g++" : "clang++";
            usedCompiler = fallbackCompiler;
            console.warn(`${compiler} reported an internal compiler error for ${sourcePath}; retrying with ${fallbackCompiler}`);
            const fallback = await runCommandCapture(fallbackCompiler, compileArgs);
            if (fallback.code === 0) continue;
            throw new Error(fallback.stderr || fallback.stdout || `${fallbackCompiler} failed compiling ${sourcePath}`);
          }
          throw new Error(result.stderr || result.stdout || `${usedCompiler} failed compiling ${sourcePath}`);
        } catch (error) {
          compilationStopped = true;
          throw error;
        }
      }
    };
    const workerCount = Math.max(1, Math.min(2, availableParallelism(), cppPaths.length));
    await Promise.all(Array.from({ length: workerCount }, () => compileNext()));
    const linkArgs = [
      ...objectPaths,
      ...(!sanitizers && mimallocLibraryPath ? nativeMimallocLinkArguments(mimallocLibraryPath, process.platform) : []),
      oilpanLibraryPath,
      ...(process.platform === "win32" ? [] : ["-pthread"]),
      ...(process.platform === "darwin"
        ? ["-framework", "CoreFoundation"]
        : process.platform === "win32"
          ? ["-ldbghelp", "-lshlwapi", "-lwinmm"]
          : ["-ldl"]),
      ...extraFlags,
      "-o",
      executablePath,
    ];
    const linkResult = await runCommandCapture(usedCompiler, linkArgs);
    if (linkResult.code !== 0) {
      throw new Error(linkResult.stderr || linkResult.stdout || `${usedCompiler} failed linking ${executablePath}`);
    }
    return {
      executablePath,
      oilpanLibraryPath,
      compiler: fallbackCompiler ? `${compiler} + ${fallbackCompiler}` as "g++ + clang++" | "clang++ + g++" : usedCompiler,
      ...(fallbackCompiler ? { fallbackCompiler } : {}),
      ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
    };
  }

  const args = nativeCompilerArguments(cppPaths, executablePath, root, gcRoot, oilpanLibraryPath, process.platform, {
    sanitizers,
    debug: process.env["VEXA_NATIVE_DEBUG"] === "1",
    gcStress: process.env["VEXA_NATIVE_GC_STRESS"] === "1",
    ...(optimization ? { optimization } : {}),
    extraFlags,
    ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
  });
  const result = await runCommandCapture(compiler, args);
  if (result.code === 0) return {
    executablePath,
    oilpanLibraryPath,
    compiler,
    ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
  };

  const compilerOutput = `${result.stdout}\n${result.stderr}`;
  if (process.platform === "linux" && /internal compiler error/i.test(compilerOutput)) {
    const fallbackCompiler = compiler === "clang++" ? "g++" : "clang++";
    console.warn(`${compiler} reported an internal compiler error; retrying the native build with ${fallbackCompiler}`);
    const fallback = await runCommandCapture(fallbackCompiler, args);
    if (fallback.code === 0) return {
      executablePath,
      oilpanLibraryPath,
      compiler: `${compiler} + ${fallbackCompiler}` as "g++ + clang++" | "clang++ + g++",
      fallbackCompiler,
      ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
    };
    throw new Error(fallback.stderr || fallback.stdout || `${fallbackCompiler} failed with ${fallback.signal ? `signal ${fallback.signal}` : `exit code ${fallback.code ?? "unknown"}`} after ${compiler} reported an internal compiler error`);
  }

  throw new Error(result.stderr || result.stdout || `${compiler} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`}`);
}
