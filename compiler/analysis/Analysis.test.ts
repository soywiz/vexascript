import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "./Analysis";
import type { AnalysisSymbol } from "./Analysis";

function namesOfVisibleSymbolsAt(source: string, line: number, character: number): string[] {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return analysis.getVisibleSymbolsAt(line, character).map((symbol) => symbol.name).sort();
}

function symbolsOfVisibleSymbolsAt(source: string, line: number, character: number): Map<string, AnalysisSymbol> {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return new Map(analysis.getVisibleSymbolsAt(line, character).map((symbol) => [symbol.name, symbol]));
}

describe("Analysis", () => {
  it("builds nested scopes and exposes function parameters/local variables", () => {
    const source =
      "let top = 1\n" +
      "fun demo(a, b: Num = top) {\n" +
      "  let inner = a\n" +
      "  {\n" +
      "    let deep = inner\n" +
      "    return deep\n" +
      "  }\n" +
      "}\n";

    const visible = namesOfVisibleSymbolsAt(source, 5, 6);
    expect(visible).toContain("a");
    expect(visible).toContain("b");
    expect(visible).toContain("inner");
    expect(visible).toContain("deep");
    expect(visible).toContain("demo");
    expect(visible).toContain("top");
  });

  it("does not leak function locals outside the function scope", () => {
    const source =
      "let top = 1\n" +
      "fun demo(a) {\n" +
      "  let inner = a\n" +
      "  return inner\n" +
      "}\n" +
      "let after = top\n";

    const visible = namesOfVisibleSymbolsAt(source, 5, 4);
    expect(visible).toContain("top");
    expect(visible).toContain("demo");
    expect(visible).toContain("after");
    expect(visible).not.toContain("a");
    expect(visible).not.toContain("inner");
  });

  it("reports semantic errors for unresolved variables in scope", () => {
    const source =
      "let top = 1\n" +
      "fun demo(a) {\n" +
      "  return a + missing + obj.prop + obj[dynamic]\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'missing'");
    expect(messages).toContain("Undefined variable 'obj'");
    expect(messages).toContain("Undefined variable 'dynamic'");
    expect(messages.some((message) => message.includes("'prop'"))).toBe(false);
    expect(messages.some((message) => message.includes("'a'"))).toBe(false);
  });

  it("reports semantic errors for illegal break/continue usage", () => {
    const source =
      "break\n" +
      "continue\n" +
      "switch (x) {\n" +
      "  case 1:\n" +
      "    break\n" +
      "    continue\n" +
      "}\n" +
      "while (x) {\n" +
      "  continue\n" +
      "  break\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Illegal 'break' statement outside of a loop or switch");
    expect(messages).toContain("Illegal 'continue' statement outside of a loop");
    expect(messages.filter((message) => message === "Illegal 'continue' statement outside of a loop")).toHaveLength(2);
    expect(messages.filter((message) => message === "Illegal 'break' statement outside of a loop or switch")).toHaveLength(1);
  });

  it("binds catch parameter in try/catch scope and validates throw expressions", () => {
    const source =
      "fun demo() {\n" +
      "  try {\n" +
      "    throw missing\n" +
      "  } catch (err) {\n" +
      "    throw err\n" +
      "  } finally {\n" +
      "    return 0\n" +
      "  }\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'missing'");
    expect(messages.some((message) => message.includes("'err'"))).toBe(false);
  });

  it("resolves class/function symbols declared later in the same scope", () => {
    const source =
      "fun demo() {\n" +
      "  const a = new Point(1, 2)\n" +
      "  return makePoint(a)\n" +
      "}\n" +
      "class Point {\n" +
      "}\n" +
      "fun makePoint(value) {\n" +
      "  return value\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'Point'"))).toBe(false);
    expect(messages.some((message) => message.includes("'makePoint'"))).toBe(false);
  });

  it("allows forward references only from global scope declarations", () => {
    const source =
      "fun demo() {\n" +
      "  while (zz) {\n" +
      "    break\n" +
      "  }\n" +
      "  return zz\n" +
      "}\n" +
      "var zz = true\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'zz'"))).toBe(false);
  });

  it("requires local variables to be declared before use inside function scope", () => {
    const source =
      "fun demo() {\n" +
      "  return localValue\n" +
      "  let localValue = 1\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'localValue'");
  });

  it("validates assignment targets as l-values", () => {
    const invalidSource = "20 = 10\n";
    const invalidAst = parseFile(tokenizeReader(invalidSource));
    const invalidAnalysis = new Analysis(invalidAst);
    const invalidMessages = invalidAnalysis.getIssues().map((issue) => issue.message);
    expect(invalidMessages).toContain(
      "Invalid assignment target: left side must be an identifier or member access"
    );

    const validSource = "let a = 1\na.b[10].c = 20\n";
    const validAst = parseFile(tokenizeReader(validSource));
    const validAnalysis = new Analysis(validAst);
    const validMessages = validAnalysis.getIssues().map((issue) => issue.message);
    expect(validMessages).not.toContain(
      "Invalid assignment target: left side must be an identifier or member access"
    );
  });

  it("reports incompatible assignment types", () => {
    const source =
      "var a = 10\n" +
      "a = \"test\"\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("reports reassignment of const/val variables", () => {
    const source =
      "const point = 1\n" +
      "point = 2\n" +
      "val count = 1\n" +
      "count += 1\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Cannot assign to 'point' because it is a constant");
    expect(messages).toContain("Cannot assign to 'count' because it is a constant");
  });

  it("reports update expressions on const/val variables", () => {
    const source =
      "const n = 1\n" +
      "n++\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Cannot assign to 'n' because it is a constant");
  });

  it("reports incompatible assignment types for class members", () => {
    const source = `class Point(val y: int)
fun demo() {
  const point = new Point(1)
  point.y = "test"
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("allows prefix and postfix update expressions on identifiers", () => {
    const source = `var a: int = 10
++a
--a
a++
a--
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("supports multiple declarations in a single var statement", () => {
    const source =
      "val a = 10 * 2, lol = true\n" +
      "fun demo() {\n" +
      "  return lol\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'lol'"))).toBe(false);
  });

  it("introduces MyLang for-in iterator variable in loop scope", () => {
    const source =
      "let iterable = data\n" +
      "for (value in iterable) {\n" +
      "  return value\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'value'"))).toBe(false);
  });

  it("infers expression and variable types, including function signature types", () => {
    const source =
      "val a = 10\n" +
      "val b = a + 20\n" +
      "val s = \"hello\"\n" +
      "function hello(x: int): int {\n" +
      "  return x + b\n" +
      "}\n" +
      "fun demo() {\n" +
      "  return s\n" +
      "}\n";

    const symbols = symbolsOfVisibleSymbolsAt(source, 7, 3);

    expect(symbols.get("a")?.valueType).toBe("int");
    expect(symbols.get("b")?.valueType).toBe("int");
    expect(symbols.get("s")?.valueType).toBe("string");
    expect(symbols.get("hello")?.valueType).toBe("(x: int) => int");
  });

  it("infers typed arrays from literal element types", () => {
    const source =
      "let nums = [1, 2, 3]\n" +
      "let mixed = [1, \"x\"]\n" +
      "fun demo() {\n" +
      "  return nums\n" +
      "}\n";

    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 3);
    expect(symbols.get("nums")?.valueType).toBe("int[]");
    expect(symbols.get("mixed")?.valueType).toBe("unknown[]");
  });

  it("resolves builtin and declared class types in annotations and reports unknown types", () => {
    const source =
      "function makePoint(p: Point): int {\n" +
      "  return 1\n" +
      "}\n" +
      "class Point {\n" +
      "}\n" +
      "fun bad(v: MissingType) {\n" +
      "  return v\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Unknown type 'Point'"))).toBe(false);
    expect(messages).toContain(
      "Unknown type 'MissingType'. Expected builtin type (int, number, string, boolean, bigint, long) or declared class/interface/type parameter"
    );
  });

  it("reports variable type mismatch on the variable name when initializer is not assignable", () => {
    const source = "let aa: string = 10 * 2\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const issues = analysis.getIssues();

    const mismatch = issues.find((issue) =>
      issue.message === "Type 'int' is not assignable to type 'string'"
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.node.kind).toBe("Identifier");
    expect((mismatch?.node as { name?: string }).name).toBe("aa");
    expect(mismatch?.node.firstToken?.value).toBe("aa");
  });

  it("resolves symbols introduced by import statements", () => {
    const source =
      "import { Point } from \"./a\"\n" +
      "fun demo() {\n" +
      "  return new Point()\n" +
      "}\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'Point'"))).toBe(false);
  });

  it("infers imported class instance type from new expressions", () => {
    const source =
      "import { MyPoint } from \"./world\"\n" +
      "fun demo() {\n" +
      "  const point = new MyPoint()\n" +
      "  return point\n" +
      "}\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 10);

    expect(symbols.get("point")?.valueType).toBe("MyPoint");
  });

  it("infers class type for new expressions", () => {
    const source =
      "class Point\n" +
      "let p = new Point()\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 1, 5);

    expect(symbols.get("p")?.valueType).toBe("Point");
  });

  it("infers number type for decimal and scientific literals", () => {
    const source =
      "let a = 10.573\n" +
      "let b = 10e-3\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 1, 5);

    expect(symbols.get("a")?.valueType).toBe("number");
    expect(symbols.get("b")?.valueType).toBe("number");
  });

  it("infers bigint and long literal and arithmetic types", () => {
    const source =
      "let a = 10n\n" +
      "let b = 20n\n" +
      "let c = a + b\n" +
      "let x = 10L\n" +
      "let y = 20L\n" +
      "let z = x + y\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 5, 5);

    expect(symbols.get("a")?.valueType).toBe("bigint");
    expect(symbols.get("c")?.valueType).toBe("bigint");
    expect(symbols.get("x")?.valueType).toBe("long");
    expect(symbols.get("z")?.valueType).toBe("long");
  });

  it("infers types for ternary, nullish coalescing, relational keywords, and unary word operators", () => {
    const source =
      "let a = true ? 1 : 2\n" +
      "let b = maybe ?? 10\n" +
      "let c = item in obj\n" +
      "let d = item instanceof Point\n" +
      "let e = typeof a\n" +
      "let f = void a\n" +
      "let g = delete obj.key\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 6, 5);

    expect(symbols.get("a")?.valueType).toBe("int");
    expect(symbols.get("b")?.valueType).toBe("int");
    expect(symbols.get("c")?.valueType).toBe("boolean");
    expect(symbols.get("d")?.valueType).toBe("boolean");
    expect(symbols.get("e")?.valueType).toBe("string");
    expect(symbols.get("f")?.valueType).toBe("undefined");
    expect(symbols.get("g")?.valueType).toBe("boolean");
  });

  it("reports semantic error for unknown class members", () => {
    const source = `class MyPoint(val y: int) {
  sum(): int {
    return y
  }
}

fun demo() {
  const point = new MyPoint(1)
  point.y
  point.sum()
  point.xx
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'xx' does not exist on type 'MyPoint'");
    expect(messages.some((message) => message.includes("'y' does not exist"))).toBe(false);
    expect(messages.some((message) => message.includes("'sum' does not exist"))).toBe(false);
  });

  it("reports call argument type and arity mismatches, with int->number and long->bigint assignability", () => {
    const source = `fun test2(a: number, b: bigint, c: string) {
}
fun demo() {
  test2(1, 10L, "ok")
  test2("hello", 10, "ok")
  test2(1, 10L)
  test2(1, 10L, "ok", 42)
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'a' of type 'number'"
    );
    expect(messages).toContain(
      "Argument 2 of type 'int' is not assignable to parameter 'b' of type 'bigint'"
    );
    expect(messages).toContain("Expected at least 3 argument(s), but got 2");
    expect(messages).toContain("Expected at most 3 argument(s), but got 4");
    expect(messages).toContain("Unexpected argument 4; function expects at most 3 argument(s)");
  });

  it("supports assignability between compatible function types beyond strict equality", () => {
    const source = `fun target(a: number): int {
  return 1
}
fun compatible(a: int, b?: int): int {
  return a
}
fun incompatible(a: string): int {
  return 1
}
fun demo() {
  let fn = target
  fn = compatible
  fn = incompatible
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("compatible") && message.includes("not assignable"))
    ).toBe(false);
    expect(messages).toContain(
      "Type '(a: string) => int' is not assignable to type '(a: number) => int'"
    );
  });

  it("infers object literal shapes and validates named-type members structurally", () => {
    const source = `class Pair(val x: int, val y: int)
fun sum(pair: Pair): int {
  return pair.x + pair.y
}
fun demo() {
  let pair: Pair = { x: 1, y: 2 }
  return sum({ x: 3, y: 4 })
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("not assignable"))).toBe(false);
    expect(messages.some((message) => message.includes("does not exist on type"))).toBe(false);
  });

  it("reports missing members for inferred object literal shapes", () => {
    const source = `fun demo() {
  let pair = { x: 1, y: 2 }
  return pair.z
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'z' does not exist on type '{ x: int, y: int }'");
  });

  it("propagates array element type through iterator and computed assignment", () => {
    const source = `let nums = [1, 2, 3]
for (value in nums) {
  let s: string = value
}
nums[0] = "x"
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' is not assignable to type 'string'");
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("adds nested-expression context for type mismatches", () => {
    const source = `let value: int = 1 + "x"
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
    expect(
      messages.some((message) => message.startsWith("Nested type mismatch: expression"))
    ).toBe(true);
  });

  it("supports generic type annotations in classes and interfaces", () => {
    const source = `interface PairStore<K, V> {
  keys: K[]
  values: V[]
}

class Map<K, V> implements PairStore<K, V> {
  keys: K[]
  values: V[]
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("accepts class extends/implements with generic type arguments", () => {
    const source = `class Base<T> {
  value: T
}
interface Readable<T> {
  value: T
}
class Child<T> extends Base<T> implements Readable<T> {
  value: T
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("does not treat generic type arguments in 'new' expressions as runtime identifiers", () => {
    const source = `class Map<K, V> {
  a: K
  b: V
}
fun demo() {
  const map: boolean = new Map<string, string>()
  map
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Undefined variable 'string'"))).toBe(false);
    expect(messages).toContain("Type 'Map<string, string>' is not assignable to type 'boolean'");
  });

  it("resolves class member types from generic specifics", () => {
    const source = `class Map<K, V> {
  a: K
  b: V
}
fun demo() {
  const map: Map<string, int> = new Map<string, int>()
  const ok: string = map.a
  const fail: int = map.a
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'a' does not exist"))).toBe(false);
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("resolves generic class method signatures from specifics", () => {
    const source = `class Map<K, V> {
  get(key: K): V {
  }
}
fun demo() {
  const map: Map<string, int> = new Map<string, int>()
  const ok: int = map.get("id")
  const badArg: int = map.get(1)
  const badReturn: string = map.get("id")
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("Argument 1 of type 'int' is not assignable to parameter 'key' of type 'string'"))
    ).toBe(true);
    expect(messages).toContain("Type 'int' is not assignable to type 'string'");
  });

  it("resolves inherited members from generic extends specifics", () => {
    const source = `class Base<T> {
  value: T
}
class Child extends Base<string> {
}
fun demo() {
  const child = new Child()
  const ok: string = child.value
  const bad: int = child.value
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'value' does not exist"))).toBe(false);
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("resolves members from generic interfaces through extends and implements", () => {
    const source = `interface Readable<T> {
  read(): T
}
interface NamedReadable<T> extends Readable<T> {
}
class Reader implements NamedReadable<string> {
  read(): string {
  }
}
fun demo() {
  const reader = new Reader()
  const ok: string = reader.read()
  const bad: int = reader.read()
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'read' does not exist"))).toBe(false);
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("reports missing properties when class does not satisfy implemented interface", () => {
    const source = `interface Readable {
  value: string
}
class Reader implements Readable {
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'Reader' incorrectly implements interface 'Readable'. Property 'value' is missing"
    );
  });

  it("reports incompatible property types in implemented interface contracts", () => {
    const source = `interface Store {
  save(value: string): string
}
class NumberStore implements Store {
  save(value: int): int {
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'NumberStore' incorrectly implements interface 'Store'. Property 'save' is of type '(value: int) => int' but expected '(value: string) => string'"
    );
  });
});
