import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
} from "../compiler/test/expect";
import { runCommand } from "./io";

async function readOilpanArchiveFile(path: string): Promise<string> {
  const outputRoot = await mkdtemp(join(tmpdir(), "vexa-oilpan-package-"));
  try {
    await runCommand("cmake", ["-E", "tar", "xf", join(process.cwd(), "native/oilpan-standalone-main.zip")], {
      cwd: outputRoot,
      stdio: "ignore",
    });
    return await readFile(join(outputRoot, "oilpan-standalone-main", path), "utf8");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

describe("native package contents", () => {
  it("publishes every source artifact required by cpp and executable", async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files?: string[] };
    const required = [
      "native/runtime.cpp",
      "native/bigint.h",
      "native/oilpan-standalone-main.zip",
    ];
    for (const path of required) {
      expect(manifest.files).toContain(path);
      expect((await readFile(join(root, path))).byteLength).toBeTruthy();
    }
  });

  it("guards Clang-only Oilpan warning probes before GCC parses them", async () => {
    const macros = await readOilpanArchiveFile("gc/src/base/macros.h");

    expect(macros).not.toContain("defined(__has_warning) &&");
    expect(macros).toContain(
      "#if defined(__clang__) && defined(__has_warning)\n#if __has_warning"
    );
  });

  it("packages the portable Linux GC table and the required Windows sources", async () => {
    const cmake = await readOilpanArchiveFile("gc/CMakeLists.txt");
    expect(cmake).toContain("if(APPLE)\n  target_compile_definitions(oilpan_gc PUBLIC CPPGC_ENABLE_OBJECT_SECTION_GCINFO)");
    expect(cmake).toContain("elseif(WIN32)");
    expect(cmake).toContain("src/base/platform/platform-win32.cc");
    expect(cmake).toContain("src/base/debug/stack_trace_win.cc");
    expect(cmake).toContain("src/heap/base/asm/x64/push_registers_mingw.S");

    const windowsPlatform = await readOilpanArchiveFile("gc/src/base/platform/platform-win32.cc");
    const windowsHeaders = await readOilpanArchiveFile("gc/src/base/win32-headers.h");
    const windowsStackTrace = await readOilpanArchiveFile("gc/src/base/debug/stack_trace_win.cc");
    const windowsRegisters = await readOilpanArchiveFile("gc/src/heap/base/asm/x64/push_registers_mingw.S");
    const bits = await readOilpanArchiveFile("gc/src/base/bits.h");
    const time = await readOilpanArchiveFile("gc/src/base/platform/time.cc");
    expect(cmake).toContain("_CRT_RAND_S");
    expect(cmake).toContain("UNICODE");
    expect(windowsPlatform).toContain("namespace v8");
    expect(windowsPlatform).toContain("#ifndef __MINGW64_VERSION_MAJOR");
    expect(windowsPlatform).not.toContain("Stack::GetCommittedStackLimit");
    expect(windowsHeaders).toContain("V8_BASE_WIN32_HEADERS_H_");
    expect(windowsStackTrace).toContain("StackTrace::StackTrace()");
    expect(windowsRegisters).toContain("PushAllRegistersAndIterateStack");
    expect(bits).toContain("#undef RotateRight32");
    expect(time).toContain("!V8_OS_WIN");
  });
});
