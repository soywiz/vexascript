import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, dirname, extname, posix, resolve, win32 } from "node:path";
import { LANGUAGE_FILE_EXTENSION } from "../compiler/language";
import { fileURLToPath } from "node:url";
import { nativeCompilerCommand, runCommand, runCommandCapture } from "./io";

export interface NativeBuildResult {
  executablePath: string;
  oilpanLibraryPath: string;
  runtimeLibraryPath: string;
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

type NativeCxxCompiler = "g++" | "clang++";

function nativeCompilerCacheSuffix(compiler: NativeCxxCompiler): string {
  return compiler === "clang++" ? "clang" : "gcc";
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
  homeDirectory = homedir(),
  compiler?: NativeCxxCompiler
): string {
  const compilerSuffix = compiler ? `-${nativeCompilerCacheSuffix(compiler)}` : "";
  return pathForPlatform(platform).resolve(
    nativeDependencyCacheRoot(homeDirectory, platform),
    `${name}-${platform}-${nativeTargetArchitecture(architecture)}${compilerSuffix}${extension}`
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
  options: { archiveOutputDirectory?: string; compiler?: NativeCxxCompiler } = {}
): string[] {
  return [
    ...(platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
    "-S", gcRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_CXX_COMPILER=${options.compiler ?? "g++"}`,
    ...(options.archiveOutputDirectory ? [`-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${options.archiveOutputDirectory}`] : []),
  ];
}

async function ensureOilpanLibrary(root: string, compiler: NativeCxxCompiler): Promise<{ gcRoot: string; libraryPath: string }> {
  const compilerSuffix = nativeCompilerCacheSuffix(compiler);
  const { archive, cacheRoot, extractedRoot } = await nativeArchiveCachePaths(
    root,
    "oilpan-20260622.zip",
    `oilpan-20260622-${compilerSuffix}`,
    "oilpan-standalone-main"
  );
  const gcRoot = resolve(extractedRoot, "gc");
  const buildRoot = resolve(gcRoot, "build-vexa");
  const libraryPath = nativeDependencyArtifactPath("liboilpan-20260622", ".a", process.platform, process.arch, homedir(), compiler);
  if (await exists(libraryPath)) {
    return { gcRoot, libraryPath };
  }

  await withNativeBuildLock(`${cacheRoot}.lock`, async () => {
    await ensureNativeDependencySources(archive, cacheRoot, resolve(gcRoot, "CMakeLists.txt"));
    if (await exists(libraryPath)) return;
    await runCommand("cmake", nativeCmakeConfigureArguments(gcRoot, buildRoot, process.platform, {
      compiler,
      archiveOutputDirectory: cacheRoot,
    }));
    await runCommand("cmake", ["--build", buildRoot, "--parallel"]);
    await rename(resolve(cacheRoot, "liboilpan_gc.a"), libraryPath);
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
  runtimeLibraryPath?: string;
  runtimePchPath?: string;
  extraFlags?: string[];
}

export function nativeMimallocCmakeConfigureArguments(
  sourceRoot: string,
  buildRoot: string,
  platform: NodeJS.Platform = process.platform,
  compiler: NativeCxxCompiler = "g++"
): string[] {
  return [
    ...(platform === "win32" ? ["-G", "MinGW Makefiles"] : []),
    "-S", sourceRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_C_COMPILER=${compiler === "clang++" ? "clang" : "gcc"}`,
    "-DMI_BUILD_SHARED=OFF",
    "-DMI_BUILD_TESTS=OFF",
    "-DMI_OVERRIDE=ON",
  ];
}

async function ensureMimallocLibrary(root: string, platform: NodeJS.Platform, compiler: NativeCxxCompiler): Promise<string> {
  const compilerSuffix = nativeCompilerCacheSuffix(compiler);
  const { archive, cacheRoot, extractedRoot } = await nativeArchiveCachePaths(
    root,
    "mimalloc-3.4.3.zip",
    `mimalloc-3.4.3-${compilerSuffix}`,
    "mimalloc-3.4.3"
  );
  const buildRoot = resolve(extractedRoot, "build-vexa");
  const builtLibraryPath = resolve(buildRoot, "libmimalloc.a");
  const libraryPath = nativeDependencyArtifactPath("libmimalloc-3.4.3", ".a", platform, process.arch, homedir(), compiler);
  if (await exists(libraryPath)) return libraryPath;

  await withNativeBuildLock(`${cacheRoot}.lock`, async () => {
    await ensureNativeDependencySources(archive, cacheRoot, resolve(extractedRoot, "CMakeLists.txt"));
    if (await exists(libraryPath)) return;
    await runCommand("cmake", nativeMimallocCmakeConfigureArguments(extractedRoot, buildRoot, platform, compiler));
    await runCommand("cmake", ["--build", buildRoot, "--target", "mimalloc-static", "--parallel"]);
    await copyFile(builtLibraryPath, libraryPath);
  });
  return libraryPath;
}

function nativeWholeArchiveLinkArguments(libraryPath: string, platform: NodeJS.Platform): string[] {
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
    ...(platform === "win32" ? [] : ["-pthread"]),
    "-DV8_LOGGING_LEVEL=0",
    ...(options.debug || instrumented ? ["-DVEXA_NATIVE_DEBUG=1"] : []),
    ...(options.gcStress ? ["-DVEXA_NATIVE_GC_STRESS=1"] : []),
    ...(options.runtimePchPath
      ? [
          "-DVEXA_RUNTIME_PRECOMPILED=1",
          "-Xclang",
          "-fno-validate-pch",
          "-include-pch",
          options.runtimePchPath,
        ]
      : []),
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
      ? nativeWholeArchiveLinkArguments(options.mimallocLibraryPath, platform)
      : []),
    ...(options.runtimeLibraryPath ? nativeWholeArchiveLinkArguments(options.runtimeLibraryPath, platform) : []),
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

interface NativeRuntimeBuildArtifacts {
  libraryPath: string;
  pchPath?: string;
}

async function nativeRuntimeCacheKey(
  root: string,
  compiler: NativeCxxCompiler,
  options: NativeCompilerOptions,
  optimization: NativeOptimization
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("vexa-runtime-cache-v3");
  hash.update(JSON.stringify({
    compiler,
    optimization,
    platform: process.platform,
    architecture: process.arch,
    sanitizers: options.sanitizers === true,
    debug: options.debug === true,
    gcStress: options.gcStress === true,
    extraFlags: options.extraFlags ?? [],
  }));
  const runtimeRoot = resolve(root, "runtime");
  const sourceNames = (await readdir(runtimeRoot))
    .filter((name) => name.endsWith(".hpp") || name.endsWith(".cpp"))
    .sort();
  for (const name of sourceNames) {
    hash.update(name);
    hash.update(await readFile(resolve(runtimeRoot, name)));
  }
  return hash.digest("hex").slice(0, 20);
}

async function ensureNativeRuntimeLibrary(
  root: string,
  gcRoot: string,
  compiler: NativeCxxCompiler,
  options: NativeCompilerOptions,
  optimization: NativeOptimization
): Promise<NativeRuntimeBuildArtifacts> {
  const cacheKey = await nativeRuntimeCacheKey(root, compiler, options, optimization);
  const artifactName = `vexa-runtime-${cacheKey}`;
  const cacheRoot = nativeDependencyCacheRoot();
  const libraryPath = nativeDependencyArtifactPath(`lib${artifactName}`, ".a", process.platform, process.arch, homedir(), compiler);
  const runtimeRoot = resolve(root, "runtime");
  const objectExtension = process.platform === "win32" ? ".obj" : ".o";
  const runtimeSources = (await readdir(runtimeRoot))
    .filter((name) => name.endsWith(".cpp"))
    .sort();
  const legacyObjectPaths = runtimeSources.map((source) => resolve(
    cacheRoot,
    `${artifactName}-${source.slice(0, -".cpp".length)}-${nativeCompilerCacheSuffix(compiler)}${objectExtension}`
  ));
  const pchPath = compiler === "clang++"
    ? nativeDependencyArtifactPath(artifactName, ".pch", process.platform, process.arch, homedir(), compiler)
    : undefined;
  await Promise.all([
    rm(resolve(cacheRoot, `${artifactName}-sources`), { recursive: true, force: true }),
    ...legacyObjectPaths.map((path) => rm(path, { force: true })),
  ]);
  if (await exists(libraryPath) && (!pchPath || await exists(pchPath))) {
    return { libraryPath, ...(pchPath ? { pchPath } : {}) };
  }

  await withNativeBuildLock(resolve(cacheRoot, `${artifactName}.lock`), async () => {
    await mkdir(cacheRoot, { recursive: true });
    if (!(await exists(libraryPath))) {
      const objectRoot = await mkdtemp(resolve(tmpdir(), "vexa-runtime-objects-"));
      try {
        const objectPaths = runtimeSources.map((source) => resolve(
          objectRoot,
          `${source.slice(0, -".cpp".length)}${objectExtension}`
        ));
        let nextRuntimeSource = 0;
        const compileNextRuntimeSource = async (): Promise<void> => {
          while (nextRuntimeSource < runtimeSources.length) {
            const index = nextRuntimeSource++;
            const runtimeSource = runtimeSources[index] ?? "";
            const objectPath = objectPaths[index] ?? "";
            const compileArgs = [
              ...nativeCompilerFrontendArguments(resolve(runtimeRoot, runtimeSource), root, gcRoot, process.platform, options, optimization),
              ...(options.extraFlags ?? []),
              "-c",
              "-o",
              objectPath,
            ];
            const result = await runCommandCapture(compiler, compileArgs);
            if (result.code !== 0) {
              throw new Error(result.stderr || result.stdout || `${compiler} failed compiling ${runtimeSource}`);
            }
          }
        };
        const runtimeWorkerCount = Math.max(1, Math.min(2, availableParallelism(), runtimeSources.length));
        await Promise.all(Array.from({ length: runtimeWorkerCount }, () => compileNextRuntimeSource()));
        await runCommand("ar", ["rcs", libraryPath, ...objectPaths]);
      } finally {
        await rm(objectRoot, { recursive: true, force: true });
      }
    }
    if (pchPath && !(await exists(pchPath))) {
      const pchArgs = [
        ...nativeCompilerFrontendArguments([], root, gcRoot, process.platform, options, optimization),
        ...(options.extraFlags ?? []),
        "-x",
        "c++-header",
        resolve(runtimeRoot, "runtime.hpp"),
        "-o",
        pchPath,
      ];
      const result = await runCommandCapture(compiler, pchArgs);
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || `${compiler} failed compiling the VexaScript runtime precompiled header`);
      }
    }
  });
  return { libraryPath, ...(pchPath ? { pchPath } : {}) };
}

interface PreparedNativeBuildDependencies {
  compiler: NativeCxxCompiler;
  root: string;
  gcRoot: string;
  oilpanLibraryPath: string;
  mimallocLibraryPath?: string;
  runtimeLibraryPath: string;
  runtimePchPath?: string;
}

async function preparedNativeBuildDependencies(
  options: NativeCompilerOptions = {},
  optimization: NativeOptimization = options.sanitizers ? "-O1" : "-O2"
): Promise<PreparedNativeBuildDependencies> {
  const compiler = await nativeCompiler(process.platform);
  const root = nativeRoot();
  const sanitizers = options.sanitizers === true || process.env["VEXA_NATIVE_SANITIZERS"] === "1";
  const [{ gcRoot, libraryPath: oilpanLibraryPath }, mimallocLibraryPath] = await Promise.all([
    ensureOilpanLibrary(root, compiler),
    sanitizers ? Promise.resolve(undefined) : ensureMimallocLibrary(root, process.platform, compiler),
  ]);
  const runtime = await ensureNativeRuntimeLibrary(root, gcRoot, compiler, { ...options, sanitizers }, optimization);
  return {
    compiler,
    root,
    gcRoot,
    oilpanLibraryPath,
    runtimeLibraryPath: runtime.libraryPath,
    ...(runtime.pchPath ? { runtimePchPath: runtime.pchPath } : {}),
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
  const { gcRoot } = await ensureOilpanLibrary(root, nativeSyntaxCompiler());
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
  const selectedOptimization = optimization ?? (sanitizers ? "-O1" : "-O2");
  const compilerOptions: NativeCompilerOptions = {
    sanitizers,
    debug: process.env["VEXA_NATIVE_DEBUG"] === "1",
    gcStress: process.env["VEXA_NATIVE_GC_STRESS"] === "1",
    optimization: selectedOptimization,
    extraFlags,
  };
  const { compiler, root, gcRoot, oilpanLibraryPath, mimallocLibraryPath, runtimeLibraryPath, runtimePchPath } =
    await preparedNativeBuildDependencies(compilerOptions, selectedOptimization);
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
            ...compilerOptions,
            ...(runtimePchPath ? { runtimePchPath } : {}),
          }, selectedOptimization),
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
      ...(!sanitizers && mimallocLibraryPath ? nativeWholeArchiveLinkArguments(mimallocLibraryPath, process.platform) : []),
      ...nativeWholeArchiveLinkArguments(runtimeLibraryPath, process.platform),
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
      runtimeLibraryPath,
      compiler: fallbackCompiler ? `${compiler} + ${fallbackCompiler}` as "g++ + clang++" | "clang++ + g++" : usedCompiler,
      ...(fallbackCompiler ? { fallbackCompiler } : {}),
      ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
    };
  }

  const args = nativeCompilerArguments(cppPaths, executablePath, root, gcRoot, oilpanLibraryPath, process.platform, {
    ...compilerOptions,
    ...(runtimePchPath ? { runtimePchPath } : {}),
    runtimeLibraryPath,
    extraFlags,
    ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
  });
  const result = await runCommandCapture(compiler, args);
  if (result.code === 0) return {
    executablePath,
    oilpanLibraryPath,
    runtimeLibraryPath,
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
      runtimeLibraryPath,
      compiler: `${compiler} + ${fallbackCompiler}` as "g++ + clang++" | "clang++ + g++",
      fallbackCompiler,
      ...(mimallocLibraryPath ? { mimallocLibraryPath } : {}),
    };
    throw new Error(fallback.stderr || fallback.stdout || `${fallbackCompiler} failed with ${fallback.signal ? `signal ${fallback.signal}` : `exit code ${fallback.code ?? "unknown"}`} after ${compiler} reported an internal compiler error`);
  }

  throw new Error(result.stderr || result.stdout || `${compiler} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`}`);
}
