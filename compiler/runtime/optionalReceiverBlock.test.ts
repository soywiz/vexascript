import { Script, createContext, expect, it } from "../test/expect";
import { transpile } from "./transpile";

function executeTranspiled(source: string): unknown[][] {
  const result = transpile(source, { target: "optimized" });
  expect(result.errors).toEqual([]);

  const logs: unknown[][] = [];
  const context = createContext({
    console: {
      log: (...args: unknown[]) => logs.push(args)
    }
  });

  new Script(result.code).runInContext(context);
  return logs;
}

it("runs optional receiver blocks only for non-nullish receivers", () => {
  const output = executeTranspiled(`
class OptionalReceiver(var value: number)
fun maybeReceiver(present: boolean): OptionalReceiver | null {
  return present ? OptionalReceiver(1) : null
}

val present = maybeReceiver(true)?. { value += 4 }
val absent = maybeReceiver(false)?. { throw "optional receiver block ran" }
console.log(present?.value, absent)
`);

  expect(output).toEqual([[5, undefined]]);
});

it("resolves extension methods through optional and non-null member access", () => {
  const output = executeTranspiled(`
class Point(val x: number, val y: number)
fun Point.drawDot(size: number): string => "dot:" + x + ":" + y + ":" + size
fun maybePoint(present: boolean): Point | null {
  return present ? Point(2, 3) : null
}

val optional = maybePoint(true)?.drawDot(4)
val missing = maybePoint(false)?.drawDot(6)
val asserted = maybePoint(true)!.drawDot(5)
console.log(optional, asserted, missing)
`);

  expect(output).toEqual([["dot:2:3:4", "dot:2:3:5", undefined]]);
});
