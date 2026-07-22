import { describe, expect, it, join, mkdtemp, rm, tmpdir } from "../compiler/test/expect";
import {
  nativeCmakeConfigureArguments,
  nativeCompilerArguments,
  nativeMimallocCmakeConfigureArguments,
  nativeProgramPaths,
  withNativeBuildLock,
} from "./nativeBuild";

describe("native build", () => {
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
  });

  it("links the cached mimalloc override object in release builds", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { mimallocObjectPath: "/cache/mimalloc.o" }
    );

    expect(args).toContain("/cache/mimalloc.o");
    expect(args.indexOf("/cache/mimalloc.o")).toBeLessThan(args.indexOf("/repo/native/oilpan/gc/build/liboilpan_gc.a"));
  });

  it("builds only the portable mimalloc object and static dependency", () => {
    const args = nativeMimallocCmakeConfigureArguments("/cache/mimalloc", "/cache/mimalloc/build");

    expect(args).toContain("-DMI_BUILD_SHARED=OFF");
    expect(args).toContain("-DMI_BUILD_TESTS=OFF");
    expect(args).toContain("-DMI_OVERRIDE=ON");
  });

  it("offers a debug sanitizer mode for native CI and stress runs", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { sanitizers: true, mimallocObjectPath: "/cache/mimalloc.o" }
    );
    expect(args).toContain("-O1");
    expect(args).toContain("-g");
    expect(args).not.toContain("-DNDEBUG");
    expect(args).toContain("-fsanitize=address,undefined");
    expect(args).toContain("-fno-omit-frame-pointer");
    expect(args).toContain("-DVEXA_NATIVE_DEBUG=1");
    expect(args).not.toContain("/cache/mimalloc.o");
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
