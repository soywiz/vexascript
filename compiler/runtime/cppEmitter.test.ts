import { describe, expect, it } from "../test/expect";
import { transpile } from "./transpile";

describe("C++ emitter", () => {
  it("lowers class init blocks into constructor bodies", () => {
    const result = transpile(`
class Demo {
  var value: int
  init { value = 1 }
}
`, { emit: "cpp", sourceFilePath: "/tmp/class-init.vx", parserOptions: { language: "vexa" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("(this->value = 1);");
  });

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

  it("lowers logical assignments without emitting invalid C++ operators", () => {
    const result = transpile(`
function merge(values: boolean[]): boolean {
  let any = false;
  let every = true;
  for (const value of values) {
    any ||= value;
    every &&= value;
  }
  return any && every;
}
`, { emit: "cpp", sourceFilePath: "/tmp/logical-assignment.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).not.toContain("||=");
    expect(result.code).not.toContain("&&=");
    expect(result.code).toContain("vexa::assignWith");
  });

  it("emits string iteration and codePointAt through native runtime helpers", () => {
    const result = transpile(`
function inspect(value: string): number {
  const characters = [...value];
  return characters.length + (value.codePointAt(0) ?? 0);
}
`, { emit: "cpp", sourceFilePath: "/tmp/string-iteration.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::appendAll(__vexa_array, value)");
    expect(result.code).toContain("vexa::codePointAt(value");
  });

  it("converts dynamically emitted arithmetic into declared primitive locals", () => {
    const result = transpile(`
function offset(index: any, fixed: any): number {
  const restIndex: number = index - fixed;
  return restIndex;
}
`, { emit: "cpp", sourceFilePath: "/tmp/dynamic-arithmetic-local.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("double restIndex = vexa::toDouble(vexa::subtract(");
  });

  it("uses explicit callable return annotations when boxing interface callbacks", () => {
    const result = transpile(`
class Expr {}
interface Options {
  callback?: (expression: Expr) => string | undefined;
}
function consume(options: Options): void {}
const callback = (expression: Expr): string | undefined => expression ? "ok" : undefined;
consume({ callback: callback });
`, { emit: "cpp", sourceFilePath: "/tmp/explicit-callback-return.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::makeFunction<vexa::Value, Expr*>");
    expect(result.code).not.toContain("vexa::makeFunction<vexa::Undefined, Expr*>");
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
    value is /^ready-[0-9]+$/i -> "regexp"
    else -> "other"
  }
}
fun range(value: int): string {
  return match (value) {
    when >= 10 and < 20: "inside"
    else -> "outside"
  }
}
fun typed(value: any): string {
  return match (value) {
    [string, val bound: number, 3] -> bound.toString()
    ["tail", ..., val ending: string] -> ending
    string -> "string"
    number -> "number"
    bigint -> "bigint"
    else -> "other"
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
    expect(result.code).toContain("__vexa_pattern.isString()");
    expect(result.code).toContain("vexa::regexTest(vexa::RegExp(u\"^ready-[0-9]+$\", u\"i\"), __vexa_pattern)");
    expect(result.code).toContain("__vexa_pattern.isString()");
    expect(result.code).toContain("__vexa_pattern.isNumber()");
    expect(result.code).toContain("__vexa_pattern.isBigInt()");
    expect(result.code).toContain("double bound");
    expect(result.code).toContain("dynamicArraySize() - 1");
    expect(result.code).toContain("std::u16string ending");
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

  it("forwards TextEncoder methods through the native object contract", () => {
    const result = transpile(`
declare class TextEncoder {
  encode(value: string): Uint8Array
}
const encoder = TextEncoder()
const bytes = encoder.encode("A")
`, { emit: "cpp", sourceFilePath: "/tmp/text-encoder-native-runtime.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::makeManaged<vexa::TextEncoderObject>()");
    expect(result.code).toContain("->encode(");
    expect(result.code).not.toContain("vexa::makeUint8Array(vexa::toText");
  });

  it("derives new declared native object types from their C++ naming contract", () => {
    const result = transpile(`
declare interface URLLike {
  href: string
}
function keep(value: URLLike): URLLike { return value }
`, { emit: "cpp", sourceFilePath: "/tmp/declared-native-object.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::URLLikeObject*");
  });

  it("lowers ES2023-ES2025 collection, string, buffer, and promise helpers", () => {
    const result = transpile(`
const values = [1, 2, 3, 2]
const copied = values.toReversed().toSpliced(1, 1, 9).with(-1, 7)
const grouped = Object.groupBy(values, value => value % 2)
const groupedMap = Map.groupBy(values, value => value % 2)
const set = new Set([1, 2])
const union = set.union(new Set([2, 3]))
const buffer = new ArrayBuffer(2, { maxByteLength: 4 })
buffer.resize(3)
const moved = buffer.transfer()
const escaped = RegExp.escape("a.b")
const replaced = "a-b-a".replaceAll("a", "x")
const wellFormed = "text".isWellFormed() && "text".toWellFormed()
const attempt = Promise.try(() => 3)
const resolved = Promise.resolve(3)
const rejected = Promise.reject("no")
const all = Promise.all([Promise.resolve(1), Promise.resolve(2)])
const raced = Promise.race([Promise.resolve(1), Promise.resolve(2)])
const any = Promise.any([Promise.resolve(1), Promise.resolve(2)])
const settled = Promise.allSettled([Promise.resolve(1), Promise.resolve(2)])
const chained = Promise.resolve(1).then((value: int) => value + 1)
const recovered = Promise.reject("no").catch((reason: any) => 1)
const cleaned = Promise.resolve(1).finally(() => undefined)
const deferred = Promise.withResolvers<int>()
deferred.resolve(3)
nativeRunTask(deferred.promise)
console.log(values.findLast(value => value % 2 == 0), values.findLastIndex(value => value == 2), copied, grouped, groupedMap, union, buffer.byteLength, moved.byteLength, buffer.maxByteLength, escaped, wellFormed, Math.PI, 2 ** 3)
`, { emit: "cpp", sourceFilePath: "/tmp/es2025-native-runtime.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("->findLast(");
    expect(result.code).toContain("->toReversed(");
    expect(result.code).toContain("->toSpliced(");
    expect(result.code).toContain("->vexa_union(");
    expect(result.code).not.toContain("vexa::setUnion(");
    expect(result.code).toContain("vexa::ambient::Object::groupBy(");
    expect(result.code).toContain("vexa::ambient::Map::groupBy(");
    expect(result.code).not.toContain("vexa::mapGroupBy(");
    expect(result.code).toContain("->transfer(");
    expect(result.code).not.toContain("vexa::arrayBufferTransfer");
    expect(result.code).toContain("vexa::ambient::RegExp::escape(");
    expect(result.code).not.toContain("vexa::regexEscape(");
    expect(result.code).toContain("vexa::replaceAll(");
    expect(result.code).toContain("vexa::isWellFormed(");
    expect(result.code).toContain("vexa::toWellFormed(");
    expect(result.code).not.toContain("vexa::stringReplaceAll(");
    expect(result.code).toContain("vexa::ambient::Promise::vexa_try<");
    expect(result.code).toContain("vexa::ambient::Promise::withResolvers<std::int32_t>()");
    expect(result.code).toContain("vexa::ambient::Promise::resolve<");
    expect(result.code).toContain("vexa::ambient::Promise::reject<");
    expect(result.code).toContain("vexa::ambient::Promise::all<");
    expect(result.code).toContain("vexa::ambient::Promise::race<");
    expect(result.code).toContain("vexa::ambient::Promise::any<");
    expect(result.code).toContain("vexa::ambient::Promise::allSettled<");
    expect(result.code).toContain(".then(");
    expect(result.code).toContain(".vexa_catch(");
    expect(result.code).toContain(".finally(");
    expect(result.code).not.toContain("vexa::promiseThen(");
    expect(result.code).not.toContain("vexa::promiseCatch(");
    expect(result.code).not.toContain("vexa::promiseFinally(");
    expect(result.code).toContain("vexa::ambient::Math::PI");
    expect(result.code).toContain("vexa::ambient::Math::pow(");
    expect(result.code).not.toContain("vexa::Math::pow(");
    expect(result.code).not.toContain("vexa::promiseTry(");
  });

  it("emits native collection members from their ambient names", () => {
    const result = transpile(`
const map = new Map<string, int>([["one", 1]])
const value = map.get("one")
map.set("two", 2)
const present = map.has("two")
map.delete("one")
const keys = map.keys().toArray()
const set = new Set<int>([1, 2])
set.add(3)
set.delete(1)
const union = set.union(new Set<int>([4]))
console.log(value, present, keys, union)
`, { emit: "cpp", sourceFilePath: "/tmp/ambient-collection-members.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("->get(");
    expect(result.code).toContain("->set(");
    expect(result.code).toContain("->has(");
    expect(result.code).toContain("->vexa_delete(");
    expect(result.code).toContain("->keys()->toArray(");
    expect(result.code).toContain("->vexa_union(");
    expect(result.code).not.toContain("vexa::mapGet");
    expect(result.code).not.toContain("vexa::setUnion");
  });

  it("lowers Float16Array and DataView float16 operations", () => {
    const result = transpile(`
const values = new Float16Array([1.5, -2.25])
const reversed = values.toReversed()
const sorted = values.toSorted((left, right) => left - right)
const replaced = values.with(-1, 4.5)
const view = new DataView(new ArrayBuffer(2))
view.setFloat16(0, 1.5, true)
console.log(values[0], reversed[0], sorted[0], replaced[1], view.getFloat16(0, true))
`, { emit: "cpp", sourceFilePath: "/tmp/float16-native-runtime.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::makeFloat16Array");
    expect(result.code).toContain("vexa::Float16ArrayObject");
    expect(result.code).toContain("setFloat16");
    expect(result.code).toContain("getFloat16");
  });

  it("lowers the complete Float16Array method surface", () => {
    const result = transpile(`
const values = new Float16Array([1.5, -2, 3])
const mapped = values.map((value, index) => value + index)
const filtered = values.filter(value => value > 0)
const total = values.reduce((left, right) => left + right, 0)
const keys = values.keys().toArray()
values.copyWithin(1, 0, 2)
values.fill(4.5, 0, 1)
console.log(mapped, filtered, total, keys, values.every(value => value > 0), Math.f16round(1.1), values.buffer.byteLength, values.BYTES_PER_ELEMENT)
`, { emit: "cpp", sourceFilePath: "/tmp/float16-method-surface.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("->map(");
    expect(result.code).toContain("->filter(");
    expect(result.code).toContain("->reduce(");
    expect(result.code).toContain("->keys()");
    expect(result.code).toContain("->fill(");
    expect(result.code).toContain("vexa::ambient::Math::f16round");
  });

  it("uses ambient callback signatures with native array members", () => {
    const result = transpile(`
const values = [3, 1, 2]
const mapped = values.map((value, index, array) => value + index)
const filtered = values.filter(value => value > 1)
const sorted = values.toSorted((left, right) => left - right)
const total = values.reduce((left, right, index, array) => left + right, 0)
console.log(mapped, filtered, sorted, total)
`, { emit: "cpp", sourceFilePath: "/tmp/ambient-array-signatures.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("->map(");
    expect(result.code).toContain("->filter(");
    expect(result.code).toContain("->toSorted(");
    expect(result.code).toContain("->reduce(");
    expect(result.code).not.toContain("vexa::map(");
    expect(result.code).not.toContain("vexa::filter(");
    expect(result.code).toContain("std::int32_t value, double index, vexa::ArrayObject<std::int32_t>* array");
    expect(result.code).toContain("std::int32_t value");
    expect(result.code).toContain("std::int32_t left, std::int32_t right");
  });

  it("lowers Float16Array.of and Float16Array.from", () => {
    const result = transpile(`
const source = [1, 2, 3]
const values = Float16Array.of(1.5, 2.25)
const mapped = Float16Array.from(source, (value, index) => value + index)
console.log(values, mapped)
`, { emit: "cpp", sourceFilePath: "/tmp/float16-static.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ambient::Float16Array::of");
    expect(result.code).toContain("vexa::ambient::Float16Array::from");
  });

  it("lowers ES2025 iterator helpers", () => {
    const result = transpile(`
const mapped = Iterator.from([1, 2, 3]).map((value, index) => value + index).filter(value => value > 2).take(2).toArray()
const flattened = Iterator.from([[1, 2], [3]]).flatMap(values => values).toArray()
const total = Iterator.from([1, 2, 3]).reduce((left: int, right: int, index: number) => right, 0)
console.log(mapped, flattened, total)
`, { emit: "cpp", sourceFilePath: "/tmp/iterator-native-runtime.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ambient::Iterator::from");
    expect(result.code).toContain("->map(");
    expect(result.code).toContain("->flatMap(");
    expect(result.code).toContain("->reduce(");
    expect(result.code).not.toContain("vexa::iteratorMap");
    expect(result.code).not.toContain("vexa::iteratorFlatMap");
    expect(result.code).not.toContain("vexa::iteratorReduce");
  });

  it("lowers Intl.DurationFormat", () => {
    const result = transpile(`
const formatter = new Intl.DurationFormat("en", { style: "long" as "long" })
const parts = formatter.formatToParts({ seconds: 3 })
const options = formatter.resolvedOptions()
const supported = Intl.DurationFormat.supportedLocalesOf("en")
console.log(formatter.format({ hours: 1, minutes: 2 }), parts)
`, { emit: "cpp", sourceFilePath: "/tmp/duration-format-native-runtime.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::DurationFormatObject");
    expect(result.code).toContain("->format(");
    expect(result.code).toContain("->formatToParts(");
    expect(result.code).toContain("->resolvedOptions()");
    expect(result.code).not.toContain("vexa::durationFormatDuration");
    expect(result.code).toContain("vexa::ambient::Intl::DurationFormat::supportedLocalesOf(");
    expect(result.code).not.toContain("vexa::durationFormatSupportedLocales(");
  });

  it("lowers SharedArrayBuffer growth and RegExp flags", () => {
    const result = transpile(`
const buffer = new SharedArrayBuffer(2, { maxByteLength: 4 })
buffer.grow(4)
const expression = new RegExp("a", "gimsvd")
console.log(buffer.growable, buffer.maxByteLength, expression.global, expression.unicodeSets, expression.flags)
`, { emit: "cpp", sourceFilePath: "/tmp/shared-buffer-and-regexp-flags.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ArrayBufferObject");
    expect(result.code).toContain("->grow(");
    expect(result.code).toContain(".unicodeSets()");
    expect(result.code).toContain(".flags()");
  });

  it("lowers Atomics.waitAsync for native integer views", () => {
    const result = transpile(`
const result = Atomics.waitAsync(new Int32Array([0]), 0, 1, 0)
const bigResult = Atomics.waitAsync(new BigInt64Array([0n]), 0, 1n, 0)
console.log(result, bigResult)
`, { emit: "cpp", sourceFilePath: "/tmp/atomics-wait-async.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ambient::Atomics::waitAsync");
    expect(result.code).toContain("vexa::makeBigInt64Array");
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
    expect(result.code).toContain("vexa::ambient::performance::now()");
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
    expect(result.code).toContain("__vexa_optional_receiver->filter(");
  });
});
