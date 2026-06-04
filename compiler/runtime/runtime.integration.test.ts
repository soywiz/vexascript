import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { transpile, type TranspileTarget } from "./transpile";

function executeTranspiled(source: string, target: TranspileTarget = "optimized"): unknown[][] {
  const result = transpile(source, { target });
  expect(result.errors).toEqual([]);

  const logs: unknown[][] = [];
  const context = createContext({
    console: {
      log: (...args: unknown[]) => {
        logs.push(args);
      }
    },
    BigInt
  });

  new Script(result.code).runInContext(context);
  return logs;
}

describe("runtime integration", () => {
  it("executes lowered range loops, class constructor fields, and bigint/long arithmetic", () => {
    const source = `class Pair(val x: int, val y: int)
let total = 0
for (n of 0 ... 3) {
  total = total + n
}
let pair = new Pair(2, 5)
let a: long = 10L
let b: long = 20L
let c = a + b
console.log(pair.x + pair.y + total)
console.log(c)
`;

    const logs = executeTranspiled(source, "optimized");

    expect(logs).toEqual([[10], [30n]]);
  });

  it("executes regular expression literals and sparse arrays", () => {
    const source = `let re = /a+/
let values = [1, , 3]
console.log(re.test("aa"))
console.log(1 in values)
console.log(values.length)
`;

    const logs = executeTranspiled(source, "optimized");

    expect(logs).toEqual([[true], [false], [3]]);
  });

  it("preserves behavior between conservative and optimized transpile targets", () => {
    const source = `let total = 0
for (n of 0 ... 5) {
  total = total + n
}
console.log(total)
`;

    const conservativeLogs = executeTranspiled(source, "conservative");
    const optimizedLogs = executeTranspiled(source, "optimized");

    expect(conservativeLogs).toEqual([[10]]);
    expect(optimizedLogs).toEqual([[10]]);
  });

  it("executes extension operator methods", () => {
    const source = `class Point(val x: int, val y: int) {}
fun Point.operator+(other: Point): Point {
  return new Point(this.x + other.x, this.y + other.y)
}
let result = new Point(1, 2) + new Point(3, 4)
console.log(result.x)
console.log(result.y)
`;

    const logs = executeTranspiled(source);

    expect(logs).toEqual([[4], [6]]);
  });
});
