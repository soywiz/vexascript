import { Script, createContext } from "node:vm";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
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
  it("executes runtime namespace exports", () => {
    const output = executeTranspiled(`
namespace Tools {
  const prefix = "v"
  export const version = 1
  export function label(): string { return prefix + version }
}
console.log(Tools.version)
console.log(Tools.label())
`);

    expect(output).toEqual([[1], ["v1"]]);
  });

  it("executes TypeScript constructor parameter properties", () => {
    const output = executeTranspiled(`
class User {
  constructor(public readonly id: string, private age: int = 1) {}
  describe() { return this.id + ":" + this.age }
}
let user = new User("ada", 37)
console.log(user.describe())
`);

    expect(output).toEqual([["ada:37"]]);
  });

  it("executes lowered range loops, class constructor fields, and bigint/long arithmetic", () => {
    const source = `class Pair(val x: int, val y: int)
let total = 0
for (n of 0 ..< 3) {
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

  it("instantiates classes when they are called without new", () => {
    const source = `class Point(val x: int, val y: int)
let point = Point(2, 5)
console.log(point.x + point.y)
`;

    const logs = executeTranspiled(source);

    expect(logs).toEqual([[7]]);
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
for (n of 0 ..< 5) {
  total = total + n
}
console.log(total)
`;

    const conservativeLogs = executeTranspiled(source, "conservative");
    const optimizedLogs = executeTranspiled(source, "optimized");

    expect(conservativeLogs).toEqual([[10]]);
    expect(optimizedLogs).toEqual([[10]]);
  });

  it("executes unqualified class and extension member access", () => {
    const source = `class Counter(val value: int) {
  increment(amount: int): int { return value + amount }
}
fun Counter.doubled(): int { return value + value }
val Counter.next => increment(1)
let counter = new Counter(5)
console.log(counter.increment(2))
console.log(counter.doubled())
console.log(counter.next)
`;

    const logs = executeTranspiled(source);

    expect(logs).toEqual([[7], [10], [6]]);
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
  it("executes generic extension methods and properties on Array receivers", () => {
    const source = `fun <T> Array<T>.second(): T { return this[1] }
val <T> Array<T>.doubledLength => length * 2
let xs = [10, 20, 30]
console.log(xs.second())
console.log(xs.doubledLength)
console.log([].doubledLength)
`;

    const logs = executeTranspiled(source);

    expect(logs).toEqual([[20], [6], [0]]);
  });

  it("executes nested object and array destructuring declarations", () => {
    const source = `let { id, name :: displayName, nested :: { value = 4 }, ...rest } = { id: 1, name: "Ada", nested: {}, extra: 7 }
const [first, , third = 3, ...tail] = [10, 20]
console.log(id)
console.log(displayName)
console.log(value)
console.log(rest.extra)
console.log(first)
console.log(third)
console.log(tail.length)
`;

    expect(executeTranspiled(source)).toEqual([[1], ["Ada"], [4], [7], [10], [3], [0]]);
  });

  it("supports VexaScript enum indexing by name, raw value, and enum value", () => {
    const source = `enum Direction { Up, Down }
enum Label { Start = "start", End = "end" }
console.log(Direction["Up"])
console.log(Direction[0])
console.log(Direction[Direction.Up])
console.log(Label["Start"])
console.log(Label["start"])
console.log(Label[Label.Start])
`;

    expect(executeTranspiled(source)).toEqual([[0], [0], [0], ["start"], ["start"], ["start"]]);
  });

});

describe("destructured parameter runtime integration", () => {
  it("executes nested object and array parameter patterns with defaults, holes, and rest bindings", () => {
    const source = `function unpack({ id, nested :: { value = 4 }, ...metadata }, [first, , third = 3, ...tail] = [10, 20]) {
  console.log(id)
  console.log(value)
  console.log(metadata.extra)
  console.log(first)
  console.log(third)
  console.log(tail.length)
}
unpack({ id: 1, nested: {}, extra: 7 })
`;

    expect(executeTranspiled(source)).toEqual([[1], [4], [7], [10], [3], [0]]);
  });
});
