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
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('#include "runtime.cpp"');
    expect(result.code).toContain("vexa::Runtime runtime;");
    expect(result.code).toContain("for (std::int32_t n = 0; n < 10; n++)");
    expect(result.code).toContain("vexa::console.log(n);");
  });

  it("maps basic Math and primitive JavaScript APIs to the native runtime", () => {
    const result = transpile(`console.log(Math.floor(Math.PI), Number("2"), " ok ".trim().toUpperCase())`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Math::floor(vexa::Math::PI)");
    expect(result.code).toContain('vexa::Number(runtime.string("2"))');
    expect(result.code).toContain('vexa::toUpperCase(vexa::trim(runtime.string(" ok ")))');
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
    expect(result.code).toContain("vexa::includes(std::vector<std::int32_t>{7, 8, 9}, 8)");
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
    expect(result.code).toContain("void Trace(cppgc::Visitor* visitor) const { visitor->Trace(leaf); }");
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
    expect(result.code).toContain("auto values = std::vector<std::int32_t>{1, 2, 3};");
    expect(result.code).toContain("vexa::push(values, 4);");
    expect(result.code).toContain("(values[0] = static_cast<double>(values.size()));");
    expect(result.code).toContain("vexa::console.log(values[0], static_cast<double>(values.size()));");
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
    expect(result.code).toContain("std::vector<vexa::Value>");
    expect(result.code).toContain("vexa::convertValue<vexa::Value>(runtime, 1)");
    expect(result.code).toContain('vexa::convertValue<vexa::Value>(runtime, runtime.string("two"))');
    expect(result.code).toContain("vexa::push(mixed, vexa::convertValue<vexa::Value>");
    expect(result.code).toContain("for (auto value : mixed)");
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
    expect(result.code).toContain("auto names = std::vector<std::string>{vexa::toString(vexa::trim(");
    expect(result.code).toContain('vexa::push(names, runtime.string("Katherine"));');
    expect(result.code).toContain("for (auto name : names)");
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

    expect(result.errors).toEqual(["C++ for-of emission currently supports arrays and generators only"]);
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
    expect(result.code).toContain("vexa::includes(values, 1)");
    expect(result.code).toContain("vexa::indexOf(values, 4)");
    expect(result.code).toContain('vexa::join(values, runtime.string("-"))');
    expect(result.code).toContain("vexa::reverse(values);");
    expect(result.code).toContain("vexa::join(values)");
    expect(result.code).toContain('vexa::includes(names, runtime.string("Grace"))');
    expect(result.code).toContain('vexa::indexOf(names, runtime.string("Ada"))');
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
    const result = transpile(`fun add(value: int, delta: int = 1): int {
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
    expect(result.code).toContain("vexa::console.log(add(runtime, 4, 1));");
    expect(result.code).toContain("vexa::console.log(add(runtime, 4, 3));");
    expect(result.code).toContain("announce(runtime, runtime.string(\"ready\"));");
  });

  it("emits constructor and method defaults with static class factories", () => {
    const result = transpile(`class Counter(var value: int = 1) {
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
    expect(result.code).toContain("auto direct = runtime.make<Counter>(1);");
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
    expect(result.code).toContain('runtime.setTimeout([&]() { return vexa::console.log(runtime.string("timeout")); }, 0);');
    expect(result.code).toContain("runtime.setInterval([&]() {");
    expect(result.code).toContain("runtime.clearInterval(interval);");
    expect(result.code).toContain("runtime.clearTimeout(cancelled);");
    expect(result.code).toContain("runtime.runEventLoop();");
  });

  it("emits throw, catch bindings, and finally through native exceptions and RAII", () => {
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
    expect(result.code).toContain("auto __vexa_finally_0 = vexa::finally([&]()");
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
    expect(result.code).toContain("auto __vexa_finally_0 = vexa::finally([&]()");
    expect(result.code).toContain('vexa::console.log(__vexa_runtime.string("deferred"));');
    expect(result.code).toContain("return 3;");
  });

  it("rejects control flow that cannot safely escape a native finally guard", () => {
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

    expect(result.errors).toContain("C++ finally emission does not support return, break, continue, or throw");
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
    expect(result.code).toContain("return vexa::Task<std::int32_t>::schedule(");
    expect(result.code).toContain("[=, &__vexa_runtime]() mutable -> std::int32_t");
    expect(result.code).toContain("return 20;");
    expect(result.code).toContain("return (fetchValue(__vexa_runtime).get() * 2);");
    expect(result.code).toContain("return (fetchValue(__vexa_runtime)).get();");
    expect(result.code).toContain("return vexa::Task<void>::schedule(");
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
    expect(result.code).toContain("__vexa_self->read(__vexa_runtime).get()");
    expect(result.code).toContain("(counter->twice(runtime)).get()");
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
    expect(result.code).toContain("(auto resolve, auto reject) mutable");
    expect(result.code).toContain("__vexa_runtime.setTimeout(resolve, ms);");
    expect(result.code).toContain("resolve(5);");
    expect(result.code).toContain('reject(vexa::Error(__vexa_runtime.string("no")));');
    expect(result.code).toContain("(delay(runtime, 0)).get();");
    expect(result.code).toContain("vexa::console.log((resolvedValue(runtime)).get());");
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
    expect(result.code).toContain("for (auto&& __vexa_yield_value_0 : std::vector<std::int32_t>{limit, (limit + 1)})");
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
    expect(result.code).toContain("auto first = (iterator.next()).get();");
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
