import { Script, createContext, describe, expect, it } from "../test/expect";
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
  it("executes receiver lambdas, receiver-block shorthand, and labeled receivers", () => {
    const output = executeTranspiled(`
fun <T> T.apply(block: T.() -> void): T { block(this); return this }
class Point(var x: number, var y: number)
fun Point.demo(block: Point.() -> void): Point { block(this); return this }
class ExistingApply {
  apply(value: number): number { return value + 1 }
}

val first = Point(10, 20).apply { x = y * 2; y = this.x * 3 }
val second = Point(4, 6). {
  x *= 2
  demo {
    this@demo.x += 1
    this@apply.y += this@demo.x / 2
  }
}
console.log(first.x, first.y, second.x, second.y, ExistingApply().apply(4))
`);

    expect(output).toEqual([[40, 120, 9, 10.5, 5]]);
  });

  it("executes receiver-block shorthand without calling or requiring apply", () => {
    const source = `
class PlainPoint(var x: number, var y: number)
class TrapPoint(var x: number, var applyCalls: int = 0) {
  apply(block: TrapPoint.() -> void): TrapPoint {
    applyCalls += 1
    block(this)
    return this
  }
}

val plain = PlainPoint(3, 4). { it.x += it.y; y = this.x * 2 }
val trap = TrapPoint(5). { x *= 3 }
console.log(plain.x, plain.y, trap.x, trap.applyCalls)
`;

    expect(executeTranspiled(source, "optimized")).toEqual([[7, 14, 15, 0]]);
    expect(executeTranspiled(source, "conservative")).toEqual([[7, 14, 15, 0]]);
  });

  it("resolves inherited extension methods inside receiver blocks", () => {
    const output = executeTranspiled(`
class ReceiverBase(var value: int)
class ReceiverDerived extends ReceiverBase {
  constructor(value: int) { super(value) }
}
fun ReceiverBase.increment(amount: int): void { value += amount }

val result = ReceiverDerived(3). { increment(4) }
console.log(result.value)
`);

    expect(output).toEqual([[7]]);
  });

  it("passes the first visible receiver-function argument to implicit it", () => {
    const output = executeTranspiled(`
class Counter(var value: int)
fun <T> T.applyWithValue(block: T.(amount: int) -> void): T {
  block(this, 10)
  return this
}

val result = Counter(1).applyWithValue { value += it * 2 }
console.log(result.value)
`);

    expect(output).toEqual([[21]]);
  });

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

  it("executes optional-chain assignments anywhere an expression is allowed", () => {
    const source = `let target: { current?: { style?: { background: string } } } = { current: { style: { background: "white" } } }
console.log(target.current?.style?.background = "grey")
target.current = undefined
console.log(target.current?.style?.background = "black")
`;

    const logs = executeTranspiled(source, "optimized");

    expect(logs).toEqual([["grey"], [undefined]]);
  });

  it("executes brace lambdas in ordinary expression positions", () => {
    const source = `fun schedule(task: () => int, delay: int): int { task(); return delay }
fun clearTimer(timeout: int) {}
fun useEffect(effect: () => (() => void), inputs: int[]) {
  let cleanup = effect()
  cleanup()
}
let count = 0
let countRef: { current?: { style?: { background: string } } } = { current: { style: { background: "white" } } }
useEffect({
  val timeout = schedule({
    countRef.current?.style?.background = "grey"
    count++
  }, 1000)
  return { clearTimer(timeout) }
}, [count])
console.log(countRef.current?.style?.background)
console.log(count)
`;

    const logs = executeTranspiled(source, "optimized");

    expect(logs).toEqual([["grey"], [1]]);
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
val <T> Array<T>.firstItem: T => this[0]
val <T> Array<T>.doubledLength => length * 2
let xs = [10, 20, 30]
console.log(xs.firstItem)
console.log(xs.second())
console.log(xs.doubledLength)
console.log([].doubledLength)
`;

    const logs = executeTranspiled(source);

    expect(logs).toEqual([[10], [20], [6], [0]]);
  });

  it("executes property references as value delegates", () => {
    const source = `class View(var x: number)
let view = View(1)
let property = view::x
console.log(property.name)
console.log(property.value)
property.value = 3
console.log(view.x)
var delegated by property
delegated += 4
console.log(property.value)
console.log(view.x)
`;

    const logs = executeTranspiled(source);

    expect(logs).toEqual([["x"], [1], [3], [7], [7]]);
  });

  it("executes computed async-iterator class methods", () => {
    const source = `class Counter {
  async *[Symbol.asyncIterator](): AsyncGenerator<int> {
    yield 1
    yield 2
  }
}
let counter = new Counter()
console.log(typeof counter[Symbol.asyncIterator])
`;

    expect(executeTranspiled(source)).toEqual([["function"]]);
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

  it("supports numeric enum bitwise constants and computed members at runtime", () => {
    const source = `enum Demo { HELLO = 1, WORLD = 2 }
enum FileAccess {
  None,
  Read = 1 << 1,
  Write = 1 << 2,
  ReadWrite = Read | Write,
  G = "123".length,
}
console.log(Demo.HELLO | Demo.WORLD)
console.log(FileAccess[FileAccess.ReadWrite])
console.log(FileAccess[6])
console.log(FileAccess[FileAccess.G])
console.log(FileAccess[3])
`;

    expect(executeTranspiled(source)).toEqual([[3], [6], [6], [3], [3]]);
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

  it("executes the three-way comparison (spaceship) operator for numbers and strings", () => {
    const source = `
console.log(1 <=> 2)
console.log(2 <=> 2)
console.log(3 <=> 2)
console.log("apple" <=> "banana")
`;

    expect(executeTranspiled(source)).toEqual([[-1], [0], [1], [-1]]);
  });

  it("executes an overloaded spaceship operator", () => {
    const source = `
class Money(val cents: int) {
  operator<=>(other: Money): int => cents <=> other.cents
}
console.log(Money(150) <=> Money(99))
console.log(Money(99) <=> Money(150))
console.log(Money(150) <=> Money(150))
`;

    expect(executeTranspiled(source)).toEqual([[1], [-1], [0]]);
  });

  it("derives all six comparison operators from a spaceship overload", () => {
    const source = `
class Money(val cents: int) {
  operator<=>(other: Money): int => cents <=> other.cents
}
console.log(Money(1) < Money(2))
console.log(Money(2) < Money(1))
console.log(Money(1) <= Money(1))
console.log(Money(2) > Money(1))
console.log(Money(1) >= Money(2))
console.log(Money(1) == Money(1))
console.log(Money(1) == Money(2))
console.log(Money(1) != Money(2))
`;

    expect(executeTranspiled(source)).toEqual([
      [true], [false], [true], [true], [false], [true], [false], [true]
    ]);
  });

  it("derives != from an equality overload as !(a == b)", () => {
    const source = `
class Tag(val name: string) {
  operator==(other: Tag): boolean => name == other.name
}
console.log(Tag("a") == Tag("a"))
console.log(Tag("a") != Tag("b"))
console.log(Tag("a") != Tag("a"))
`;

    expect(executeTranspiled(source)).toEqual([[true], [true], [false]]);
  });
});
