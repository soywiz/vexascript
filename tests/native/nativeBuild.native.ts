import { describe, expect, it, join, mkdtemp, rm, tmpdir } from "../../compiler/test/expect";
import {
  nativeDependencyCacheRoot,
  nativeDependencyCachePath,
  nativeDependencyArtifactPath,
  nativeTargetArchitecture,
  nativeCmakeConfigureArguments,
  nativeCompilerArguments,
  nativeCompiler,
  nativeMimallocCmakeConfigureArguments,
  nativeProgramPaths,
  nativeSyntaxCompiler,
  withNativeBuildLock,
} from "../../cli/nativeBuild";

describe("native build", () => {
  it("stores reusable native dependencies under the VexaScript home directory", () => {
    expect(nativeDependencyCacheRoot("/home/tester", "linux")).toBe("/home/tester/.vexascript/native");
    expect(nativeDependencyCachePath("oilpan-20260622", "/home/tester", "linux")).toBe("/home/tester/.vexascript/native/oilpan-20260622");
    expect(nativeDependencyCachePath("mimalloc-3.4.3", "/home/tester", "linux")).toBe("/home/tester/.vexascript/native/mimalloc-3.4.3");
    expect(nativeDependencyArtifactPath("liboilpan-20260622", ".a", "linux", "x64", "/home/tester"))
      .toBe("/home/tester/.vexascript/native/liboilpan-20260622-linux-x86_64.a");
    expect(nativeDependencyArtifactPath("libmimalloc-3.4.3", ".a", "darwin", "arm64", "/home/tester"))
      .toBe("/home/tester/.vexascript/native/libmimalloc-3.4.3-darwin-aarch64.a");
    expect(nativeDependencyCacheRoot("C:\\Users\\tester", "win32"))
      .toBe("C:\\Users\\tester\\.vexascript\\native");
    expect(nativeDependencyCachePath("oilpan-20260622", "C:\\Users\\tester", "win32"))
      .toBe("C:\\Users\\tester\\.vexascript\\native\\oilpan-20260622");
    expect(nativeDependencyArtifactPath("liboilpan-20260622", ".a", "win32", "x64", "C:\\Users\\tester"))
      .toBe("C:\\Users\\tester\\.vexascript\\native\\liboilpan-20260622-win32-x86_64.a");
    expect(nativeTargetArchitecture("ia32")).toBe("x86");
  });

  it("uses Oilpan's portable GC info table on Linux", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux"
    );

    expect(args).toContain("-DCPPGC_IS_STANDALONE=1");
    expect(args).not.toContain("-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO");
    expect(args).toContain("-DV8_LOGGING_LEVEL=0");
    expect(args).toContain("-O2");
    expect(args).not.toContain("-O3");
    expect(args).toContain("-DNDEBUG");
    expect(args).toContain("-fno-rtti");
    expect(args).not.toContain("-DVEXA_NATIVE_DEBUG=1");
    expect(args).toContain("-ldl");

    const cmakeArgs = nativeCmakeConfigureArguments(
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build",
      "linux",
      { compiler: "clang++" }
    );
    expect(cmakeArgs).toContain("-DCMAKE_CXX_COMPILER=clang++");
  });

  it("writes Oilpan archives into the platform-named native cache root", () => {
    const args = nativeCmakeConfigureArguments("/repo/oilpan/gc", "/repo/oilpan/gc/build", "linux", {
      archiveOutputDirectory: "/home/tester/.vexascript/native",
    });

    expect(args).toContain("-DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=/home/tester/.vexascript/native");
  });

  it("uses a compatible native compiler for each platform", async () => {
    const compiler = await nativeCompiler("linux");
    expect(["clang++", "g++"]).toContain(compiler);
    expect(await nativeCompiler("win32")).toBe("g++");
    expect(nativeSyntaxCompiler("linux")).toBe("clang++");
    expect(nativeSyntaxCompiler("darwin")).toBe("g++");
    expect(nativeSyntaxCompiler("win32")).toBe("g++");
  });

  it("force-links the cached mimalloc static library in release builds", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { mimallocLibraryPath: "/cache/libmimalloc.a" }
    );

    expect(args).toContain("-Wl,--whole-archive");
    expect(args).toContain("/cache/libmimalloc.a");
    expect(args).toContain("-Wl,--no-whole-archive");
    expect(args.indexOf("/cache/libmimalloc.a")).toBeLessThan(args.indexOf("/repo/native/oilpan/gc/build/liboilpan_gc.a"));
  });

  it("reuses the cached runtime header and static library", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/cache/liboilpan.a",
      "linux",
      {
        runtimePchPath: "/cache/runtime.pch",
        runtimeLibraryPath: "/cache/libvexa-runtime.a",
      }
    );

    expect(args).toContain("-include-pch");
    expect(args).toContain("-DVEXA_RUNTIME_PRECOMPILED=1");
    expect(args).toContain("/cache/runtime.pch");
    expect(args.indexOf("/cache/libvexa-runtime.a")).toBeLessThan(args.indexOf("/cache/liboilpan.a"));
  });

  for (const optimization of ["-O0", "-O1", "-O2", "-O3", "-Os", "-Oz", "-Og"] as const) {
    it(`passes an explicit ${optimization} optimization level to the native compiler`, () => {
      const args = nativeCompilerArguments(
        "/tmp/main.cpp",
        "/tmp/main",
        "/repo/native",
        "/repo/native/oilpan/gc",
        "/repo/native/oilpan/gc/build/liboilpan_gc.a",
        "linux",
        { optimization }
      );

      expect(args).toContain(optimization);
      expect(args.filter((arg) => /^-O(?:[0123]|[szg])$/.test(arg))).toEqual([optimization]);
    });
  }

  it("appends source-declared compiler and linker flags without shell parsing", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { extraFlags: ["-I/native include", "-L/native lib", "-lnative"] }
    );

    expect(args.slice(-5)).toEqual(["-I/native include", "-L/native lib", "-lnative", "-o", "/tmp/main"]);
  });

  it("compiles and links every generated C++ translation unit", () => {
    const args = nativeCompilerArguments(
      ["/tmp/main.cpp", "/tmp/module-0000.cpp", "/tmp/module-0001.cpp"],
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux"
    );

    expect(args).toContain("/tmp/main.cpp");
    expect(args).toContain("/tmp/module-0000.cpp");
    expect(args).toContain("/tmp/module-0001.cpp");
  });

  it("builds the portable mimalloc static library", () => {
    const args = nativeMimallocCmakeConfigureArguments("/cache/mimalloc", "/cache/mimalloc/build", "linux", "clang++");

    expect(args).toContain("-DMI_BUILD_SHARED=OFF");
    expect(args).toContain("-DMI_BUILD_TESTS=OFF");
    expect(args).toContain("-DMI_OVERRIDE=ON");
    expect(args).toContain("-DCMAKE_C_COMPILER=clang");
  });

  it("offers a debug sanitizer mode for native CI and stress runs", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { sanitizers: true, mimallocLibraryPath: "/cache/libmimalloc.a" }
    );
    expect(args).toContain("-O1");
    expect(args).toContain("-g");
    expect(args).not.toContain("-DNDEBUG");
    expect(args).toContain("-fsanitize=address,undefined");
    expect(args).toContain("-fno-omit-frame-pointer");
    expect(args).toContain("-DVEXA_NATIVE_DEBUG=1");
    expect(args).not.toContain("/cache/libmimalloc.a");
  });

  it("offers an Oilpan collection stress mode independently of sanitizers", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { gcStress: true }
    );
    expect(args).toContain("-DVEXA_NATIVE_GC_STRESS=1");
    expect(args).not.toContain("-fsanitize=address,undefined");
  });

  it("suppresses generated-code-only Clang warning noise on macOS", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "darwin"
    );
    expect(args).toContain("-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO");
    expect(args).toContain("-Wno-inconsistent-missing-override");
    expect(args).toContain("-Wno-trigraphs");
  });

  it("uses the MinGW toolchain and Windows system libraries on Windows", () => {
    const cmakeArgs = nativeCmakeConfigureArguments("C:/oilpan/gc", "C:/oilpan/build", "win32");
    expect(cmakeArgs).toContain("MinGW Makefiles");
    expect(cmakeArgs).toContain("-DCMAKE_CXX_COMPILER=g++");

    const args = nativeCompilerArguments(
      "C:/project/main.cpp",
      "C:/project/main.exe",
      "C:/project/native",
      "C:/oilpan/gc",
      "C:/oilpan/build/liboilpan_gc.a",
      "win32"
    );
    expect(args).not.toContain("-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO");
    expect(args).not.toContain("-pthread");
    expect(args).not.toContain("-ldl");
    expect(args).toContain("-D_WIN32_WINNT=0x0A00");
    expect(args).toContain("-DNOMINMAX");
    expect(args).toContain("-ldbghelp");
    expect(args).toContain("-lshlwapi");
    expect(args).toContain("-lwinmm");
  });

  it("keeps generated C++ in a source-specific build directory", () => {
    expect(nativeProgramPaths("src/main.vx", undefined, undefined, "/project", "linux")).toEqual({
      sourcePath: "/project/src/main.vx",
      buildRoot: "/project/src/main.vx.build",
      cppPath: "/project/src/main.vx.build/main.cpp",
      executablePath: "/project/src/main",
    });
    expect(nativeProgramPaths("src/main.vx", "bin/app", "tmp/native", "/project", "linux")).toEqual({
      sourcePath: "/project/src/main.vx",
      buildRoot: "/project/tmp/native",
      cppPath: "/project/tmp/native/main.cpp",
      executablePath: "/project/bin/app",
    });
  });

  it("accepts TypeScript entrypoints for native executables", () => {
    expect(nativeProgramPaths("src/main.ts", undefined, undefined, "/project", "linux")).toEqual({
      sourcePath: "/project/src/main.ts",
      buildRoot: "/project/src/main.ts.build",
      cppPath: "/project/src/main.ts.build/main.cpp",
      executablePath: "/project/src/main",
    });
  });

  it("uses an executable suffix for default and explicit Windows outputs", () => {
    expect(nativeProgramPaths("src\\main.vx", undefined, undefined, "C:\\project", "win32").executablePath)
      .toBe("C:\\project\\src\\main.exe");
    expect(nativeProgramPaths("src\\main.vx", "bin\\app", undefined, "C:\\project", "win32").executablePath)
      .toBe("C:\\project\\bin\\app.exe");
    expect(nativeProgramPaths("src\\main.vx", "bin\\app.exe", undefined, "C:\\project", "win32").executablePath)
      .toBe("C:\\project\\bin\\app.exe");
  });

  it("rejects unsupported native source inputs before choosing an executable path", () => {
    expect(() => nativeProgramPaths("src/main.js", undefined, undefined, "/project", "linux")).toThrow(
      "Native compilation expects a .vx or .ts input file"
    );
  });

  it("serializes native cache builders across concurrent callers", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-lock-"));
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolvePromise) => { markFirstEntered = resolvePromise; });
    const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });

    try {
      const lockRoot = join(outputRoot, "missing-parent", "build.lock");
      const first = withNativeBuildLock(lockRoot, async () => {
        events.push("first:start");
        markFirstEntered();
        await firstGate;
        events.push("first:end");
      });
      await firstEntered;
      const second = withNativeBuildLock(lockRoot, async () => {
        events.push("second");
      });
      releaseFirst();
      await Promise.all([first, second]);

      expect(events).toEqual(["first:start", "first:end", "second"]);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
