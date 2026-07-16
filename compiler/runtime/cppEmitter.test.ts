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
});
