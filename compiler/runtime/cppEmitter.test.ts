import { describe, expect, it } from "../test/expect";
import { transpile } from "./transpile";

describe("C++ emitter", () => {
  it("emits console arguments in a braced list so their side effects run left to right", () => {
    const result = transpile(`
var value = 1
fun increment(): int { value += 1; return value }
console.log(value, increment(), value)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::console.log({");
  });

  it("keeps nullish coalescing dynamic when both optional string operands can be undefined", () => {
    const result = transpile(`
class Statement { jsName?: string }
function pick(candidate: Statement, statement: Statement): void {
  const jsName = candidate.jsName ?? statement.jsName;
  if (jsName !== undefined) console.log(jsName);
}
`, { emit: "cpp", sourceFilePath: "/tmp/optional-string.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto jsName = vexa::nullishCoalesce(candidate->jsName");
    expect(result.code).not.toContain("auto jsName = vexa::toText(vexa::nullishCoalesce(candidate->jsName");
  });

  it("uses the native steady clock for performance.now", () => {
    const result = transpile("const startedAt = performance.now()", {
      emit: "cpp",
      sourceFilePath: "/tmp/performance.ts"
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::performanceNow()");
  });

  it("keeps mixed template concatenation in native text storage", () => {
    const result = transpile('const count = 2; const message = `count ${count}!`', {
      emit: "cpp",
      sourceFilePath: "/tmp/template-text.ts"
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::concatText({");
    expect(result.code).not.toContain("vexa::add(");
  });

  it("emits referenced C++ headers and raw function bodies", () => {
    const result = transpile(`
@CppHeader("#include <native_api.h>")
@CppBody("return native_add(left, right);")
declare function nativeAdd(left: int, right: int): int
console.log(nativeAdd(2, 3))
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('#include <native_api.h>\n#include "runtime.cpp"');
    expect(result.code).toContain("return native_add(left, right);");
  });

  it("lowers FFILibrary classes to cached native symbols", () => {
    const result = transpile(`
@FFILibrary("native.dll", "libnative.so", "Native.framework/Native")
declare class NativeMath { static abs(value: int): int }
console.log(NativeMath.abs(-3))
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class NativeMath final {");
    expect(result.code).toContain('vexa::LibraryOpen::symbol({"native.dll", "libnative.so", "Native.framework/Native"}, "abs")');
    expect(result.code).toContain("return __vexa_function(value);");
  });

  it("resolves an FFIName while preserving the source method name", () => {
    const result = transpile(`
@FFILibrary("libnative.so")
declare class NativeMath { @FFIName("native_abs") static Abs(value: int): int }
console.log(NativeMath.Abs(-3))
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('vexa::LibraryOpen::symbol({"libnative.so"}, "native_abs")');
    expect(result.code).toContain("NativeMath::Abs((-3))");
  });

  it("emits ArrayBuffer-backed C ABI structs with explicit layout", () => {
    const result = transpile(`
@FFIStruct(8)
@FFIAlign(4)
class Pair(@FFIOffset(0) @FFISize(2) var x: int, @FFIOffset(4) var y: int)
const pair = Pair(7, 9)
console.log(pair.x, pair.y)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Runtime::current().make<vexa::ArrayBufferObject>(8)");
    expect(result.code).toContain("std::int16_t& x;");
    expect(result.code).toContain("buffer_->data() + 4");
    expect(result.code).toContain("static_assert(4 % 4 == 0);");
  });

  it("preserves default values on native FFI struct constructors", () => {
    const result = transpile(`
@FFIStruct(8)
@FFIAlign(4)
class Pair(@FFIOffset(0) var x: int = 0, @FFIOffset(4) var y: int = 0)
const pair = Pair()
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Pair(std::int32_t x, std::int32_t y)");
    expect(result.code).toContain("runtime.make<Pair>(0, 0)");
  });

  it("emits field-declared FFI structs with overlapping explicit offsets", () => {
    const result = transpile(`
@FFIStruct(8)
@FFIAlign(4)
class Event {
  @FFIOffset(0) var type: int
  @FFIOffset(0) @FFISize(2) var code: int
  @FFIOffset(4) var value: int
}
const event = Event()
event.type = 7
console.log(event.code)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Event()");
    expect(result.code).toContain("std::int32_t& type;");
    expect(result.code).toContain("std::int16_t& code;");
    expect(result.code).toContain("type(*reinterpret_cast<std::int32_t*>(buffer_->data() + 0))");
    expect(result.code).toContain("code(*reinterpret_cast<std::int16_t*>(buffer_->data() + 0))");
  });

  it("passes ArrayBuffer storage directly to native FFI", () => {
    const result = transpile(`
@FFILibrary("libnative.so")
declare class Native { static fill(bytes: ArrayBuffer, value: int, size: long): FFIPointer }
Native.fill(ArrayBuffer(8), 1, 8L)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ArrayBufferObject* bytes");
    expect(result.code).toContain("using __vexa_function_type = void* (*)(void*, std::int32_t, std::int64_t);");
    expect(result.code).toContain("__vexa_function(bytes->data(), value, size)");
  });

  it("runs Promise-returning FFI symbols on a worker and resumes the runtime loop", () => {
    const result = transpile(`
@FFILibrary("libnative.so")
declare class Native { static wait(milliseconds: int): Promise<void> }
sync function main(): void { Native.wait(1) }
main()
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<void> wait(std::int32_t milliseconds)");
    expect(result.code).toContain("vexa::runAsync(vexa::Runtime::current()");
  });

  it("emits native runtime and platform intrinsics", () => {
    const result = transpile("console.log(vexaRuntime(), vexaPlatform())", { emit: "cpp" });
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::vexaRuntimeName()");
    expect(result.code).toContain("vexa::vexaPlatformName()");
  });

  it("guards optional array method receivers before invoking native helpers", () => {
    const result = transpile(`
function positive(values: number[] | undefined): number[] | undefined {
  return values?.filter((value) => value > 0);
}
`, { emit: "cpp", sourceFilePath: "/tmp/optional-array.ts", typeCheck: false });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::optionalCall(");
    expect(result.code).toContain("vexa::filter(vexa::Runtime::current(), __vexa_optional_receiver");
  });
});
