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
      sourceFilePath: "/tmp/performance.ts",
      typeCheck: false
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::performanceNow()");
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
