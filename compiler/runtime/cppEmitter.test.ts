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
    expect(result.code).toContain("for (double n = 0; n < 10; n++)");
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
});
