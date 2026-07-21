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
});
