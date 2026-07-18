import { describe, expect, it } from "../compiler/test/expect";
import { nativeCompilerArguments, nativeProgramPaths } from "./nativeBuild";

describe("native build", () => {
  it("compiles consumers with Oilpan's public cppgc definitions", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux"
    );

    expect(args).toContain("-DCPPGC_IS_STANDALONE=1");
    expect(args).toContain("-DCPPGC_ENABLE_OBJECT_SECTION_GCINFO");
    expect(args).toContain("-DV8_LOGGING_LEVEL=0");
    expect(args).toContain("-O3");
    expect(args).toContain("-DNDEBUG");
    expect(args).not.toContain("-DVEXA_NATIVE_DEBUG=1");
    expect(args).toContain("-ldl");
  });

  it("offers a debug sanitizer mode for native CI and stress runs", () => {
    const args = nativeCompilerArguments(
      "/tmp/main.cpp",
      "/tmp/main",
      "/repo/native",
      "/repo/native/oilpan/gc",
      "/repo/native/oilpan/gc/build/liboilpan_gc.a",
      "linux",
      { sanitizers: true }
    );
    expect(args).toContain("-O1");
    expect(args).toContain("-g");
    expect(args).not.toContain("-DNDEBUG");
    expect(args).toContain("-fsanitize=address,undefined");
    expect(args).toContain("-fno-omit-frame-pointer");
    expect(args).toContain("-DVEXA_NATIVE_DEBUG=1");
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
    expect(args).toContain("-Wno-inconsistent-missing-override");
    expect(args).toContain("-Wno-trigraphs");
  });

  it("keeps generated C++ in a source-specific build directory", () => {
    expect(nativeProgramPaths("src/main.vx", undefined, undefined, "/project")).toEqual({
      sourcePath: "/project/src/main.vx",
      buildRoot: "/project/src/main.vx.build",
      cppPath: "/project/src/main.vx.build/main.cpp",
      executablePath: "/project/src/main",
    });
    expect(nativeProgramPaths("src/main.vx", "bin/app", "tmp/native", "/project")).toEqual({
      sourcePath: "/project/src/main.vx",
      buildRoot: "/project/tmp/native",
      cppPath: "/project/tmp/native/main.cpp",
      executablePath: "/project/bin/app",
    });
  });

  it("rejects non-VexaScript inputs before choosing an executable path", () => {
    expect(() => nativeProgramPaths("src/main.ts", undefined, undefined, "/project")).toThrow(
      "Native compilation expects a .vx input file"
    );
  });
});
