import { describe, expect, it } from "../test/expect";
import { transpile } from "./transpile";

describe("C++ emitter", () => {
  it("emits VexaScript character literals as code-point integers", () => {
    const result = transpile(`
val code: int = '😀'
val matches = "aaa".charCodeAt(0) == 'a'
`, { emit: "cpp", sourceFilePath: "/tmp/character-literal.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t code");
    expect(result.code).toContain("code = 128512;");
    expect(result.code).toContain("== 97");
  });

  it("emits shared lowering for control-flow expressions", () => {
    const result = transpile(`
fun early(flag: boolean): int {
  flag || return 1
  return 2
}
fun scan(values: int[]) {
  for (val value of values) {
    value > 0 || continue
    value < 10 || break
  }
}
fun pick(flag: boolean): int {
  val result = if (flag) 3 else throw "No result"
  return result
}
fun requireValue(value: string | undefined): string {
  val result = value || throw Error("missing")
  return result
}
`, { emit: "cpp", sourceFilePath: "/tmp/control-expressions.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_control_0");
    expect(result.code).toContain("return 1;");
    expect(result.code).toContain("continue;");
    expect(result.code).toContain("break;");
    expect(result.code).toContain("vexa::throwValue(__vexa_literal_0->value())");
    expect(result.code).toContain("std::u16string result");
  });

  it("emits match expressions through the shared C++ conditional lowering", () => {
    const result = transpile(`
fun pick(value: int): string {
  return match {
    value == 1 -> "one"
    value == 2 -> {
      val label = "two"
      label
    }
    default -> "other"
  }
}
`, { emit: "cpp", sourceFilePath: "/tmp/match-expression.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("if (value == 1)");
    expect(result.code).toContain("if (value == 2)");
    expect(result.code).toContain("return __vexa_literal_");
  });

  it("emits structural and combined is patterns with single-evaluation captures", () => {
    const result = transpile(`
fun classify(value: any): string {
  return match {
    value is ({ kind: "ok" } and { payload: [1, 2] }) -> "object"
    value is (["error", ..., 500] or ["error", ..., 503]) -> "array"
    value is "plain" -> "literal"
    else -> "other"
  }
}
fun range(value: int): string {
  return match (value) {
    when >= 10 and < 20: "inside"
    else -> "outside"
  }
}
`, { emit: "cpp", sourceFilePath: "/tmp/is-patterns.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("[&](vexa::Value __vexa_pattern) -> bool");
    expect(result.code).toContain("vexa::hasProperty(__vexa_pattern, u\"kind\")");
    expect(result.code).toContain("dynamicIsArray()");
    expect(result.code).toContain("dynamicArraySize() >= 2");
    expect(result.code).toContain("vexa::strictEquals(__vexa_pattern");
    expect(result.code).toContain("&&");
    expect(result.code).toContain("||");
    expect(result.code).toContain("vexa::compare(__vexa_pattern");
  });

  it("keeps concrete Set storage when an explicit semantic type lowers dynamically", () => {
    const result = transpile(`
type Name = "alpha" | "beta";
export const names: ReadonlySet<string> = new Set<Name>(["alpha", "beta"]);
`, { emit: "cpp", sourceFilePath: "/tmp/readonly-set.ts", typeCheck: false });

    expect(result.code).toContain("vexa::setFromIterable<std::u16string>");
    expect(result.code).not.toContain("vexa::setFromIterable<vexa::Value>");
  });

  it("lowers WeakMap iterables, radix string conversion, and native binary helpers", () => {
    const result = transpile(`
const key = { kind: "buffer" }
const metadata = WeakMap<object, string>([[key, "ready"]])
const value = 255
console.log(metadata.get(key), value.toString(16))
`, { emit: "cpp", sourceFilePath: "/tmp/native-collections-and-binary.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::weakMapFromIterable<");
    expect(result.code).toContain("vexa::toString(value, static_cast<double>(16))");
  });

  it("forwards interface members through class delegation", () => {
    const result = transpile(`
interface Shape { area: number; fill(color: string): string }
class Rectangle(val width: number, val height: number): Shape {
  override area => width * height
  override fill(color: string) => color
}
class Logger(val shape: Shape): Shape by { shape }
const logger = Logger(Rectangle(2, 3))
console.log(logger.area, logger.fill("ok"))
`, { emit: "cpp", sourceFilePath: "/tmp/class-delegation.vx", parserOptions: { language: "vexa" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("this->shape->__vexa_property_get_area()");
    expect(result.code).toContain("this->shape->fill(color)");
  });

  it("lowers top-level delegated state reads and writes", () => {
    const result = transpile(`
fun box<T>(initial: T) { return { value: initial } }
var source = 1
var observed by () => source
var total by box(0)
total = observed + 2
total++
console.log(total)
`, { emit: "cpp", sourceFilePath: "/tmp/delegated-state.vx", parserOptions: { language: "vexa" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_delegate_total");
    expect(result.code).toContain("recordGet<std::int32_t>");
  });

  it("does not turn an empty C++ annotation list into an empty C++ body", () => {
    const result = transpile(`
async function readFile(path: string): Promise<string> {
  return path;
}
`, { emit: "cpp", sourceFilePath: "/tmp/empty-cpp-annotation.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<std::u16string> readFile");
    expect(result.code).not.toContain("@CppBody supports synchronous functions only");
  });

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

  it("keeps statically numeric bitwise operations out of the dynamic Value path", () => {
    const result = transpile(`
function fold(leftValue: number, rightValue: number): number {
  const shifted = leftValue << rightValue;
  const masked = leftValue & rightValue;
  const inverted = ~leftValue;
  return shifted + masked + inverted;
}
`, { emit: "cpp", sourceFilePath: "/tmp/numeric-bitwise.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::shiftLeft(leftValue, rightValue)");
    expect(result.code).toContain("vexa::bitwiseAnd(leftValue, rightValue)");
    expect(result.code).toContain("vexa::bitwiseNot(leftValue)");
    expect(result.code).not.toContain("vexa::toValue(leftValue)");
  });

  it("caches instanceof narrowing casts instead of checking and casting twice", () => {
    const result = transpile(`
class Base {}
class Child extends Base { value: number }
function read(value: Base): number {
  if (value instanceof Child) return value.value;
  return 0;
}
`, { emit: "cpp", sourceFilePath: "/tmp/instanceof-narrowing.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto* __vexa_instanceof_");
    expect(result.code).toContain("vexa::toInstanceOrNull<Child*>(value)");
    expect(result.code).toContain("if (__vexa_instanceof_");
    expect(result.code).not.toContain("vexa::isInstance<Child>(value)");
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
    expect(result.code).toContain("vexa::makeManaged<vexa::ArrayBufferObject>(8)");
    expect(result.code).not.toContain("vexa::Runtime::current()");
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
    expect(result.code).toContain("vexa::makeManaged<Pair>(0, 0)");
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
    expect(result.code).toContain("vexa::runAsync(");
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
    expect(result.code).toContain("vexa::filter(__vexa_optional_receiver");
  });
});
