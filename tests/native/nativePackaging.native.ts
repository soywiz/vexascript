import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  readdir,
  rm,
  tmpdir,
} from "../../compiler/test/expect";
import { runCommand } from "../../cli/io";

async function readOilpanArchiveFile(path: string): Promise<string> {
  const outputRoot = await mkdtemp(join(tmpdir(), "vexa-oilpan-package-"));
  try {
    await runCommand("cmake", ["-E", "tar", "xf", join(process.cwd(), "native/oilpan-20260622.zip")], {
      cwd: outputRoot,
      stdio: "ignore",
    });
    return await readFile(join(outputRoot, "oilpan-standalone-main", path), "utf8");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

describe("native package contents", () => {
  it("publishes every source artifact required by cpp native workflows", async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files?: string[] };
    const required = [
      "native/runtime",
      "native/oilpan-20260622.zip",
      "native/mimalloc-3.4.3.zip",
    ];
    for (const path of required) {
      expect(manifest.files).toContain(path);
      if (path !== "native/runtime") {
        expect((await readFile(join(root, path))).byteLength).toBeTruthy();
      }
    }
    const runtimeFiles = await readdir(join(root, "native/runtime"));
    for (const expected of [
      "runtime.cpp", "runtime.hpp", "bigint.cpp", "bigint.hpp", "utf.cpp", "utf.hpp",
      "arrays.hpp", "collections.hpp", "date.hpp", "strings.hpp", "regexp.hpp", "intl.hpp",
      "typed_arrays.hpp", "data_view.hpp", "json.hpp",
    ]) {
      expect(runtimeFiles).toContain(expected);
    }
    for (const file of runtimeFiles) {
      expect((await readFile(join(root, "native/runtime", file))).byteLength).toBeTruthy();
    }
  });

  it("guards Clang-only Oilpan warning probes before GCC parses them", async () => {
    const macros = await readOilpanArchiveFile("gc/src/base/macros.h");

    expect(macros).not.toContain("defined(__has_warning) &&");
    expect(macros).toContain(
      "#if defined(__clang__) && defined(__has_warning)\n#if __has_warning"
    );
  });

  it("packages platform-specific native command quoting", async () => {
    const runtime = (await readFile(join(process.cwd(), "native/runtime/native_io.hpp"), "utf8"))
      .replace(/\r\n/g, "\n");
    const commandQuotingStart = runtime.indexOf("inline std::u16string shellQuote");
    const commandQuotingEnd = runtime.indexOf("template <typename T>\ninline void nativeRunTask");
    expect(commandQuotingStart).toBeGreaterThan(-1);
    expect(commandQuotingEnd).toBeGreaterThan(commandQuotingStart);
    const commandQuoting = runtime.slice(commandQuotingStart, commandQuotingEnd);

    expect(runtime).toContain("#if defined(_WIN32)\ninline std::u16string shellQuote");
    expect(commandQuoting).toContain('shellCommand = u"cd /d " + shellQuote(workingDirectory) + u" && "');
    expect(commandQuoting).toContain('#else\n    if (!workingDirectory.empty()) shellCommand = u"cd "');
    expect(commandQuoting).not.toContain("std::string");
    expect(/\b(?:const\s+)?char\s*\*/.test(commandQuoting)).toBe(false);
  });

  it("keeps runtime APIs in focused category headers", async () => {
    const runtimeRoot = join(process.cwd(), "native/runtime");
    const date = await readFile(join(runtimeRoot, "date.hpp"), "utf8");
    const platform = await readFile(join(runtimeRoot, "platform.hpp"), "utf8");
    const arrays = await readFile(join(runtimeRoot, "arrays.hpp"), "utf8");
    const collections = await readFile(join(runtimeRoot, "collections.hpp"), "utf8");
    const strings = await readFile(join(runtimeRoot, "strings.hpp"), "utf8");
    const regexp = await readFile(join(runtimeRoot, "regexp.hpp"), "utf8");
    const intl = await readFile(join(runtimeRoot, "intl.hpp"), "utf8");

    expect(date).toContain("class DateObject final");
    expect(date).toContain("inline double dateNow()");
    expect(date).not.toContain("vexaRuntimeName");
    expect(date).not.toContain("vexaPlatformName");
    expect(date).not.toContain("performanceNow");
    expect(platform).toContain("inline double performanceNow()");
    expect(platform).toContain("inline std::u16string vexaRuntimeName()");
    expect(platform).toContain("inline std::u16string vexaPlatformName()");
    expect(arrays).toContain("class ArrayObject final");
    expect(collections).toContain("class MapObject final");
    expect(collections).toContain("class SetObject final");
    expect(strings).toContain("inline std::u16string toUpperCase");
    expect(regexp).toContain("class RegExp final");
    expect(intl).toContain("class IntlObject final");
  });

  it("uses whole-width unaligned DataView loads and stores", async () => {
    const runtime = (await readFile(join(process.cwd(), "native/runtime/data_view.hpp"), "utf8"))
      .replace(/\r\n/g, "\n");
    const dataView = runtime.slice(
      runtime.indexOf("class DataViewObject final"),
      runtime.indexOf("template <typename T>\ninline ArrayObject<T>* arrayPointer")
    );

    expect(dataView).toContain("std::memcpy(&value");
    expect(dataView).toContain("std::memcpy(buffer_->data()");
    expect(dataView).toContain("std::endian::native");
    expect(dataView).toContain("byteSwap(value)");
    expect(dataView).not.toContain("for (");
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
    expect(bits).toContain('#if V8_OS_WIN\n#include "src/base/win32-headers.h"');
    expect(bits).not.toContain("#if V8_OS_WIN32");
    expect(bits).toContain("#undef RotateRight32");
    expect(time).toContain("!V8_OS_WIN");
  });
});
