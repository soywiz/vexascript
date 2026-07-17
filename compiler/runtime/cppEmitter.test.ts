import { describe, expect, it, join, readFile } from "../test/expect";
import { transpile } from "./transpile";

describe("C++ emission", () => {
  it("emits an exclusive range loop and console.log in an Oilpan runtime entrypoint", () => {
    const result = transpile(`for (n of 0 ..< 10) {
  console.log(n)
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('#include "runtime.cpp"');
    expect(result.code).toContain("vexa::Runtime runtime;");
    expect(result.code).toContain('#line 1 "main.vx"');
    expect(result.code).toContain('setSourceLocation("main.vx", 1, 1)');
    expect(result.code).toContain("for (std::int32_t n = 0; n < 10; n++)");
    expect(result.code).toContain("vexa::console.log(n);");
  });

  it("maps basic Math and primitive JavaScript APIs to the native runtime", () => {
    const result = transpile(`console.log(Math.floor(Math.PI), Number("2"), " ok ".trim().toUpperCase())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Math::floor(vexa::Math::PI)");
    expect(result.code).toContain('vexa::Number(runtime.string("2"))');
    expect(result.code).toContain('vexa::toUpperCase(vexa::trim(runtime.string(" ok ")))');
  });

  it("emits the native URL and URI component host used by compiler paths", () => {
    const result = transpile(`function parseFileUrl(value: string): string {
  const parsed = new URL(value)
  return decodeURIComponent(parsed.pathname) + parsed.protocol + parsed.href
}
console.log(encodeURIComponent("a b"), parseFileUrl("file:///a%20b"))`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.make<vexa::URLObject>");
    expect(result.code).toContain("vexa::decodeURIComponent(__vexa_runtime.string(parsed->pathname))");
    expect(result.code).toContain("vexa::encodeURIComponent(runtime.string(\"a b\"))");
  });

  it("uses one native error representation for JavaScript error subclasses", () => {
    const result = transpile(`function failure(message: string): Error {
  return new TypeError(message)
}
class ParseFailure extends Error {
  range: number
  constructor(message: string, range: number) {
    super(message)
    this.name = "ParseFailure"
    this.range = range
  }
}
try {
  throw new ParseFailure("parse", 3)
} catch (error) {
  console.log(error instanceof ParseFailure, error instanceof Error)
}
console.log(failure("bad").message, new ParseFailure("parse", 3).name)`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Error failure(");
    expect(result.code).toContain("return vexa::Error(vexa::convertValue<vexa::Value>(__vexa_runtime, message));");
    expect(result.code).toContain("runtime.string(failure(runtime, runtime.string(\"bad\")).messageText())");
    expect(result.code).toContain("public vexa::DynamicValueObject, public vexa::Error");
    expect(result.code).toContain("vexa::Error(vexa::convertValue<vexa::Value>(__vexa_runtime, message))");
    expect(result.code).toContain("catch (const vexa::RejectedValue&");
    expect(result.code).toContain("vexa::isInstance<ParseFailure>(error)");
    expect(result.code).toContain("vexa::isErrorLike(error)");
  });

  it("emits never-returning TypeScript functions as native void callables", () => {
    const result = transpile(`function fail(message: string): never { throw new Error(message) }`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("void fail(vexa::Runtime& __vexa_runtime, vexa::Value message)");
  });

  it("emits native asynchronous file reads through the shared task runtime", () => {
    const result = transpile(`sync fun load(path: string): string {
  return await readTextFile(path)
}
console.log(load("message.txt"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::readTextFile(__vexa_runtime");
    expect(result.code).toContain("co_await vexa::readTextFile");
  });

  it("emits native Node-compatible arguments and asynchronous file writes", () => {
    const result = transpile(`sync fun save(path: string, value: string) {
  writeTextFile(path, value)
}
val args = commandLineArguments()
save(args[0], "generated")`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("int main(int argc, char** argv)");
    expect(result.code).toContain("vexa::Process process(runtime, argc, argv);");
    expect(result.code).toContain("vexa::commandLineArguments(runtime)");
    expect(result.code).toContain("vexa::writeTextFile(__vexa_runtime");
  });

  it("emits comma expressions and lazy nullish coalescing", () => {
    const result = transpile(`val present: any = "value"
val missing: any = null
val comma = (console.log("before"), 7)
console.log(present ?? "fallback", missing ?? "fallback", comma)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('(vexa::console.log(runtime.string("before")), 7)');
    expect(result.code).toContain("vexa::nullishCoalesce(present, [&]()");
    expect(result.code).toContain('vexa::convertValue<vexa::Value>(runtime, runtime.string("fallback"))');
    expect(result.code).toContain("vexa::nullishCoalesce(missing, [&]()");
  });

  it("emits regular-expression literals and test calls", () => {
    const result = transpile(`val pattern = /hello/i
console.log(pattern.test("Hello world"), /x+/.test("abc"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('vexa::RegExp("hello", "i")');
    expect(result.code).toContain("vexa::regexTest(pattern");
    expect(result.code).toContain('vexa::regexTest(vexa::RegExp("x+", "")');
  });

  it("preserves int and long range iterator types", () => {
    const result = transpile(`for (n of 0 ..< 10) {
  console.log(n)
}
for (n of 0L ..< 10L) {
  console.log(n)
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (std::int32_t n = 0; n < 10; n++)");
    expect(result.code).toContain("for (std::int64_t n = 0LL; n < 10LL; n++)");
  });

  it("emits arbitrary-precision bigint operations without external libraries", () => {
    const result = transpile(`val large: bigint = 123456789012345678901234567890n
val divisor = 9876543210n
val parsed = BigInt("999999999999999999999999999999")
console.log(large + parsed, large - divisor, large * divisor)
console.log(large / divisor, large % divisor, -large)
console.log(large > divisor, 2n ** 100n)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('vexa::BigInt large = vexa::BigInt("123456789012345678901234567890")');
    expect(result.code).toContain('vexa::makeBigInt(runtime.string("999999999999999999999999999999"))');
    expect(result.code).toContain('vexa::pow(vexa::BigInt("2"), vexa::BigInt("100"))');
  });

  it("emits generic functions, classes, and methods as native templates", () => {
    const result = transpile(`fun identity<T>(value: T): T {
  return value
}

class Box<T>(val value: T) {
  fun get(): T { return value }
  fun echo<U>(other: U): U { return other }
}

val numberBox = Box(7)
val textBox = Box("native")
console.log(identity<int>(4), identity("generic"), numberBox.get(), textBox.echo<string>("ok"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("template <typename T>\nT identity");
    expect(result.code).toContain("template <typename T>\nclass Box");
    expect(result.code).toContain("template <typename U>\n  U echo");
    expect(result.code).toContain("runtime.make<Box<std::int32_t>>(7)");
    expect(result.code).toContain("identity<std::int32_t>(runtime, 4)");
    expect(result.code).toContain("textBox->echo<vexa::Value>(runtime, runtime.string(\"ok\"))");
  });

  it("preserves generic constraints, defaults, and nested managed result types", () => {
    const result = transpile(`class Entity(val id: int)
class EntityBox<T extends Entity>(val value: T)
class DefaultBox<T = bigint>(val value: T)

fun singleton<T>(value: T): T[] => [value]

async fun promised<T>(value: T): Promise<T> {
  return value
}

fun * repeated<T>(value: T): T {
  yield value
}

val entity = EntityBox(Entity(3))
val defaulted: DefaultBox = DefaultBox(4n)
val nested = singleton(EntityBox(Entity(5)))
console.log(entity.value.id, defaulted.value, nested[0].value.id, await promised(6), repeated(7).next().value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("template <typename T>\nclass EntityBox");
    expect(result.code).toContain("template <typename T = vexa::BigInt>\nclass DefaultBox;");
    expect(result.code).toContain("vexa::ArrayObject<T>* singleton");
    expect(result.code).toContain("vexa::Task<T> promised");
    expect(result.code).toContain("vexa::Generator<T> repeated");
    expect(result.code).toContain("runtime.make<EntityBox<Entity*>>(runtime.make<Entity>(3))");
  });

  it("reports analyzer constraint failures instead of emitting an invalid specialization", () => {
    const result = transpile(`class Entity(val id: int)
class EntityBox<T extends Entity>(val value: T)
val invalid = EntityBox("not an entity")`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors.some((error) => error.includes("does not satisfy constraint 'Entity'"))).toBe(true);
  });

  it("diagnoses open native generic annotations", () => {
    const result = transpile(`class Box<T>(val value: T)
val box: Box = Box(1)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toContain("C++ emission requires concrete or defaulted type arguments for native generic 'Box'");
  });

  it("emits generic interfaces and generic interface inheritance", () => {
    const result = transpile(`interface Readable<T> {
  val value: T
  fun read(): T
}

interface LabeledReadable<T> extends Readable<T> {
  val label: string
}

class Reader<T>(val value: T, val label: string) implements LabeledReadable<T> {
  override fun read(): T { return value }
}

class IntReader(val value: int) implements Readable<int> {
  override fun read(): int { return value }
}

val reader: LabeledReadable<int> = Reader(8, "count")
val concrete: Readable<int> = IntReader(9)
console.log(reader.label, reader.read(), concrete.value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("template <typename T>\nclass Readable");
    expect(result.code).toContain("template <typename T>\nclass LabeledReadable : public Readable<T>");
    expect(result.code).toContain("class Reader final : public cppgc::GarbageCollected<Reader<T>>, public vexa::DynamicValueObject, public LabeledReadable<T>");
    expect(result.code).toContain("T read(vexa::Runtime& __vexa_runtime) override");
    expect(result.code).toContain("std::int32_t __vexa_property_get_value(vexa::Runtime&) override");
  });

  it("emits generic extension functions and resolves extension calls", () => {
    const result = transpile(`fun <T> Array<T>.firstOr(fallback: T): T {
  return length > 0 ? this[0] : fallback
}

fun <T> Array<T>.firstOrElse(fallback: T): T {
  return firstOr(fallback)
}

class Wrapped<T>(val value: T)

fun <T> Wrapped<T>.unwrap(): T => this.value

console.log([4, 5].firstOr(0), ["x"].firstOrElse("empty"), Wrapped(9).unwrap())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("template <typename T>\nT __vexa_extension_Array_firstOr");
    expect(result.code).toContain("vexa::ArrayObject<T>* __vexa_extension_self");
    expect(result.code).toContain("__vexa_extension_Array_firstOr(__vexa_runtime, __vexa_extension_self, fallback)");
    expect(result.code).toContain("__vexa_extension_Wrapped_unwrap<std::int32_t>(runtime, runtime.make<Wrapped<std::int32_t>>(9))");
  });

  it("emits generic extension properties from analyzer member resolutions", () => {
    const result = transpile(`val <T> Array<T>.doubledLength: number => length * 2
console.log([1, 2, 3].doubledLength, ["x"].doubledLength)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("template <typename T>\ndouble __vexa_extension_property_Array_doubledLength");
    expect(result.code).toContain("static_cast<double>(vexa::arrayPointer(__vexa_extension_self)->size())");
    expect(result.code.match(/__vexa_extension_property_Array_doubledLength\(runtime,/g)?.length).toBe(2);
  });

  it("emits mutable extension-property accessor blocks through shared property lowering", () => {
    const result = transpile(`class Point(val x: int, val y: int)
class View(var x: int, var y: int)
var View.point: Point {
  get => Point(x, y)
  set { x = newValue.x; y = newValue.y }
}
val view = View(1, 2)
view.point = Point(3, 4)
console.log(view.point.x, view.x, view.y)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Point* __vexa_extension_property_View_point(");
    expect(result.code).toContain("void __vexa_extension_property_View_point_set(");
    expect(result.code).toContain("__vexa_extension_property_View_point_set(runtime, __vexa_property_receiver");
    expect(result.code).toContain("__vexa_extension_property_View_point(runtime, view)");
  });

  it("emits reusable inclusive and exclusive range expressions", () => {
    const result = transpile(`val inclusive = 1 ... 3
val exclusive = 4 ..< 6
for (value of inclusive) console.log(value)
for (value of exclusive) console.log(value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto inclusive = vexa::range(1, 3, false);");
    expect(result.code).toContain("auto exclusive = vexa::range(4, 6, true);");
    expect(result.code).toContain("for (auto value : inclusive)");
    expect(result.code).toContain("for (auto value : exclusive)");
  });

  it("emits managed addition, truthiness, comparison, and collection membership", () => {
    const result = transpile(`var message = "hello"
message += " world"
val empty: any = ""
val present: any = "value"
console.log(message, !empty, present && true, empty || false)
console.log(2 <=> 4, "b" <=> "a", "a" < "b")
console.log(2 in (1 ... 3), 8 in [7, 8, 9])`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('vexa::addAssign(runtime, message, runtime.string(" world"))');
    expect(result.code).toContain("!vexa::Boolean(empty)");
    expect(result.code).toContain("vexa::Boolean(present) && true");
    expect(result.code).toContain("vexa::Boolean(empty) || false");
    expect(result.code).toContain("vexa::compare(2, 4)");
    expect(result.code).toContain('vexa::compare(vexa::convertValue<vexa::Value>(runtime, runtime.string("b"))');
    expect(result.code).toContain('vexa::compare(vexa::convertValue<vexa::Value>(runtime, runtime.string("a"))');
    expect(result.code).toContain("vexa::includes(vexa::range(1, 3, false), 2)");
    expect(result.code).toContain("vexa::includes(vexa::arrayPointer(runtime.array<std::int32_t>({7, 8, 9})), 8)");
  });

  it("distinguishes loose and strict dynamic equality and uses complete truthiness", () => {
    const result = transpile(`val zero: any = 0
val zeroText: any = "0"
val nil: any = null
val missing: any = undefined
val zeroBig: any = 0n
console.log(zero == zeroText, zero === zeroText, nil == missing, nil === missing, Boolean(zeroBig))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code.match(/vexa::looseEquals\(/g)?.length).toBe(2);
    expect(result.code.match(/vexa::strictEquals\(/g)?.length).toBe(2);
    expect(result.code).toContain("zeroText)");
    expect(result.code).toContain("missing)");
    expect(result.code).toContain("vexa::Boolean(zeroBig)");
  });

  it("routes dynamic arithmetic, compound assignment, and updates through shared runtime helpers", () => {
    const result = transpile(`var value: any = 10
val values: any[] = [5]
val record = { value: 6 as any }
console.log(value - 3, value * 2, value / 4, value % 6, value ** 2, value & 3, value << 2, -value)
value -= 3
value++
values[0] *= 3
record.value--
console.log(value, values[0], record.value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::subtract(");
    expect(result.code).toContain("vexa::multiply(");
    expect(result.code).toContain("vexa::divide(");
    expect(result.code).toContain("vexa::remainder(");
    expect(result.code).toContain("vexa::power(");
    expect(result.code).toContain("vexa::bitwiseAnd(");
    expect(result.code).toContain("vexa::shiftLeft(");
    expect(result.code).toContain("vexa::negate(value)");
    expect(result.code).toContain("vexa::assignWith(value");
  });

  it("emits traceable Map and Set construction, mutation, lookup, size, and iteration", () => {
    const result = transpile(`val scores = new Map<string, int>([["a", 1], ["b", 2]])
scores.set("c", 3)
val seen = new Set<int>([1, 2, 2])
seen.add(3)
var total = 0
scores.forEach((value: int) => { total += value })
seen.forEach((value: int) => { total += value })
console.log(scores.get("a"), scores.has("b"), scores.delete("b"), scores.size, seen.has(2), seen.delete(1), seen.size, scores.keys(), scores.values(), scores.entries(), seen.values(), total)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::mapFromEntries<vexa::Value, std::int32_t>");
    expect(result.code).toContain("vexa::setFromArray<std::int32_t>");
    expect(result.code).toContain("vexa::mapSet(runtime, scores");
    expect(result.code).toContain("vexa::mapGet(runtime, scores");
    expect(result.code).toContain("vexa::mapForEach(scores");
    expect(result.code).toContain("vexa::setAdd(runtime, seen");
    expect(result.code).toContain("vexa::mapEntries(runtime, scores)");
    expect(result.code).toContain("vexa::setValues(runtime, seen)");
    expect(result.code).toContain("static_cast<double>(scores->size())");
  });

  it("iterates Map entries and Set values through their canonical managed arrays", () => {
    const result = transpile(`val values = new Map<int, string>()
values.set(1, "one")
for (entry of values) {
  val [key, value] = entry
  console.log(key, value)
}
val unique = new Set<int>()
unique.add(2)
for (value of unique) console.log(value)`, {
      sourceFilePath: "main.vx",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("*vexa::mapEntries(runtime, values)");
    expect(result.code).toContain("*vexa::setValues(runtime, unique)");
  });

  it("emits JSON parsing and deterministic stringification through dynamic values", () => {
    const result = transpile(`val encoded = JSON.stringify({ name: "Ada", values: [1, 2], active: true })
val decoded: any = JSON.parse(encoded)
console.log(encoded, decoded.name, decoded.values[1])`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::jsonStringify(runtime");
    expect(result.code).toContain("vexa::jsonParse(runtime");
    expect(result.code).toContain('vexa::dynamicGet(runtime, decoded, "name")');
  });

  it("emits weak-key Map and Set operations with weak managed edges", () => {
    const result = transpile(`class Key(val id: int)
val key = Key(1)
val values = new WeakMap<Key, string>()
val keys = new WeakSet<Key>()
values.set(key, "stored")
keys.add(key)
console.log(values.get(key), values.has(key), keys.has(key), values.delete(key), keys.delete(key))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.make<vexa::WeakMapObject<Key*, vexa::Value>>()");
    expect(result.code).toContain("runtime.make<vexa::WeakSetObject<Key*>>()");
    expect(result.code).toContain("vexa::weakMapSet(runtime, values, key");
    expect(result.code).toContain("vexa::weakSetAdd(runtime, keys, key)");
  });

  it("emits deterministic Date timestamps, UTC accessors, comparison, and JSON", () => {
    const result = transpile(`val epoch = new Date(0)
val later = new Date(1000)
console.log(epoch.getTime(), epoch.getUTCFullYear(), epoch.getUTCMonth(), epoch.toISOString(), epoch < later, JSON.stringify(epoch), Date.now() > 0)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.make<vexa::DateObject>(0)");
    expect(result.code).toContain("epoch->getUTCFullYear()");
    expect(result.code).toContain("epoch->toISOString()");
    expect(result.code).toContain("epoch->getTime() < later->getTime()");
    expect(result.code).toContain("vexa::dateNow()");
  });

  it("emits shared ArrayBuffer, Uint8Array, and DataView storage", () => {
    const result = transpile(`val buffer = new ArrayBuffer(4)
val bytes = new Uint8Array(buffer)
val view = new DataView(buffer)
bytes[0] = 1
view.setUint16(1, 515)
val copied = new Uint8Array([255, 256, -1])
console.log(buffer.byteLength, bytes.length, bytes.byteOffset, bytes[0], bytes[1], bytes[2], view.getUint16(1), copied[0], copied[1], copied[2])`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.make<vexa::ArrayBufferObject>");
    expect(result.code).toContain("vexa::makeUint8Array(runtime, buffer)");
    expect(result.code).toContain("vexa::makeDataView(runtime, buffer)");
    expect(result.code).toContain("bytes->set(0, 1)");
    expect(result.code).toContain("view->setUint16(1, 515)");
  });

  it("emits explicit class construction and typed local lambdas", () => {
    const result = transpile(`class Box(val value: int)
val box = new Box(4)
val add = (left: int, right: int) => left + right
val read = (item: Box) => item.value
val multiply = function(left: int, right: int): int { return left * right }
console.log(add(2, 3), read(box), multiply(3, 4))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto box = runtime.make<Box>(4);");
    expect(result.code).toContain("auto add = [&](std::int32_t left, std::int32_t right)");
    expect(result.code).toContain("auto read = [&](Box* item)");
    expect(result.code).toContain("return item->value;");
    expect(result.code).toContain("auto multiply = [&](std::int32_t left, std::int32_t right)");
    expect(result.code).toContain("vexa::console.log(add(2, 3), read(box), multiply(3, 4));");
  });

  it("emits resolved class operator overloads and derived comparisons", () => {
    const result = transpile(`class NumberBox(var value: int) {
  operator+(other: NumberBox): NumberBox => NumberBox(value + other.value)
  operator-(): NumberBox => NumberBox(-value)
  operator<=>(other: NumberBox): int => value <=> other.value
  operator[](offset: int): int => value + offset
  operator[]=(next: int, offset: int): void { value = next + offset }
}

class Tag(val name: string) {
  operator==(other: Tag): boolean => name == other.name
}

var sum = NumberBox(2) + NumberBox(3)
sum += NumberBox(1)
val negative = -sum
val less = NumberBox(1) < NumberBox(2)
val same = Tag("a") == Tag("a")
val different = Tag("a") != Tag("b")
val indexed = sum[4]
sum[2] = 8
console.log(sum.value, negative.value, less, same, different, indexed)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("NumberBox* operator_plus__NumberBox(vexa::Runtime& __vexa_runtime, NumberBox* other)");
    expect(result.code).toContain("NumberBox* operator_minus__void(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("std::int32_t operator_spaceship__NumberBox(vexa::Runtime& __vexa_runtime, NumberBox* other)");
    expect(result.code).toContain("NumberBox>(2)->operator_plus__NumberBox(runtime, runtime.make<NumberBox>(3))");
    expect(result.code).toContain("vexa::assignWith(sum, [&](auto __vexa_compound_target)");
    expect(result.code).toContain("__vexa_compound_target->operator_plus__NumberBox(runtime, runtime.make<NumberBox>(1))");
    expect(result.code).toContain("sum->operator_minus__void(runtime)");
    expect(result.code).toContain("operator_spaceship__NumberBox(runtime, runtime.make<NumberBox>(2)) < 0");
    expect(result.code).toContain('operator_equals__Tag(runtime, runtime.make<Tag>(runtime.string("a")))');
    expect(result.code).toContain("!runtime.make<Tag>(runtime.string(\"a\"))->operator_equals__Tag");
    expect(result.code).toContain("sum->operator_get__int(runtime, 4)");
    expect(result.code).toContain("sum->operator_set__int__int(runtime, 8, 2)");
  });

  it("emits interface contracts and dispatches different implementations through one type", () => {
    const result = transpile(`interface Greeter {
  fun greet(prefix: string): string
}

interface NamedGreeter extends Greeter {
  fun label(): string
}

class English(val name: string) : NamedGreeter {
  override fun greet(prefix: string): string => prefix + " " + name
  override fun label(): string => "English"
}

class Spanish(val name: string) implements NamedGreeter {
  override fun greet(prefix: string): string => prefix + ", " + name
  override fun label(): string => "Spanish"
}

class GreeterHolder(val value: Greeter) {
  fun greet(): string => value.greet("Stored")
}

fun greet(value: Greeter, prefix: string): string {
  return value.greet(prefix)
}

fun identify(value: NamedGreeter): string {
  return value.greet("Welcome") + " from " + value.label()
}

val first: NamedGreeter = English("Ada")
val second: NamedGreeter = Spanish("Luz")
val greeters: Greeter[] = [first, second]
val holder = GreeterHolder(second)
console.log(greet(first, "Hello"), greet(second, "Hola"), identify(first), holder.greet())
for (greeter of greeters) console.log(greeter.greet("Hi"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class Greeter;");
    expect(result.code).toContain("class Greeter : public cppgc::GarbageCollectedMixin {");
    expect(result.code).toContain("class NamedGreeter : public Greeter {");
    expect(result.code).toContain(
      "virtual vexa::Value greet(vexa::Runtime& __vexa_runtime, vexa::Value prefix) = 0;"
    );
    expect(result.code).toContain(
      "class English final : public cppgc::GarbageCollected<English>, public vexa::DynamicValueObject, public NamedGreeter"
    );
    expect(result.code).toContain(
      "class Spanish final : public cppgc::GarbageCollected<Spanish>, public vexa::DynamicValueObject, public NamedGreeter"
    );
    expect(result.code).toContain("vexa::Value greet(vexa::Runtime& __vexa_runtime, vexa::Value prefix) override");
    expect(result.code).toContain("vexa::Value greet(vexa::Runtime& __vexa_runtime, Greeter* value, vexa::Value prefix);");
    expect(result.code).toContain("return value->greet(__vexa_runtime, prefix);");
    expect(result.code).toContain('value->greet(__vexa_runtime, __vexa_runtime.string("Welcome"))');
    expect(result.code).toContain("value->label(__vexa_runtime)");
    expect(result.code).toContain("runtime.array<Greeter*>({first, second})");
    expect(result.code).toContain("const cppgc::Member<Greeter> value;");
    expect(result.code).toContain("visitor->Trace(value);");
    expect(result.code).toContain('greeter->greet(runtime, runtime.string("Hi"))');
    expect(result.code).toContain(
      'greet(runtime, first, runtime.string("Hello")), greet(runtime, second, runtime.string("Hola")), identify(runtime, first)'
    );
  });

  it("emits optional interface members with inherited defaults", () => {
    const result = transpile(`interface MaybeNamed {
  val label?: string
  fun ping?(): int
}

class Empty() : MaybeNamed
class Named(val label: string) : MaybeNamed {
  override fun ping(): int => 4
}

val empty: MaybeNamed = Empty()
val named: MaybeNamed = Named("ready")
val structural: MaybeNamed = {}
console.log(empty.label, named.label, named.ping(), structural.label)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_label(vexa::Runtime&) { return vexa::Value::undefined(); }");
    expect(result.code).toContain("virtual std::int32_t ping(vexa::Runtime& __vexa_runtime) { throw std::runtime_error");
    expect(result.code).toContain("vexa::Value __vexa_property_get_label(vexa::Runtime& __vexa_runtime) override");
  });

  it("represents literal and heterogeneous union properties as dynamic values", () => {
    const result = transpile(`interface Token {
  kind: "identifier" | "number" | "eof"
  payload: string | number | undefined
  items: (Token | string)[]
  records: Array<{ name: string }>
  refined: Token & { offset: number }
  seen: WeakSet<object>
  selected: Token["kind"]
  callback: (value: number) => boolean
  fragments: Array<Omit<Token, "kind">>
  readonlyItems: readonly Token[]
  derived: ReturnType<() => Token>
}`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_kind");
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_payload");
    expect(result.code).toContain("virtual vexa::ArrayObject<vexa::Value>* __vexa_property_get_items");
    expect(result.code).toContain("virtual vexa::ArrayObject<vexa::RecordObject*>* __vexa_property_get_records");
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_refined");
    expect(result.code).toContain("virtual vexa::WeakSetObject<vexa::DynamicValueObject*>* __vexa_property_get_seen");
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_selected");
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_callback");
    expect(result.code).toContain("virtual vexa::ArrayObject<vexa::RecordObject*>* __vexa_property_get_fragments");
    expect(result.code).toContain("virtual vexa::ArrayObject<Token*>* __vexa_property_get_readonlyItems");
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_derived");
  });

  it("emits TypeScript type-predicate returns as native booleans", () => {
    const result = transpile(`interface Node { kind: string }
function isNode(value: unknown): value is Node { return true }`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("bool isNode(vexa::Runtime& __vexa_runtime, vexa::Value value)");
  });

  it("dispatches interface property reads and writes to field-backed implementations", () => {
    const result = transpile(`class Leaf(val value: int)

interface Meter {
  var value: int
  val label: string
  val leaf: Leaf
}

class Counter(var value: int, val label: string, val leaf: Leaf) : Meter

fun update(meter: Meter, next: int): string {
  meter.value = next
  meter.value += 2
  meter.value++
  return \`\${meter.label}:\${meter.value}:\${meter.leaf.value}\`
}

val counter: Meter = Counter(1, "main", Leaf(7))
console.log(update(counter, 4), counter.value, counter.label)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "virtual std::int32_t __vexa_property_get_value(vexa::Runtime& __vexa_runtime) = 0;"
    );
    expect(result.code).toContain(
      "virtual void __vexa_property_set_value(vexa::Runtime& __vexa_runtime, std::int32_t value) = 0;"
    );
    expect(result.code).toContain(
      "vexa::Value __vexa_property_get_label(vexa::Runtime&) override"
    );
    expect(result.code).toContain(
      "Leaf* __vexa_property_get_leaf(vexa::Runtime&) override"
    );
    expect(result.code).toContain("return this->leaf;");
    expect(result.code).toContain(
      "__vexa_property_receiver->__vexa_property_set_value(__vexa_runtime, __vexa_property_value)"
    );
    expect(result.code).toContain(
      "auto __vexa_property_current = __vexa_property_receiver->__vexa_property_get_value(__vexa_runtime)"
    );
    expect(result.code).toContain(
      "auto __vexa_property_value = (__vexa_property_current + __vexa_property_operand)"
    );
    expect(result.code).toContain("auto __vexa_property_value = (__vexa_property_current + 1)");
    expect(result.code).toContain("meter->__vexa_property_get_label(__vexa_runtime)");
    expect(result.code).toContain("meter->__vexa_property_get_value(__vexa_runtime)");
    expect(result.code).toContain("meter->__vexa_property_get_leaf(__vexa_runtime)->value");
    expect(result.code).toContain("vexa::add(__vexa_runtime");
    expect(result.code).toContain("counter->__vexa_property_get_value(runtime)");
  });

  it("emits computed class getters and uses them as interface property implementations", () => {
    const result = transpile(`interface Shape {
  val area: int
  val title: string
}

class Rectangle(val width: int, val height: int) : Shape {
  override area: int => width * height

  override get title(): string {
    return "rectangle"
  }

  fun summary(): string {
    return title + ":" + area.toString()
  }
}

fun inspect(shape: Shape): string {
  return shape.title + ":" + shape.area.toString()
}

val rectangle = Rectangle(3, 4)
console.log(rectangle.area, rectangle.title, rectangle.summary(), inspect(rectangle))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t area(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("vexa::Value title(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain(
      "std::int32_t __vexa_property_get_area(vexa::Runtime& __vexa_runtime) override { return this->area(__vexa_runtime); }"
    );
    expect(result.code).toContain(
      "vexa::Value __vexa_property_get_title(vexa::Runtime& __vexa_runtime) override { return this->title(__vexa_runtime); }"
    );
    expect(result.code).toContain("this->title(__vexa_runtime)");
    expect(result.code).toContain("this->area(__vexa_runtime)");
    expect(result.code).toContain("rectangle->area(runtime)");
    expect(result.code).toContain("rectangle->title(runtime)");
    expect(result.code).toContain("shape->__vexa_property_get_area(__vexa_runtime)");
  });

  it("emits setter accessors and uses getter-setter pairs for mutable interface properties", () => {
    const result = transpile(`interface Meter {
  var value: int
}

class Counter(var stored: int) : Meter {
  override get value(): int {
    return stored
  }

  override set value(next: int) {
    stored = next
  }

  fun bump(): int {
    value += 1
    return value
  }
}

fun mutate(counter: Counter): string {
  counter.value = 4
  val assigned = (counter.value += 2)
  val old = counter.value++
  val next = ++counter.value
  return \`\${assigned}:\${old}:\${next}:\${counter.value}\`
}

val counter = Counter(1)
val meter: Meter = counter
console.log(mutate(counter))
meter.value -= 1
console.log(meter.value, counter.value, counter.bump())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t value(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("void value(vexa::Runtime& __vexa_runtime, std::int32_t next)");
    expect(result.code).toContain(
      "void __vexa_property_set_value(vexa::Runtime& __vexa_runtime, std::int32_t __vexa_property_value) override { this->value(__vexa_runtime, __vexa_property_value); }"
    );
    expect(result.code).toContain("__vexa_property_receiver->value(__vexa_runtime, __vexa_property_value)");
    expect(result.code).toContain("counter->value(__vexa_runtime)");
    expect(result.code).toContain("auto* __vexa_property_receiver = this");
    expect(result.code).toContain("__vexa_property_receiver->__vexa_property_set_value(runtime");
  });

  it("emits managed object literals with nested typed property reads and writes", () => {
    const result = transpile(`val label = "root"
val record = {
  label,
  count: 1,
  nested: { active: true }
}
record.count += 2
record.nested.active = false
console.log(record.label, record.count, record.nested.active)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('runtime.record({{"label", vexa::convertValue<vexa::Value>(runtime, label)}');
    expect(result.code).toContain('vexa::recordGet<std::int32_t>(runtime, record, "count")');
    expect(result.code).toContain('vexa::recordGet<vexa::RecordObject*>(runtime, record, "nested")');
    expect(result.code).toContain('vexa::recordSet(runtime, __vexa_property_receiver, "active", __vexa_property_value)');
  });

  it("round-trips managed arrays through any without copying their storage", () => {
    const result = transpile(`val shared = [1, 2]
val dynamic: any = shared
val restored = dynamic as int[]
restored.push(3)
console.log(shared, dynamic, restored)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Value dynamic = vexa::convertValue<vexa::Value>(runtime, shared)");
    expect(result.code).toContain("vexa::convertValue<vexa::ArrayObject<std::int32_t>*>(runtime, dynamic)");
    expect(result.code).toContain("vexa::console.log(shared, dynamic, restored)");
  });

  it("round-trips generated objects and interface views through any", () => {
    const result = transpile(`interface MutableValue {
  var value: int
}
class DynamicCounter(var value: int) implements MutableValue
val counter = DynamicCounter(2)
val dynamic: any = counter
val restored = dynamic as DynamicCounter
val view = dynamic as MutableValue
restored.value += 3
view.value += 4
console.log(counter.value, restored.value, view.value, dynamic)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("public vexa::DynamicValueObject, public MutableValue");
    expect(result.code).toContain("vexa::Value dynamic = vexa::convertValue<vexa::Value>(runtime, counter)");
    expect(result.code).toContain("vexa::convertValue<DynamicCounter*>(runtime, dynamic)");
    expect(result.code).toContain("vexa::convertValue<MutableValue*>(runtime, dynamic)");
  });

  it("stores typed closures in dynamic values and object properties", () => {
    const result = transpile(`val offset = 3
val dynamic: any = (value: int) => value + offset
val record = {
  apply: (value: int) => value * 2,
  add(value: int): int { return value + 5 }
}
val owner: any = { offset: offset }
owner.self = () => owner
console.log(dynamic(4), record.apply(5), record.add(6))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::makeFunction<std::int32_t, std::int32_t>(runtime");
    expect(result.code).toContain("vexa::call(runtime, dynamic");
    expect(result.code).toContain("vexa::StoredValue(owner)");
    expect(result.code).toContain('vexa::call(runtime, vexa::recordGet<vexa::Value>(runtime, record, "apply")');
    expect(result.code).toContain('vexa::call(runtime, vexa::recordGet<vexa::Value>(runtime, record, "add")');
  });

  it("adapts multiple callable structural records to the same interface", () => {
    const result = transpile(`interface Transformer {
  val label: string
  fun apply(value: int): int
}
fun run(transformer: Transformer, value: int): int => transformer.apply(value)
val first: Transformer = { label: "double", apply: (value: int) => value * 2 }
val second: Transformer = { label: "offset", apply(value: int): int { return value + 3 } }
console.log(first.label, run(first, 4), second.label, run(second, 4))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class __vexa_record_adapter_Transformer final");
    expect(result.code).toContain('vexa::recordGet<vexa::Value>(__vexa_runtime, record_, "apply")');
    expect(result.code).toContain("vexa::convertValue<std::int32_t>(__vexa_runtime, vexa::call");
  });

  it("emits common Array search and mutation APIs through ArrayObject", () => {
    const result = transpile(`val values = [1, 2, 3, 2]
val found = values.find { value, index, array -> value == 2 && index < array.length }
val removed = values.splice(1, 2, 8, 9)
values.fill(5, 1, 2).copyWithin(2, 0, 2)
console.log(values.at(-1), values.lastIndexOf(5), found, removed)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::find(vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::splice(runtime, vexa::arrayPointer(values), 1, 2, 8, 9)");
    expect(result.code).toContain("vexa::copyWithin(vexa::arrayPointer(vexa::fill(");
    expect(result.code).toContain("vexa::at(vexa::arrayPointer(values), (-1))");
    expect(result.code).toContain("vexa::lastIndexOf(vexa::arrayPointer(values), 5)");
  });

  it("emits Array flat and flatMap through the canonical native array runtime", () => {
    const result = transpile(`val flattened = [[1, 2], [3]].flat()
val expanded = [1, 2].flatMap((value: int) => [value, value * 10])
console.log(flattened, expanded)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::flat(runtime");
    expect(result.code).toContain("vexa::flatMap(runtime");
  });

  it("emits array and object destructuring bindings in native for-of loops", () => {
    const result = transpile(`var total = 0
for (val [left, right] of [[1, 2], [3, 4]]) total += left + right
for (val { value: int } of [{ value: 5 }, { value: 6 }]) total += value
console.log(total)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (auto __vexa_loop_binding_");
    expect(result.code).toContain("vexa::arrayGet(vexa::arrayPointer(__vexa_loop_binding_");
    expect(result.code).toContain("vexa::recordGet<");
  });

  it("emits object spreads, computed properties, membership, deletion, and optional reads", () => {
    const result = transpile(`val key = "score"
val base = { name: "Ada", stale: true }
val record = { ...base, [key]: 40, score: 41 }
record[key] += 1
val hadName = "name" in record
val removed = delete record.stale
val optionalName = record?.name
console.log(record.name, record.score, hadName, removed, optionalName)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::recordSpread(__vexa_record, base)");
    expect(result.code).toContain("vexa::propertyKey(key)");
    expect(result.code).toContain("vexa::recordHas(record, vexa::propertyKey(runtime.string(\"name\")))");
    expect(result.code).toContain('vexa::recordDelete(record, "stale")');
    expect(result.code).toContain('vexa::recordGetOptional(record, "name")');
  });

  it("checks dynamic record membership when analysis cannot retain a record type", () => {
    const result = transpile(`val value: any = { present: undefined }
console.log("present" in value, "missing" in value)`, {
      sourceFilePath: "main.vx",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::hasProperty(runtime, value");
  });

  it("adapts structurally compatible records to property-only interfaces", () => {
    const result = transpile(`interface Meter {
  val label: string
  var value: int
}
fun render(meter: Meter): string {
  meter.value += 1
  return \`\${meter.label}:\${meter.value}\`
}
val first = { label: "cpu", value: 4 }
val second: Meter = { label: "ram", value: 8 }
console.log(render(first), render(second), second.value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class __vexa_record_adapter_Meter final");
    expect(result.code).toContain("runtime.make<__vexa_record_adapter_Meter>(first)");
    expect(result.code).toContain("runtime.make<__vexa_record_adapter_Meter>(runtime.record(");
    expect(result.code).toContain('vexa::recordGet<vexa::Value>(__vexa_runtime, record_, "label")');
    expect(result.code).toContain('vexa::recordSet(__vexa_runtime, record_, "value", value)');
  });

  it("emits abstract base classes, virtual overrides, and multiple interfaces", () => {
    const result = transpile(`interface Named { val label: string }
interface Weighted { val weight: int }
abstract class Shape {
  abstract fun area(): number
}
class Square(val label: string, val weight: int, val size: number) extends Shape implements Named, Weighted {
  override fun area(): number { return size * size }
}
fun measure(shape: Shape): number { return shape.area() }
val square = Square("box", 2, 3)
console.log(square.label, square.weight, measure(square))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class Shape : public cppgc::GarbageCollected<Shape>");
    expect(result.code).toContain("virtual double area(vexa::Runtime& __vexa_runtime) = 0;");
    expect(result.code).toContain("class Square final : public Shape, public Named, public Weighted");
    expect(result.code).toContain("double area(vexa::Runtime& __vexa_runtime) override");
    expect(result.code).toContain("Shape::Trace(visitor)");
    expect(result.code).toContain("Named::Trace(visitor)");
    expect(result.code).toContain("Weighted::Trace(visitor)");
  });

  it("emits concrete inheritance and qualified super method calls", () => {
    const result = transpile(`class Animal {
  fun speak(): string { return "base" }
}
class Dog extends Animal {
  override fun speak(): string { return super.speak() + "!" }
}
fun speak(animal: Animal): string { return animal.speak() }
console.log(speak(Dog()))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class Animal : public cppgc::GarbageCollected<Animal>");
    expect(result.code).toContain("virtual vexa::Value speak(");
    expect(result.code).toContain("class Dog final : public Animal");
    expect(result.code).toContain("this->Animal::speak(__vexa_runtime)");
  });

  it("forwards derived constructor arguments through super and initializes parameter properties", () => {
    const result = transpile(`class Base {
  constructor(public x: int) {}
}

class Child extends Base {
  constructor(public readonly y: int) {
    super(y + 1)
  }

  fun total(): int => x + y
}

console.log(new Child(4).total())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Base(vexa::Runtime& __vexa_runtime, std::int32_t x)");
    expect(result.code).toContain("Child(vexa::Runtime& __vexa_runtime, std::int32_t y) : Base(__vexa_runtime, (y + 1)), y(y)");
    expect(result.code).toContain("const std::int32_t y;");
    expect(result.code).toContain("runtime.make<Child>(runtime, 4)");
  });

  it("emits analyzer-resolved is and instanceof checks for native objects", () => {
    const result = transpile(`class Animal {}
class Dog extends Animal {}
val dog = Dog()
val dynamicDog: any = dog
console.log(dog is Dog, dog instanceof Animal, dynamicDog is Dog)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::isInstance<Dog>(dog)");
    expect(result.code).toContain("vexa::isInstance<Animal>(dog)");
    expect(result.code).toContain("vexa::isInstance<Dog>(dynamicDog)");
  });

  it("emits numeric enums as typed constants across functions, arrays, and switches", () => {
    const result = transpile(`enum Permission {
  None,
  Read = 1,
  Write = Read << 1,
  Execute = Permission.Write << 1,
  All = Read | Write | Execute
}

fun has(value: Permission, flag: Permission): boolean {
  return (value & flag) != 0
}

fun writable(): Permission {
  return Permission.Write
}

val permissions: Permission = Permission.All
val ordered: Permission[] = [Permission.None, writable(), Permission.Execute]
console.log(Permission.None, Permission.Read, has(permissions, Permission.Write), ordered[2])
switch (permissions) {
  case Permission.All:
    console.log("all")
    break
  default:
    console.log("partial")
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("struct Permission final {");
    expect(result.code).toContain("static constexpr std::int32_t None = 0;");
    expect(result.code).toContain("static constexpr std::int32_t Read = 1;");
    expect(result.code).toContain("static constexpr std::int32_t Write = (Read << 1);");
    expect(result.code).toContain("static constexpr std::int32_t Execute = (Permission::Write << 1);");
    expect(result.code).toContain("static constexpr std::int32_t All = ((Read | Write) | Execute);");
    expect(result.code).toContain(
      "bool has(vexa::Runtime& __vexa_runtime, std::int32_t value, std::int32_t flag);"
    );
    expect(result.code).toContain("std::int32_t writable(vexa::Runtime& __vexa_runtime);");
    expect(result.code).toContain("return Permission::Write;");
    expect(result.code).toContain(
      "runtime.array<std::int32_t>({Permission::None, writable(runtime), Permission::Execute})"
    );
    expect(result.code).toContain("case Permission::All:");
  });

  it("rejects string enums before producing invalid native constants", () => {
    const result = transpile(`enum Label {
  Ready = "ready"
}
console.log(Label.Ready)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual(["C++ emission supports numeric enum constant expressions only"]);
  });

  it("resolves native type aliases and declared array parameter types", () => {
    const result = transpile(`type Count = int
type Counts = Count[]

fun total(values: Counts): Count {
  return values[0] + values[1]
}

val values: Counts = [2, 3]
console.log(total(values))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "std::int32_t total(vexa::Runtime& __vexa_runtime, vexa::ArrayObject<std::int32_t>* values);"
    );
    expect(result.code).toContain("return (vexa::arrayGet(vexa::arrayPointer(values), 0) + vexa::arrayGet(vexa::arrayPointer(values), 1));");
    expect(result.code).toContain("runtime.array<std::int32_t>({2, 3})");
    expect(result.code).not.toContain("type Count");
  });

  it("emits primary-constructor classes as Oilpan-managed objects", () => {
    const result = transpile(`class Point(val x: number, val y: number)

val point = Point(1, 2)
console.log("Hello World!")
for (n of 0..<10) {
  console.log(n)
}
console.log(point.x, point.y)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class Point final : public cppgc::GarbageCollected<Point>");
    expect(result.code).toContain("Point(double x, double y) : x(x), y(y) {}");
    expect(result.code).toContain("const double x;");
    expect(result.code).toContain("const double y;");
    expect(result.code).toContain("auto point = runtime.make<Point>(1, 2);");
    expect(result.code).toContain('vexa::console.log(runtime.string("Hello World!"));');
    expect(result.code).toContain("vexa::console.log(point->x, point->y);");
  });

  it("traces generated objects stored in primary-constructor fields", () => {
    const result = transpile(`class Leaf(var value: int)

class Branch(val leaf: Leaf) {
  fun read(): int {
    return leaf.value
  }
}

val leaf = Leaf(4)
val branch = Branch(leaf)
console.log(branch.leaf.value, branch.read())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Branch(Leaf* leaf) : leaf(leaf) {}");
    expect(result.code).toContain("const cppgc::Member<Leaf> leaf;");
    expect(result.code).toContain("void Trace(cppgc::Visitor* visitor) const final { visitor->Trace(leaf); }");
    expect(result.code).toContain("return this->leaf->value;");
  });

  it("emits initialized instance fields with runtime-backed strings and objects", () => {
    const result = transpile(`class Leaf(var value: int)

class Profile {
  var name: string = "Ada"
  var score: int = 1
  val leaf: Leaf = Leaf(5)

  fun total(): int {
    return score + leaf.value
  }
}

val profile = Profile()
profile.score += 2
console.log(profile.name, profile.total())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Profile(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain('name(__vexa_runtime.string("Ada"))');
    expect(result.code).toContain("score(1)");
    expect(result.code).toContain("leaf(__vexa_runtime.make<Leaf>(5))");
    expect(result.code).toContain("cppgc::Member<Leaf> leaf;");
    expect(result.code).toContain("visitor->Trace(leaf);");
    expect(result.code).toContain("runtime.make<Profile>(runtime)");
  });

  it("uses declared element types for empty field arrays and permits constructor initialization of readonly fields", () => {
    const result = transpile(`class Item {}
class Store {
  private readonly items: Item[] = []
  private readonly enabled: boolean

  constructor(enabled: boolean) {
    this.enabled = enabled
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("items(__vexa_runtime.array<Item*>({}))");
    expect(result.code).toContain("cppgc::Member<vexa::ArrayObject<Item*>> items;");
    expect(result.code).toContain("bool enabled;");
    expect(result.code).not.toContain("const bool enabled;");
  });

  it("infers managed instance field types and traces them", () => {
    const result = transpile(`class Key {}
class Entry {}

class Registry {
  private readonly entries = new Map<string, int>()
  private readonly visited = new WeakSet<object>()
  private readonly scopes: WeakMap<Key, Entry> = new WeakMap()
  private readonly labels = ["one", "two"]

  fun size(): number {
    return entries.size + labels.length
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("cppgc::Member<vexa::MapObject<vexa::Value, std::int32_t>> entries;");
    expect(result.code).toContain("cppgc::Member<vexa::WeakSetObject<vexa::DynamicValueObject*>> visited;");
    expect(result.code).toContain("cppgc::Member<vexa::WeakMapObject<Key*, Entry*>> scopes;");
    expect(result.code).toContain("scopes(__vexa_runtime.make<vexa::WeakMapObject<Key*, Entry*>>())");
    expect(result.code).toContain("cppgc::Member<vexa::ArrayObject<std::string>> labels;");
    expect(result.code).toContain("visitor->Trace(entries);");
    expect(result.code).toContain("visitor->Trace(visited);");
    expect(result.code).toContain("visitor->Trace(labels);");
  });

  it("keeps conditionally initialized local arrays iterable", () => {
    const result = transpile(`fun visit(useLeft: boolean) {
  val values = useLeft ? [{ name: "left" }] : [{ name: "right" }]
  for (val value of values) {
    console.log(value.name)
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (auto value : *vexa::arrayPointer(values))");
  });

  it("defers unresolved native array iteration to C++ template deduction", () => {
    const result = transpile(`interface Item { name: string }
interface Container { items?: Item[] }

fun visit(container: Container) {
  val items = container.items && container.items.length > 0
    ? container.items
    : [{ name: "fallback" }]
  for (val item of items) {
    console.log(item.name)
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("*vexa::arrayPointer(items)");
  });

  it("iterates dynamically typed arrays through the shared runtime boundary", async () => {
    const result = transpile(`fun visit(items: any) {
  for (val item of items) {
    console.log(item)
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("for (auto item : *vexa::arrayPointer(items))");
    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("inline ArrayObject<Value>* arrayPointer(const Value& value)");
  });

  it("uses dynamic element types for unconstrained Map and Set construction", () => {
    const result = transpile(`val map = new Map()
val set = new Set()`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.make<vexa::MapObject<vexa::Value, vexa::Value>>()");
    expect(result.code).toContain("runtime.make<vexa::SetObject<vexa::Value>>()");
  });

  it("roots managed static class fields with lazy Oilpan persistence", () => {
    const result = transpile(`class Kinds {
  private static readonly names = new Set<string>(["one", "two"])

  static fun has(name: string): boolean {
    return Kinds.names.has(name)
  }
}

console.log(Kinds.has("one"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("static vexa::SetObject<vexa::Value>* __vexa_static_names(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("static cppgc::Persistent<vexa::SetObject<vexa::Value>> __vexa_value;");
    expect(result.code).toContain("vexa::setHas(__vexa_runtime, Kinds::__vexa_static_names(__vexa_runtime), name)");
  });

  it("copies native Map and Set instances through their iterable constructors", () => {
    const result = transpile(`val sourceMap = new Map<string, int>()
val copiedMap = new Map(sourceMap)
val sourceSet = new Set<int>()
val copiedSet = new Set(sourceSet)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::mapFromIterable<vexa::Value, vexa::Value>(runtime, vexa::rawPointer(sourceMap))");
    expect(result.code).toContain("vexa::setFromIterable<vexa::Value>(runtime, vexa::rawPointer(sourceSet))");
  });

  it("lowers destructured native lambda parameters once at the callable boundary", () => {
    const result = transpile(`val entries = [["first", 1], ["second", 2]]
val names = entries.filter(([name]) => name == "first").map(([name, value]) => name)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("(auto __vexa_parameter_0)");
    expect(result.code).toContain("auto name = vexa::arrayGet(vexa::arrayPointer(__vexa_parameter_0), 0);");
    expect(result.code).toContain("auto value = vexa::arrayGet(vexa::arrayPointer(__vexa_parameter_0), 1);");
  });

  it("uses the dynamic boundary for TypeScript type-query parameters", () => {
    const result = transpile(`val state = { items: [1, 2] }
fun visit(items: typeof state.items) {
  for (val item of items) console.log(item)
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("void visit(vexa::Runtime& __vexa_runtime, vexa::Value items)");
  });

  it("constructs regular expressions from dynamic patterns and optional flags", () => {
    const result = transpile(`val name = "item"
val expression = new RegExp("\\b" + name + "\\b", "gi")
console.log(expression.test("an item here"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::RegExp(vexa::toString(");
    expect(result.code).toContain('vexa::toString(runtime.string("gi"))');
  });

  it("enumerates structural interface keys for for-in and computed access", () => {
    const result = transpile(`interface Node { kind: string }
fun inspect(node: Node) {
  for (val key in node) {
    console.log(key, node[key])
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("public cppgc::GarbageCollectedMixin, public virtual vexa::EnumerableObject");
    expect(result.code).toContain("for (auto key : vexa::objectKeys(vexa::rawPointer(node)))");
    expect(result.code).toContain("vexa::enumerableGet(__vexa_runtime, vexa::rawPointer(node), vexa::toString(key))");
    expect(result.code).toContain("std::vector<std::string> enumerableKeys() const override");
  });

  it("constructs WeakSet from a native array while retaining weak keys", () => {
    const result = transpile(`class Key {}
val key = Key()
val values = new WeakSet<object>([key as object])
console.log(values.has(key))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::weakSetFromArray<vexa::DynamicValueObject*>");
  });

  it("checks native collection constructors through shared runtime identities", () => {
    const result = transpile(`fun isMap(value: unknown): boolean {
  return value instanceof Map
}
console.log(isMap(new Map()))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("return vexa::isMapLike(value);");
  });

  it("constructs length-based Array values for subsequent native methods", () => {
    const result = transpile(`val values = new Array(3).fill("missing")
console.log(values.join(","))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::arrayWithLength<vexa::Value>(runtime, 3)");
  });

  it("expands array spreads passed to splice without copying the receiver", () => {
    const result = transpile(`val values = [1, 4]
val inserted = [2, 3]
values.splice(1, 0, ...inserted)
console.log(values.join(","))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::spliceAll(runtime, __vexa_receiver, 1, 0, __vexa_values)");
  });

  it("infers accessor return representations and converts primitive string results", () => {
    const result = transpile(`class Reader {
  constructor(private text: string) {}
  get length() { return text.length }
  peek() { return text.charAt(0) }
  peekCode() { return text.charCodeAt(0) }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t length(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("return vexa::convertValue<vexa::Value>(__vexa_runtime, vexa::charAt(");
    expect(result.code).toContain("return vexa::convertValue<double>(__vexa_runtime, vexa::charCodeAt(");
  });

  it("converts assignment values to the native representation of the target", () => {
    const result = transpile(`interface Options { enabled?: boolean }
class Demo {
  private enabled: boolean = false
  constructor(options: Options) {
    this.enabled = options.enabled
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("this->enabled = vexa::convertValue<bool>");
  });

  it("materializes class pointers inside successful instanceof branches", () => {
    const result = transpile(`class ParseFailure {
  constructor(public hint: int) {}
}
fun recover(error: unknown): int {
  if (error instanceof ParseFailure) return error.hint
  return 0
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto* __vexa_narrowed_error = vexa::convertValue<ParseFailure*>(__vexa_runtime, error);");
    expect(result.code).toContain("auto* error = __vexa_narrowed_error;");
  });

  it("preserves pointer and generic representations across undefined unions", () => {
    const result = transpile(`class Item {}
class Reader<T> {
  constructor(private items: T[]) {}
  read(): T | undefined { return items[0] }
}
interface Options { item?: Item; count?: number }
class Failure extends Error {
  item: Item | undefined
  constructor(item?: Item) {
    super("failure")
    this.item = item
  }
}
fun choose(item: Item, selected: boolean): Item | undefined {
  return selected ? item : undefined
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("T read(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("virtual Item* __vexa_property_get_item");
    expect(result.code).toContain("return vexa::defaultValue<Item*>();");
    expect(result.code).toContain("virtual vexa::Value __vexa_property_get_count");
    expect(result.code).toContain("cppgc::Member<Item> item;");
    expect(result.code).toContain("vexa::convertValue<Item*>(__vexa_runtime, vexa::Value::undefined())");
  });

  it("uses interface accessors for pointer-valued inferred locals", () => {
    const result = transpile(`interface Token { type: string; value: string }
class Reader {
  peek(): Token { return { type: "identifier", value: "name" } }
  read(): string {
    val token = this.peek()
    return token.type + token.value
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("token->__vexa_property_get_type(__vexa_runtime)");
    expect(result.code).toContain("token->__vexa_property_get_value(__vexa_runtime)");
  });

  it("lowers Object.defineProperty for declared interface metadata", () => {
    const result = transpile(`interface Program {
  metadata?: unknown
}
function attach(program: Program, values: number[]) {
  Object.defineProperty(program, "metadata", {
    value: [...values],
    enumerable: false
  })
}`, {
      sourceFilePath: "main.ts",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::defineProperty(__vexa_runtime");
    expect(result.code).toContain("vexa::convertValue<vexa::Value>(__vexa_runtime");
    expect(result.code).not.toContain("Object.defineProperty");
  });

  it("roots top-level managed values that are referenced by functions", () => {
    const result = transpile(`val keywords = ["let", "val"]
val metadata = { precedence: 1 }
fun accepts(value: string): boolean => keywords.includes(value)
fun precedence(): any => metadata.precedence`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("keywords = nullptr;");
    expect(result.code).toContain("keywords__vexa_root");
    expect(result.code).toContain("metadata = nullptr;");
    expect(result.code).toContain("keywords = runtime.array");
    expect(result.code).not.toContain("auto keywords =");
  });

  it("emits typed arrays with indexed access, length, and push", () => {
    const result = transpile(`val values = [1, 2, 3]
values.push(4)
values[0] = values.length
console.log(values[0], values.length)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto values = runtime.array<std::int32_t>({1, 2, 3});");
    expect(result.code).toContain("vexa::push(vexa::arrayPointer(values), 4);");
    expect(result.code).toContain("vexa::arraySet(vexa::arrayPointer(values), 0, static_cast<double>(vexa::arrayPointer(values)->size()));");
    expect(result.code).toContain("vexa::arrayGet(vexa::arrayPointer(values), 0)");
  });

  it("keeps arrays shared between managed object fields and traces their backing storage", async () => {
    const result = transpile(`class Holder(var values: int[])

val shared = [1, 2]
val first = Holder(shared)
val second = Holder(shared)
first.values.push(3)
second.values[0] = 9
console.log(first.values[0], second.values.join(","))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto shared = runtime.array<std::int32_t>({1, 2});");
    expect(result.code).toContain("cppgc::Member<vexa::ArrayObject<std::int32_t>> values;");
    expect(result.code).toContain("visitor->Trace(values);");
    expect(result.code).toContain("runtime.make<Holder>(shared)");
    expect(result.code).toContain("vexa::push(vexa::arrayPointer(first->values), 3)");
    expect(result.code).toContain("vexa::arraySet(vexa::arrayPointer(second->values), 0, 9)");
    expect(result.code).toContain("vexa::arrayGet(vexa::arrayPointer(first->values), 0)");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("class ArrayObject final : public cppgc::GarbageCollected<ArrayObject<T>>");
    expect(runtime).toContain("class ArraySlot<T*> final");
    expect(runtime).toContain("cppgc::Member<T> value_");
    expect(runtime).toContain("visitor->Trace(value_)");
  });

  it("formats managed arrays through their bracketed string conversion", async () => {
    const result = transpile(`val values = [1, 2, 3, 4].map { it * 3 }.filter { it % 2 == 0 }
console.log("values", values)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::console.log(runtime.string(\"values\"), values)");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("std::string toString() const;");
    expect(runtime).toContain("inline std::string toString(ArrayObject<T>* array)");
    expect(runtime).toContain("return array ? array->toString() : \"null\"");
    expect(runtime).toContain("return array->map(runtime, std::move(callback))");
    expect(runtime).toContain("return array->filter(runtime, std::move(callback))");
    expect(runtime).toContain("static void print(std::ostream& output, ArrayObject<T>* values)");
    expect(runtime).toContain("output << toString(values)");
  });

  it("emits mixed primitive arrays through dynamic managed values", () => {
    const result = transpile(`val mixed = [1, "two", true]
console.log(mixed[0], mixed[1], mixed[2])
mixed.push("three")
console.log(mixed.includes("two"), mixed.indexOf(true), mixed.join("|"))
for (value of mixed) console.log(value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.array<vexa::Value>");
    expect(result.code).toContain("vexa::convertValue<vexa::Value>(runtime, 1)");
    expect(result.code).toContain('vexa::convertValue<vexa::Value>(runtime, runtime.string("two"))');
    expect(result.code).toContain("vexa::push(vexa::arrayPointer(mixed), vexa::convertValue<vexa::Value>");
    expect(result.code).toContain("for (auto value : *vexa::arrayPointer(mixed))");
  });

  it("falls back to dynamic storage for context-free TypeScript arrays", () => {
    const result = transpile(`const values = []
values.push(1, "two")
console.log(values)`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("runtime.array<vexa::Value>({})");
  });

  it("emits array spreads, sparse holes, Vexa for-in iteration, and debugger", () => {
    const result = transpile(`val values = [1, 2, 3]
val merged = [0, ...values, 4]
val sparse = [1, , 3]
debugger
for (value in merged) console.log(value)
console.log(sparse[1])`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::appendAll(__vexa_array, vexa::arrayPointer(values))");
    expect(result.code).toContain("vexa::Value::undefined()");
    expect(result.code).toContain("for (auto value : *vexa::arrayPointer(merged))");
    expect(result.code).toContain("/* debugger */");
  });

  it("preserves Array.push spread order through one evaluated managed receiver", () => {
    const result = transpile(`val target = [1]
val source = [2, 3]
target.push(0, ...source, 4)
console.log(target)`, {
      sourceFilePath: "main.vx",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("return vexa::pushAll(__vexa_receiver, __vexa_values)");
    expect(result.code).toContain("vexa::appendAll(__vexa_array, vexa::arrayPointer(source))");
  });

  it("emits simple array and object destructuring declarations", () => {
    const result = transpile(`val [first, , ...rest] = [1, 2, 3, 4]
val { name, count :: amount } = { name: "box", count: 3 }
console.log(first, rest.join("-"), name, amount)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto __vexa_destructure_");
    expect(result.code).toContain("auto first = vexa::arrayGet(vexa::arrayPointer(__vexa_destructure_");
    expect(result.code).toContain("auto rest = vexa::slice(runtime, vexa::arrayPointer(__vexa_destructure_");
    expect(result.code).toContain('vexa::recordGet<vexa::Value>(runtime, __vexa_destructure_');
    expect(result.code).toContain('vexa::recordGet<vexa::Value>(runtime, __vexa_destructure_');
  });

  it("emits lazy destructuring defaults, object rest, and nested array rest", () => {
    const result = transpile(`val [first = 7, ...[second]] = [undefined, 8]
val { id = 3, ...rest } = { extra: 9 }
console.log(first, second, id, rest.extra)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::destructureDefault(runtime");
    expect(result.code).toContain("vexa::recordRest(runtime");
    expect(result.code).toContain("vexa::slice(runtime");
  });

  it("emits for-of loops over arrays", () => {
    const result = transpile(`val names = [" Ada ".trim(), "Grace"]
names.push("Katherine")
for (name of names) {
  console.log(name.toUpperCase())
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto names = runtime.array<std::string>({vexa::toString(vexa::trim(");
    expect(result.code).toContain('vexa::push(vexa::arrayPointer(names), runtime.string("Katherine"));');
    expect(result.code).toContain("for (auto name : *vexa::arrayPointer(names))");
    expect(result.code).toContain("vexa::console.log(vexa::toUpperCase(name));");
  });

  it("emits integral switch statements with fallthrough and default cases", () => {
    const result = transpile(`fun label(value: int): string {
  switch (value) {
    case 1:
      return "one"
    case 2:
    case 3:
      return "few"
    default:
      return "many"
  }
}

console.log(label(2))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("switch (value) {");
    expect(result.code).toContain("case 1:");
    expect(result.code).toContain("case 3:");
    expect(result.code).toContain("default:");
  });

  it("lowers string switch statements through a single evaluated case index", () => {
    const result = transpile(`fun category(value: string): int {
  switch (value) {
    case "start":
      return 1
    case "stop":
      return 2
    default:
      return 0
  }
}

console.log(category("stop"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto __vexa_switch_value_0 = value;");
    expect(result.code).toContain("std::int32_t __vexa_switch_case_0 = 2;");
    expect(result.code).toContain('if (__vexa_switch_value_0 == __vexa_runtime.string("start"))');
    expect(result.code).toContain("switch (__vexa_switch_case_0)");
  });

  it("rejects non-array for-of loops before producing invalid C++", () => {
    const result = transpile(`for (character of "abc") {
  console.log(character)
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual(["C++ for-of emission does not support iterable 'StringLiteral' with type 'vexa::Value'"]);
    expect(result.code).toBe("");
  });

  it("maps array queries, joining, and reversing to the native runtime", () => {
    const result = transpile(`val values = [3, 1, 4]
console.log(values.includes(1), values.indexOf(4), values.indexOf(9), values.join("-"))
values.reverse()
console.log(values.join())

val names = ["Ada", "Grace"]
console.log(names.includes("Grace"), names.indexOf("Ada"), names.join(" + "))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::includes(vexa::arrayPointer(values), 1)");
    expect(result.code).toContain("vexa::indexOf(vexa::arrayPointer(values), 4)");
    expect(result.code).toContain('vexa::join(vexa::arrayPointer(values), runtime.string("-"))');
    expect(result.code).toContain("vexa::reverse(vexa::arrayPointer(values));");
    expect(result.code).toContain("vexa::join(vexa::arrayPointer(values))");
    expect(result.code).toContain('vexa::includes(vexa::arrayPointer(names), runtime.string("Grace"))');
    expect(result.code).toContain('vexa::indexOf(vexa::arrayPointer(names), runtime.string("Ada"))');
  });

  it("maps broader array, string, and Object collection APIs", () => {
    const result = transpile(`val values = [1, 2, 3]
val doubled = values.map((value: int) => value * 2)
val selected = doubled.filter((value: int) => value > 2)
val total = selected.reduce((sum: int, value: int) => sum + value, 0)
values.unshift(0)
val last = values.pop()
val words = "a,b,c".split(",")
console.log(total, last, words.slice(1).join("-"), "hello".startsWith("he"), Object.keys({ a: 1, b: 2 }).length)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::map(runtime, vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::filter(runtime, vexa::arrayPointer(doubled)");
    expect(result.code).toContain("vexa::reduce(vexa::arrayPointer(selected)");
    expect(result.code).toContain("vexa::unshift(vexa::arrayPointer(values), 0)");
    expect(result.code).toContain("vexa::pop(vexa::arrayPointer(values))");
    expect(result.code).toContain("vexa::split(runtime, runtime.string(\"a,b,c\")");
    expect(result.code).toContain("vexa::startsWith(runtime.string(\"hello\")");
    expect(result.code).toContain("vexa::recordKeys(runtime, runtime.record(");
  });

  it("concatenates scalar and array arguments through the managed Array API", async () => {
    const result = transpile(`val values = [1, 2]
val combined = values.concat(3, [4, 5], 6)
val mixed = [1, "two"].concat([true], "three")
console.log(combined.join("|"), mixed.join("|"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      "vexa::concat(runtime, vexa::arrayPointer(values), 3, vexa::arrayPointer(runtime.array<std::int32_t>({4, 5})), 6)"
    );
    expect(result.code).toContain(
      "vexa::concat(runtime, vexa::arrayPointer(runtime.array<vexa::Value>"
    );
    expect(result.code).toContain("vexa::arrayPointer(runtime.array<vexa::Value>({vexa::convertValue<vexa::Value>(runtime, true)}))");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("ArrayObject* concat(Runtime& runtime, Items&&... items) const");
    expect(runtime).toContain("(appendConcatItem(result, std::forward<Items>(items)), ...)");
  });

  it("maps Array iteration, predicates, lookup, and sorting to the managed API", async () => {
    const result = transpile(`val values = [3, 1, 4, 2]
var visited: number = 0
values.forEach((value: int) => { visited += value })
val hasEven = values.some((value: int) => value % 2 == 0)
val allPositive = values.every((value: int) => value > 0)
val firstLarge = values.findIndex((value: int) => value > 3)
values.sort((left: int, right: int) => left - right)
val lexical = [10, 2, 1]
lexical.sort()
console.log(visited, hasEven, allPositive, firstLarge, values.join("|"), lexical.join("|"))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::forEach(vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::some(vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::every(vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::findIndex(vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::sort(vexa::arrayPointer(values)");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("void forEach(Callback callback) const");
    expect(runtime).toContain("bool some(Callback callback) const");
    expect(runtime).toContain("bool every(Callback callback) const");
    expect(runtime).toContain("double findIndex(Callback callback) const");
    expect(runtime).toContain("ArrayObject* sort()");
    expect(runtime).toContain("ArrayObject* sort(Callback callback)");
  });

  it("passes JavaScript callback indices and array receivers through one native helper", async () => {
    const result = transpile(`val values = [3, 1, 4, 2]
val mapped = values.map((value: int, index: number, array: int[]) => value + index + array.length)
val filtered = values.filter((value: int, index: number, array: int[]) => index % 2 == 0 && array.length == 4)
var visited: number = 0
values.forEach((value: int, index: number, array: int[]) => { visited += value + index + array.length })
val hasIndexed = values.some((value: int, index: number, array: int[]) => value == 1 && index == 1 && array.length == 4)
val allIndexed = values.every((value: int, index: number, array: int[]) => index < array.length && value > 0)
val found = values.findIndex((value: int, index: number, array: int[]) => value == array[index] && index == 2)
val total = values.reduce((sum: number, value: int, index: number, array: int[]) => sum + value + index + array.length, 0.0)
console.log(mapped.join("|"), filtered.join("|"), visited, hasIndexed, allIndexed, found, total)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t value, double index, vexa::ArrayObject<std::int32_t>* array");
    expect(result.code).toContain("vexa::remainder(index, 2)");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("invokeArrayCallback(callback, value, index, this)");
    expect(runtime).toContain("invokeArrayReduceCallback(callback, std::move(initial), value, index, this)");
  });

  it("infers native generic-lambda parameters for implicit it callbacks", () => {
    const result = transpile(`val values = [1, 2, 3, 4]
val selected = values.map { it * 3 }.filter { it % 2 == 0 }
console.log(selected)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("(auto it)");
    expect(result.code).toContain("vexa::map(runtime, vexa::arrayPointer(values)");
    expect(result.code).toContain("vexa::filter(runtime,");
  });

  it("emits typed custom functions and injects the runtime into calls", () => {
    const result = transpile(`fun twice(value: int): int {
  return multiply(factor: 2, value: value)
}

fun multiply(value: int, factor: int): int {
  return value * factor
}

fun label(): string {
  return "ready"
}

console.log(twice(4))
console.log(label())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t twice(vexa::Runtime& __vexa_runtime, std::int32_t value);");
    expect(result.code).toContain("std::int32_t multiply(vexa::Runtime& __vexa_runtime, std::int32_t value, std::int32_t factor);");
    expect(result.code).toContain("vexa::Value label(vexa::Runtime& __vexa_runtime);");
    expect(result.code).toContain("std::int32_t twice(vexa::Runtime& __vexa_runtime, std::int32_t value) {");
    expect(result.code).toContain("return multiply(__vexa_runtime, value, 2);");
    expect(result.code).toContain('return __vexa_runtime.string("ready");');
    expect(result.code).toContain("vexa::console.log(twice(runtime, 4));");
    expect(result.code).toContain("vexa::console.log(label(runtime));");
  });

  it("emits class methods and routes instance and implicit method calls", () => {
    const result = transpile(`fun addTo(counter: Counter, delta: int): int {
  return counter.add(delta)
}

fun twice(value: int): int {
  return value * 2
}

class Counter(var value: int) {
  fun add(delta: int): int {
    value += twice(delta)
    return value
  }

  fun addAgain(delta: int): int {
    return add(delta)
  }
}

val counter = Counter(1)
console.log(addTo(counter, 3))
console.log(counter.addAgain(1))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t addTo(vexa::Runtime& __vexa_runtime, Counter* counter, std::int32_t delta);");
    expect(result.code).toContain("return counter->add(__vexa_runtime, delta);");
    expect(result.code).toContain("std::int32_t add(vexa::Runtime& __vexa_runtime, std::int32_t delta)");
    expect(result.code).toContain("(this->value += twice(__vexa_runtime, delta));");
    expect(result.code).toContain("return this->value;");
    expect(result.code).toContain("return this->add(__vexa_runtime, delta);");
    expect(result.code).toContain("vexa::console.log(addTo(runtime, counter, 3));");
    expect(result.code).toContain("vexa::console.log(counter->addAgain(runtime, 1));");
  });

  it("lowers function defaults, recursion, and inferred void returns", () => {
    const result = transpile(`fun defaultDelta(): int => 1

fun add(value: int, delta: int = defaultDelta()): int {
  return value + delta
}

fun sumDown(value: int): int {
  if (value <= 0) return 0
  return value + sumDown(value - 1)
}

fun announce(message: string) {
  console.log(message)
}

console.log(add(4))
console.log(add(delta: 3, value: 4))
console.log(sumDown(3))
announce("ready")`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t add(vexa::Runtime& __vexa_runtime, std::int32_t value, std::int32_t delta)");
    expect(result.code).toContain("void announce(vexa::Runtime& __vexa_runtime, vexa::Value message)");
    expect(result.code).toContain("return (value + sumDown(__vexa_runtime, (value - 1)));");
    expect(result.code).toContain("vexa::console.log(add(runtime, 4, defaultDelta(runtime)));");
    expect(result.code).toContain("vexa::console.log(add(runtime, 4, 3));");
    expect(result.code).toContain("announce(runtime, runtime.string(\"ready\"));");
  });

  it("shares inferred TypeScript parameter representations between signatures and calls", () => {
    const result = transpile(`function prefix(value = "x"): string { return value }
function identity(value) { return value }
console.log(prefix(), identity(3))`, {
      sourceFilePath: "main.ts",
      emit: "cpp",
      emitSourceMap: false,
      typeCheck: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Value prefix(vexa::Runtime& __vexa_runtime, vexa::Value value)");
    expect(result.code).toContain("vexa::Value identity(vexa::Runtime& __vexa_runtime, vexa::Value value)");
    expect(result.code).toContain("identity(runtime, vexa::convertValue<vexa::Value>(runtime, 3))");
  });

  it("passes undefined and null pointers for omitted optional parameters", () => {
    const result = transpile(`fun count(values?: int[]): int => values ? values.length : 0
fun passthrough(value?: number): any => value
console.log(count(), count([1, 2]), passthrough())`, {
      sourceFilePath: "main.vx",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t count(vexa::Runtime& __vexa_runtime, vexa::ArrayObject<std::int32_t>* values)");
    expect(result.code).toContain("vexa::Value passthrough(vexa::Runtime& __vexa_runtime, vexa::Value value)");
    expect(result.code).toContain("count(runtime, nullptr)");
    expect(result.code).toContain("passthrough(runtime, vexa::Value::undefined())");
  });

  it("packs rest arguments and spread calls into one managed array", () => {
    const result = transpile(`fun combine(...values: string[]): string => values.join(",")
val initial = ["a", "b"]
console.log(combine("x", "y"), combine(), combine(...initial))`, {
      sourceFilePath: "main.vx",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Value combine(vexa::Runtime& __vexa_runtime, vexa::ArrayObject<std::string>* values)");
    expect(result.code).toContain('combine(runtime, runtime.array<std::string>({vexa::toString(runtime.string("x")), vexa::toString(runtime.string("y"))}))');
    expect(result.code).toContain("combine(runtime, runtime.array<std::string>({}))");
    expect(result.code).toContain("vexa::appendAll(__vexa_array, vexa::arrayPointer(initial))");
  });

  it("emits constructor and method defaults with static class factories", () => {
    const result = transpile(`fun initialValue(): int => 1

class Counter(var value: int = initialValue()) {
  static fun create(value: int = 2): Counter {
    return Counter(value)
  }

  static fun defaultCounter(): Counter {
    return create()
  }

  fun add(delta: int = 1): int {
    value += delta
    return value
  }

  fun copy(): Counter {
    return Counter(value)
  }
}

val direct = Counter()
val created = Counter.create()
val defaulted = Counter.defaultCounter()
val copied = created.copy()
console.log(direct.value, created.add(), defaulted.value, copied.value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("static Counter* create(vexa::Runtime& __vexa_runtime, std::int32_t value)");
    expect(result.code).toContain("return Counter::create(__vexa_runtime, 2);");
    expect(result.code).toContain("Counter* copy(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("auto direct = runtime.make<Counter>(initialValue(runtime));");
    expect(result.code).toContain("auto created = Counter::create(runtime, 2);");
    expect(result.code).toContain("auto defaulted = Counter::defaultCounter(runtime);");
    expect(result.code).toContain("auto copied = created->copy(runtime);");
    expect(result.code).toContain("created->add(runtime, 1)");
    expect(result.code).toContain("copied->value");
  });

  it("emits timers through the runtime event loop", () => {
    const result = transpile(`var ticks = 0
var interval = 0

setTimeout(() => console.log("timeout"), 0)
interval = setInterval(() => {
  ticks++
  console.log("tick", ticks)
  if (ticks == 2) clearInterval(interval)
}, 0)

val cancelled = setTimeout(() => console.log("cancelled"), 0)
clearTimeout(cancelled)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('__vexa_timer_callback = [&]() { return vexa::console.log(runtime.string("timeout")); }');
    expect(result.code).toContain("runtime.setInterval([&runtime, __vexa_timer_callback = [&]() {");
    expect(result.code).toContain("runtime.clearInterval(interval);");
    expect(result.code).toContain("runtime.clearTimeout(cancelled);");
    expect(result.code).toContain("runtime.runEventLoop();");
  });

  it("emits throw, catch bindings, and exact finally completion propagation", () => {
    const result = transpile(`fun parse(ok: boolean): int {
  try {
    if (!ok) throw Error("bad")
    return 4
  } catch (error) {
    console.log(error)
    return -1
  } finally {
    console.log("done")
  }
}

console.log(parse(false))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::exception_ptr __vexa_pending_completion_0;");
    expect(result.code).toContain("throw vexa::ReturnSignal<std::int32_t>(4);");
    expect(result.code).toContain("std::rethrow_exception(__vexa_pending_completion_0);");
    expect(result.code).toContain('vexa::throwValue(vexa::Error(__vexa_runtime.string("bad")));');
    expect(result.code).toContain("catch (const std::exception& __vexa_caught_error_0)");
    expect(result.code).toContain("auto error = __vexa_runtime.string(__vexa_caught_error_0.what());");
  });

  it("emits defer through the shared try-finally lowering", () => {
    const result = transpile(`fun work(): int {
  defer console.log("deferred")
  console.log("working")
  return 3
}

console.log(work())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::exception_ptr __vexa_pending_completion_0;");
    expect(result.code).toContain('vexa::console.log(__vexa_runtime.string("deferred"));');
    expect(result.code).toContain("throw vexa::ReturnSignal<std::int32_t>(3);");
  });

  it("lets abrupt finally completions override pending returns", () => {
    const result = transpile(`fun choose(): int {
  try {
    return 1
  } finally {
    return 2
  }
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("throw vexa::ReturnSignal<std::int32_t>(1);");
    expect(result.code).toContain("return 2;");
  });

  it("propagates break and continue through finally to the nearest loop", () => {
    const result = transpile(`fun count(): int {
  var total = 0
  for (value of [1, 2, 3]) {
    try {
      if (value == 1) continue
      if (value == 3) break
      total += value
    } finally {
      total += 10
    }
  }
  return total
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("throw vexa::ContinueSignal();");
    expect(result.code).toContain("throw vexa::BreakSignal();");
    expect(result.code).toContain("catch (const vexa::ContinueSignal&) { continue; }");
    expect(result.code).toContain("catch (const vexa::BreakSignal&) { break; }");
  });

  it("routes labeled break and continue through nested loops", () => {
    const result = transpile(`fun count(): int {
  var total = 0
  outer: for (i of 0 ..< 3) {
    for (j of 0 ..< 3) {
      if (j == 1) continue outer
      if (i == 2) break outer
      total += 1
    }
  }
  return total
}
console.log(count())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('throw vexa::LabeledContinueSignal("outer")');
    expect(result.code).toContain('throw vexa::LabeledBreakSignal("outer")');
    expect(result.code).toContain('__vexa_signal.label() == "outer"');
  });

  it("emits native tasks for async and sync functions with explicit and implicit awaits", () => {
    const result = transpile(`async fun fetchValue(): Promise<int> {
  return 20
}

sync fun doubled(): int {
  return fetchValue() * 2
}

async fun delegated(): Promise<int> {
  return fetchValue()
}

async fun announce(): Promise<void> {
  console.log("async")
}

sync fun launch(): void {
  go announce()
}

console.log(await fetchValue(), await doubled(), await delegated())
await announce()
launch()`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<std::int32_t> fetchValue(vexa::Runtime& __vexa_runtime);");
    expect(result.code).toContain("vexa::Task<std::int32_t> doubled(vexa::Runtime& __vexa_runtime);");
    expect(result.code).not.toContain("::schedule(");
    expect(result.code).toContain("co_return 20;");
    expect(result.code).toContain("co_return ((co_await fetchValue(__vexa_runtime)) * 2);");
    expect(result.code).toContain("co_return (co_await fetchValue(__vexa_runtime));");
    expect(result.code).toContain("co_return;");
    expect(result.code).toContain("announce(__vexa_runtime);");
    expect(result.code).not.toContain("announce(__vexa_runtime).get();");
    expect(result.code).toContain("vexa::console.log((fetchValue(runtime)).get(), (doubled(runtime)).get(), (delegated(runtime)).get());");
    expect(result.code).toContain("(announce(runtime)).get();");
  });

  it("emits async and sync class methods through the same task convention", () => {
    const result = transpile(`class Counter(var value: int) {
  async fun read(): Promise<int> {
    return value
  }

  sync fun twice(): int {
    return read() * 2
  }
}

val counter = Counter(3)
console.log(await counter.twice())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<std::int32_t> read(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("vexa::Task<std::int32_t> twice(vexa::Runtime& __vexa_runtime)");
    expect(result.code).toContain("co_await this->read(__vexa_runtime)");
    expect(result.code).toContain("(counter->twice(runtime)).get()");
  });

  it("emits async and sync anonymous callables as native task coroutines", () => {
    const result = transpile(`val asyncAdd = async (value: int) => value + 2
val syncDouble = sync (value: int) => asyncAdd(value) * 2
console.log(await asyncAdd(3), await syncDouble(4))`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("mutable -> vexa::Task<std::int32_t>");
    expect(result.code).toContain("co_return vexa::convertValue<std::int32_t>(runtime, (value + 2))");
    expect(result.code).toContain("co_await asyncAdd(value)");
    expect(result.code).toContain("(asyncAdd(3)).get()");
    expect(result.code).toContain("(syncDouble(4)).get()");
  });

  it("emits Promise executors with resolve and reject on the shared event loop", () => {
    const result = transpile(`fun delay(ms: number) => Promise { resolve, reject ->
  setTimeout(resolve, ms)
}

fun resolvedValue() => Promise { resolve, reject ->
  resolve(5)
}

fun rejectedValue() => Promise { resolve, reject ->
  reject(Error("no"))
}

console.log("before")
await delay(0)
console.log(await resolvedValue())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<vexa::Value> delay(vexa::Runtime& __vexa_runtime, double ms);");
    expect(result.code).toContain("return vexa::Task<vexa::Value>::create(__vexa_runtime,");
    expect(result.code).toContain("catch (const vexa::ReturnSignal<vexa::Task<vexa::Value>>& __vexa_return)");
    expect(result.code).not.toContain("catch (const vexa::ReturnSignal<vexa::Value>& __vexa_return)");
    expect(result.code).toContain("(auto resolve, auto reject) mutable");
    expect(result.code).toContain("__vexa_timer_callback = resolve");
    expect(result.code).toContain("__vexa_timer_callback();");
    expect(result.code).toContain("resolve(5);");
    expect(result.code).toContain('reject(vexa::Error(__vexa_runtime.string("no")));');
    expect(result.code).toContain("(delay(runtime, 0)).get();");
    expect(result.code).toContain("vexa::console.log((resolvedValue(runtime)).get());");
  });

  it("passes timer arguments to named and async anonymous callbacks", () => {
    const result = transpile(`fun announce(label: string, value: int) {
  console.log(label, value)
}
setTimeout(announce, 0, "named", 3)
setTimeout(async (value: int) => {
  val resolved = await Promise.resolve(value + 1)
  console.log("async", resolved)
}, 0, 4)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_timer_argument_0 = runtime.string(\"named\")");
    expect(result.code).toContain("announce(runtime, __vexa_timer_argument_0, __vexa_timer_argument_1)");
    expect(result.code).toContain("__vexa_timer_callback(__vexa_timer_argument_0)");
    expect(result.code).toContain("mutable -> vexa::Task<void>");
  });

  it("emits Promise resolution and continuation methods through native task helpers", () => {
    const result = transpile(`async fun pipeline(): Promise<int> {
  val value = await Promise.resolve(2).then((item: int) => item + 3)
  return value
}

val observed = Promise.resolve(4)
  .then((item: int) => item * 2)
  .finally(() => console.log("settled"))
console.log(await pipeline(), await observed)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::promiseResolve(__vexa_runtime, 2)");
    expect(result.code).toContain("vexa::promiseThen(__vexa_runtime");
    expect(result.code).toContain("vexa::promiseFinally(runtime");
    expect(result.code).toContain("co_await vexa::promiseThen(");
  });

  it("emits Promise rejection recovery and Promise.all", () => {
    const result = transpile(`val recovered = Promise.reject(Error("bad"))
  .catch((reason: any) => 9)
val values = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
console.log(await recovered, values[0], values[1])`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::rejectedTask<vexa::Value>(runtime");
    expect(result.code).toContain("vexa::promiseCatch(runtime");
    expect(result.code).toContain("vexa::promiseAll(runtime");
    expect(result.code).toContain("runtime.array<vexa::Task<std::int32_t>>");
  });

  it("emits Promise race, allSettled, and any combinators", () => {
    const result = transpile(`val raced = await Promise.race([Promise.resolve(1), Promise.resolve(2)])
val settled = await Promise.allSettled([Promise.resolve(3), Promise.reject(Error("bad"))])
val first = await Promise.any([Promise.reject(Error("no")), Promise.resolve(4)])
console.log(raced, settled.length, first)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::promiseRace(runtime");
    expect(result.code).toContain("vexa::promiseAllSettled(runtime");
    expect(result.code).toContain("vexa::promiseAny(runtime");
  });

  it("emits lazy generator functions with yield, yield delegation, next, and for-of", () => {
    const result = transpile(`fun * values(limit: int): int {
  for (n of 0 ..< limit) yield n
  yield* [limit, limit + 1]
  return limit + 10
}

val iterator = values(2)
val first = iterator.next()
console.log(first.done, first.value)
for (value of iterator) console.log(value)
val finished = iterator.next()
console.log(finished.done, finished.value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Generator<std::int32_t> values(vexa::Runtime& __vexa_runtime, std::int32_t limit);");
    expect(result.code).toContain("co_yield n;");
    expect(result.code).toContain("for (auto&& __vexa_yield_value_0 : *vexa::arrayPointer(__vexa_runtime.array<std::int32_t>({limit, (limit + 1)})))");
    expect(result.code).toContain("co_yield vexa::convertValue<std::int32_t>(__vexa_runtime, __vexa_yield_value_0);");
    expect(result.code).toContain("co_return (limit + 10);");
    expect(result.code).toContain("auto first = iterator.next();");
    expect(result.code).toContain("for (auto value : iterator)");
    expect(result.code).toContain("auto finished = iterator.next();");
  });

  it("roots generator locals and converts delegated strings to managed values", () => {
    const result = transpile(`class Box(var value: int)

fun * boxes(): Box {
  val box = Box(1)
  yield box
  box.value = 2
  yield box
}

fun * names(): string {
  yield* ["Ada", "Grace"]
}

for (box of boxes()) console.log(box.value)
for (name of names()) console.log(name)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Generator<Box*> boxes(vexa::Runtime& __vexa_runtime);");
    expect(result.code).toContain("cppgc::Persistent<Box> box(__vexa_runtime.make<Box>(1));");
    expect(result.code).toContain("co_yield box;");
    expect(result.code).toContain("vexa::Generator<vexa::Value> names(vexa::Runtime& __vexa_runtime);");
    expect(result.code).toContain("co_yield vexa::convertValue<vexa::Value>(__vexa_runtime, __vexa_yield_value_0);");
  });

  it("roots generator method receivers across suspension", () => {
    const result = transpile(`class Counter(val start: int) {
  fun * values(delta: int): int {
    yield start
    yield start + delta
  }
}

for (value of Counter(3).values(2)) console.log(value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Generator<std::int32_t> values(vexa::Runtime& __vexa_runtime, std::int32_t delta)");
    expect(result.code).toContain("cppgc::Persistent<Counter> __vexa_generator_self(this);");
    expect(result.code).toContain("co_yield __vexa_generator_self->start;");
    expect(result.code).toContain("(co_yield __vexa_generator_self->start + delta);");
  });

  it("emits async generators over the same coroutine and task runtime", () => {
    const result = transpile(`async fun later(): int {
  return 4
}

sync fun * values(): int {
  yield await later()
  yield 5
}

sync fun consume(): void {
  val iterator = values()
  val first = await iterator.next()
  console.log(first.value)
  for (value of iterator) console.log(value)
}

await consume()`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::AsyncGenerator<std::int32_t> values(vexa::Runtime& __vexa_runtime);");
    expect(result.code).toContain("co_yield (later(__vexa_runtime)).get();");
    expect(result.code).toContain("auto first = (co_await iterator.next());");
    expect(result.code).toContain("for (auto value : iterator)");
  });

  it("passes next values back into suspended yield expressions", async () => {
    const result = transpile(`fun * echo(): int {
  val received = yield 1
  yield received
}

val iterator = echo()
console.log(iterator.next(99).value)
console.log(iterator.next(7).value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto received = co_yield 1;");
    expect(result.code).toContain("iterator.next(99).value");
    expect(result.code).toContain("iterator.next(7).value");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("T await_resume()");
    expect(runtime).toContain("NextResult next(T value)");
  });

  it("closes generators through return", async () => {
    const result = transpile(`fun * values(): int {
  yield 1
  yield 2
}

val iterator = values()
console.log(iterator.next().value)
val closed = iterator.return()
console.log(closed.done, closed.value)`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto closed = iterator.finish();");

    const runtime = await readFile(join(process.cwd(), "native", "runtime.cpp"), "utf8");
    expect(runtime).toContain("NextResult finish()");
  });
});
