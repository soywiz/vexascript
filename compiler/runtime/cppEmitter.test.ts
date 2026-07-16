import { describe, expect, it } from "../test/expect";
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

  it("rejects non-array for-of loops before producing invalid C++", () => {
    const result = transpile(`for (character of "abc") {
  console.log(character)
}`, {
      sourceFilePath: "main.vx",
      outputFilePath: "main.cpp",
      emit: "cpp",
      emitSourceMap: false,
    });

    expect(result.errors).toEqual(["C++ for-of emission currently supports arrays only"]);
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
});
