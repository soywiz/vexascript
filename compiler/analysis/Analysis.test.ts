import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { Parser, parseFile } from "compiler/parser/parser";
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
  it("checks exported runtime namespace members", () => {
    const ast = parseFile(tokenizeReader("namespace Tools { export const version: int = 1; const hidden = 2 }\nlet ok: int = Tools.version\nlet bad = Tools.hidden"));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Property 'hidden' does not exist on type 'Tools'");
    expect(analysis.getIssues().map((issue) => issue.message)).not.toContain("Property 'version' does not exist on type 'Tools'");
  });

  it("binds ambient namespace names and analyzes declarations inside their scope", () => {
    const source = "declare namespace Tools {\nexport const version: string;\nexport function read(): string;\n}\nconst outside = 1";
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getVisibleSymbolsAt(1, 16).map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Tools", "version", "read"]));
    expect(analysis.getVisibleSymbolsAt(4, 0).map((symbol) => symbol.name)).toContain("Tools");
    expect(analysis.getVisibleSymbolsAt(4, 0).map((symbol) => symbol.name)).not.toContain("version");
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("uses ambient function signatures and exported ambient declarations during analysis", () => {
    const source = `declare type Id = string
export declare function lookup(id: Id): int
lookup(123)
`;
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getVisibleSymbolsAt(2, 0).map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Id", "lookup"]));
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Argument 1 of type 'int' is not assignable to parameter 'id' of type 'string'");
  });

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

  it("erases TypeScript this parameters from callable signatures", () => {
    const ast = parseFile(tokenizeReader(`function bind(this: Loader, id: string): string { return id }
let after = bind`));
    const analysis = new Analysis(ast);
    const symbols = new Map(analysis.getVisibleSymbolsAt(1, 4).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("bind")?.valueType).toBe("(id: string) => string");
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
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

  describe("cross-file extension methods (externalDeclarations)", () => {
    const otherFileSource = "class Point(val x: number, val y: number)\n";
    const mainSource =
      "fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)\n" +
      "fun Point.distanceTo(other: Point): number => this.x - other.x + (this.y - other.y)\n";

    it("resolves the implicit receiver and members of an imported class", () => {
      const externalDeclarations = parseFile(tokenizeReader(otherFileSource)).body;
      const ast = parseFile(tokenizeReader(mainSource));
      const analysis = new Analysis(ast, { externalDeclarations });
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages).not.toContain("Undefined variable 'x'");
      expect(messages).not.toContain("Undefined variable 'y'");
      expect(messages.filter((message) => message.includes("Operator '+' is not defined"))).toEqual([]);
      expect(messages.filter((message) => message.includes("Operator '-' is not defined"))).toEqual([]);
    });

    it("still reports the receiver members as undefined without the imported class", () => {
      const ast = parseFile(tokenizeReader(mainSource));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages).toContain("Undefined variable 'x'");
    });
  });

  it("allows yield only inside generator functions", () => {
    const source =
      "function* ok() {\n" +
      "  yield 1\n" +
      "  yield* []\n" +
      "}\n" +
      "function bad() {\n" +
      "  yield 2\n" +
      "}\n" +
      "class Store {\n" +
      "  *values() {\n" +
      "    yield 3\n" +
      "  }\n" +
      "  async save() {\n" +
      "    yield 4\n" +
      "  }\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("The 'yield' keyword is only allowed inside generator functions");
    expect(messages.filter((message) => message === "The 'yield' keyword is only allowed inside generator functions")).toHaveLength(2);
  });

  it("uses the final comma expression operand as the expression type", () => {
    const ast = parseFile(tokenizeReader("let value: string = (1, \"ok\")"));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("checks TypeScript angle-bracket assertions like as assertions", () => {
    const ast = parseFile(tokenizeReader(`let value: string = <string>unknownValue\nlet unsafe = <number>"oops"`));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'unknownValue'");
    expect(messages).toContain("Type assertion from 'string' to 'number' may be unsafe because neither type is assignable to the other");
  });

  it("resolves keyof, typeof type queries, and indexed access types semantically", () => {
    const source =
      "interface Person {\n" +
      "  name: string\n" +
      "  age: int\n" +
      "}\n" +
      "let person: Person = { name: \"Ada\", age: 36 }\n" +
      "let key: keyof Person = \"name\"\n" +
      "let copiedName: typeof person.name = \"Ada\"\n" +
      "let indexedName: Person[\"name\"] = \"Grace\"\n" +
      "let indexedNames: Person[\"name\"][] = [\"Grace\"]\n" +
      "let indexedValue: Person[keyof Person] = 1\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("reports missing properties in indexed access type annotations", () => {
    const source =
      "interface Person { name: string }\n" +
      "let value: Person[\"missing\"] = \"Ada\"\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Type 'Person' has no property 'missing'"
    );
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

  it("infers regular expression literals, sparse array holes, and duplicate switch defaults", () => {
    const source =
      "declare class RegExp {}\n" +
      "let re: RegExp = /a+/g\n" +
      "let values: (int | undefined)[] = [1, , 3]\n" +
      "switch (values[0]) {\n" +
      "  default:\n" +
      "    break\n" +
      "  default:\n" +
      "    break\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Switch statement cannot contain multiple default clauses");
    expect(messages.some((message) => message.includes("RegExp"))).toBe(false);
    expect(messages.some((message) => message.includes("undefined") && message.includes("assignable"))).toBe(false);
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

  it("validates labeled break and continue targets", () => {
    const source =
      "outer: while (ok) {\n" +
      "  continue outer\n" +
      "  break outer\n" +
      "}\n" +
      "blockLabel: {\n" +
      "  break blockLabel\n" +
      "  continue blockLabel\n" +
      "}\n" +
      "break missingLabel\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Illegal 'continue' target 'blockLabel' because the label does not reference a loop");
    expect(messages).toContain("Undefined statement label 'missingLabel'");
    expect(messages.some((message) => message.includes("'outer'"))).toBe(false);
    expect(messages.some((message) => message.includes("'blockLabel'") && message.startsWith("Undefined"))).toBe(false);
  });

  it("requires every reachable path in non-void functions and methods to return", () => {
    const source = `function complete(flag: boolean): int {
  if (flag) {
    return 1
  } else {
    return 2
  }
}
function incomplete(flag: boolean): int {
  if (flag) return 1
}
class Calculator {
  choose(flag: boolean): string {
    if (flag) return "yes"
  }
  fail(): int {
    throw "failure"
  }
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const missingReturnIssues = analysis.getIssues().filter(
      (issue) => issue.message === "Not all code paths return a value"
    );

    expect(missingReturnIssues).toHaveLength(2);
    expect(missingReturnIssues.map((issue) => issue.node.kind)).toEqual(["Identifier", "Identifier"]);
    expect(missingReturnIssues.map((issue) => (issue.node as { name?: string }).name)).toEqual([
      "incomplete",
      "choose"
    ]);
  });

  it("checks return values against the nearest function return type", () => {
    const source = `function wrong(): int {
  return "bad"
}
function missingValue(): string {
  return
}
function wrongVoid(): void {
  return 1
}
function outer(): string {
  function inner(): int {
    return "inner bad"
  }
  return "ok"
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Type 'string' is not assignable to return type 'int'",
      "A function whose declared return type is neither 'undefined' nor 'void' must return a value",
      "Type 'int' is not assignable to return type 'void'",
      "Type 'string' is not assignable to return type 'int'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "ReturnStatement",
      "ReturnStatement",
      "ReturnStatement",
      "ReturnStatement"
    ]);
  });

  it("reports empty template interpolations as semantic missing-expression errors", () => {
    const source = "class TimeSpan(val ms: number) {\n  toString() => `${}`\n}\n";

    const ast = parseFile(tokenizeReader(source));
    const parser = new Parser(tokenizeReader(source));
    parser.parseFile();
    const analysis = new Analysis(ast);

    expect(parser.errors).toEqual([]);
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Expected an expression");
    expect(analysis.getIssues().map((issue) => issue.node.kind)).toContain("MissingExpression");
  });

  it("accepts awaited and non-awaited return values in async functions with Promise return types", () => {
    const source = `declare function promisedInt(): Promise<int>
async function goodValue(): Promise<int> {
  return 10
}
async function goodPromise(): Promise<int> {
  return promisedInt()
}
async function bad(): Promise<int> {
  return "bad"
}
async function empty(): Promise<void> {
  return
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Type 'string' is not assignable to return type 'Promise<int>'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "ReturnStatement"
    ]);
  });

  it("unwraps Promise values in await expressions and preserves non-Promise values", () => {
    const source = `declare function promisedInt(): Promise<int>
declare function plainInt(): int

async function consumePromise() {
  let value: int = await promisedInt()
}

async function consumePlain() {
  let value: int = await plainInt()
}

async function wrongAwaitedType() {
  let value: string = await promisedInt()
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Type 'int' is not assignable to type 'string'",
      "Nested type mismatch: expression 'await ... )' is 'int' but expected 'string'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "Identifier",
      "UnaryExpression"
    ]);
  });

  it("infers Promise return types from async function returns", () => {
    const source = `async function inferred(flag: boolean) {
  if (flag) return 10
  return 20
}
let expectsPromise: (flag: boolean) => Promise<int> = inferred`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("auto-wraps non-Promise annotations on async functions as Promise<T>", () => {
    const source = `async function inferred(): number {
  return 10
}
class Box {
  async load(): string {
    return "x"
  }
}
let a: () => Promise<number> = inferred
let b: () => Promise<string> = () => new Box().load()`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("treats sync functions as Promise<T> producers without requiring a Promise annotation", () => {
    const source = `sync function inferred(): number {
  return 10
}
class Box {
  sync load(): string {
    return "x"
  }
}
let a: () => Promise<number> = inferred
let b: () => Promise<string> = () => new Box().load()`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("auto-awaits Promise-typed bindings inside sync functions while go preserves the Promise", () => {
    const source = `sync fun fetchValue(): int { return 1 }
sync fun main(): int {
  let x = fetchValue()
  let p: Promise<int> = go fetchValue()
  return x + 10
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("observes auto-awaited sync results as their unwrapped type", () => {
    const source = `sync fun fetchValue(): int { return 1 }
sync fun main(): void {
  let s: string = fetchValue()
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Type 'int' is not assignable to type 'string'"
    );
  });

  it("auto-awaits Promise-typed subexpressions in argument and member positions", () => {
    const source = `declare function use(value: int): void
class Box { value(): int { return 1 } }
sync fun fetchValue(): int { return 1 }
sync fun fetchBox(): Box { return Box() }
sync fun main(): void {
  use(fetchValue())
  use(fetchValue() + 1)
  use(fetchBox().value())
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("keeps the Promise type of local variables instead of auto-awaiting references", () => {
    const source = `async fun demo2(): Promise<int> { return 10 }
sync fun demo(): void {
  let stored = go demo2()
  let alias: Promise<int> = stored
  let plain: int = stored
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    // `alias = stored` is fine (both Promise<int>); `plain: int = stored` is a mismatch because the
    // local variable reference is not auto-awaited.
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([
      "Type 'Promise<int>' is not assignable to type 'int'"
    ]);
  });

  it("keeps the Promise type when go opts out, even in argument positions", () => {
    const source = `declare function use(value: int): void
sync fun fetchValue(): int { return 1 }
sync fun main(): void {
  use(go fetchValue())
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Argument 1 of type 'Promise<int>' is not assignable to parameter 'value' of type 'int'"
    );
  });

  it("checks contextual function-expression and arrow-function returns", () => {
    const source = `let arrow: (flag: boolean) => int = (flag) => {
  if (flag) return 1
}
let expression: () => string = function(): string {
  return 1
}
let concise: () => int = () => "bad"`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Not all code paths return a value",
      "Type 'int' is not assignable to return type 'string'",
      "Type 'string' is not assignable to return type 'int'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "ArrowFunctionExpression",
      "ReturnStatement",
      "StringLiteral"
    ]);
  });

  it("recognizes exhaustive switch and try/catch return paths", () => {
    const source = `function viaSwitch(value: int): string {
  switch (value) {
    case 1:
      return "one"
    default:
      return "other"
  }
}
function viaTry(flag: boolean): int {
  try {
    if (flag) return 1
    throw "bad"
  } catch (error) {
    return 2
  }
}`;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("checks with statement object expressions and bodies", () => {
    const source =
      "let scope = { value: 1 }\n" +
      "with (scope) {\n" +
      "  let inner: int = \"bad\"\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
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

  it("checks union, intersection, literal, and tuple type annotations", () => {
    const source =
      "interface Named { name: string }\n" +
      "interface Aged { age: int }\n" +
      "let person: Named & Aged = { name: \"Ada\", age: 1 }\n" +
      "let incomplete: Named & Aged = { name: \"Ada\" }\n" +
      "let maybe: string | int = 1\n" +
      "maybe = \"ok\"\n" +
      "maybe = false\n" +
      "let status: \"ready\" | \"done\" = \"ready\"\n" +
      "status = \"bad\"\n" +
      "let pair: [string, int] = [\"age\", 1]\n" +
      "pair = [2, \"wrong\"]\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type '{ name: string }' is not assignable to type 'Named & Aged'");
    expect(messages).toContain("Type 'boolean' is not assignable to type 'string | int'");
    expect(messages).toContain("Type 'string' is not assignable to type '\"ready\" | \"done\"'");
    expect(messages).toContain("Type '[int, string]' is not assignable to type '[string, int]'");
    expect(messages.some((message) => message.includes("'ready'"))).toBe(false);
  });


  it("keeps nested unions inside object type annotations", () => {
    const source = `type Result = { value: string | int }
let numeric: Result = { value: 1 }
let textual: Result = { value: "ok" }
let invalid: Result = { value: true }
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([
      "Type '{ value: boolean }' is not assignable to type '{ value: string | int }'",
      "Nested type mismatch: expression '{ ... }' is '{ value: boolean }' but expected '{ value: string | int }'"
    ]);
  });

  it("checks function and object type literal annotations", () => {
    const source = `let mapper: (value: int) => string = (value: int) => "ok"
let badMapper: (value: int) => string = (value: int) => value
let point: { x: int; label?: string } = { x: 1 }
let badPoint: { x: int; label: string } = { x: 1, label: 2 }
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = new Map(analysis.getVisibleSymbolsAt(3, 5).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("mapper")?.valueType).toBe("(value: int) => string");
    expect(symbols.get("point")?.valueType).toBe("{ x: int, label: string | undefined }");
    expect(messages).toContain("Type 'int' is not assignable to return type 'string'");
    expect(messages).toContain("Type '{ x: int, label: int }' is not assignable to type '{ x: int, label: string }'");
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
      "Unknown type 'MissingType'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter"
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



  it("checks local named export specifiers semantically", () => {
    const okAst = parseFile(tokenizeReader("const value = 1\nexport { value }"));
    expect(new Analysis(okAst).getIssues().map((issue) => issue.message)).toEqual([]);

    const missingAst = parseFile(tokenizeReader("export { missing }"));
    expect(new Analysis(missingAst).getIssues().map((issue) => issue.message)).toContain("Undefined variable 'missing'");
  });

  it("binds and checks declarations nested inside export statements", () => {
    const source =
      "export class Point\n" +
      "export const p: Point = new Point()\n" +
      "let again = new Point()\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = symbolsOfVisibleSymbolsAt(source, 2, 5);

    expect(messages.some((message) => message.includes("'Point'"))).toBe(false);
    expect(symbols.get("p")?.valueType).toBe("Point");
    expect(symbols.get("again")?.valueType).toBe("Point");
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

  it("resolves symbols introduced by default, namespace, and aliased imports", () => {
    const source =
      "import React from \"react\"\n" +
      "import * as fs from \"fs\"\n" +
      "import { Point as LocalPoint } from \"./a\"\n" +
      "fun demo() {\n" +
      "  React\n" +
      "  fs\n" +
      "  return new LocalPoint()\n" +
      "}\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'React'"))).toBe(false);
    expect(messages.some((message) => message.includes("'fs'"))).toBe(false);
    expect(messages.some((message) => message.includes("'LocalPoint'"))).toBe(false);
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

  it("infers class instance types when classes are called without new", () => {
    const source =
      "class Point(val x: int)\n" +
      "let point = Point(1)\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const symbols = symbolsOfVisibleSymbolsAt(source, 1, 4);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(symbols.get("point")?.valueType).toBe("Point");
  });

  it("reports missing constructor arguments for class calls and new expressions", () => {
    const source =
      "class Point(val x: number, val y: number)\n" +
      "fun demo() {\n" +
      "  new Point()\n" +
      "  Point()\n" +
      "}\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Expected at least 2 argument(s), but got 0")).toHaveLength(2);
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

  it("infers numeric separator and non-decimal literal types", () => {
    const source =
      "let a = 1_000\n" +
      "let b = 0xff\n" +
      "let c = 0xfn\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 2, 5);

    expect(symbols.get("a")?.valueType).toBe("int");
    expect(symbols.get("b")?.valueType).toBe("int");
    expect(symbols.get("c")?.valueType).toBe("bigint");
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

  it("infers dedicated primitive literal node types", () => {
    const source =
      "let t = true\n" +
      "let f = false\n" +
      "let n = null\n" +
      "let u = undefined\n";
    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 5);

    expect(symbols.get("t")?.valueType).toBe("boolean");
    expect(symbols.get("f")?.valueType).toBe("boolean");
    expect(symbols.get("n")?.valueType).toBe("null");
    expect(symbols.get("u")?.valueType).toBe("undefined");
  });

  it("resolves pending TypeScript primitive type annotations with assignability semantics", () => {
    const source =
      "declare function makeSymbol(): symbol\n" +
      "declare function fail(): never\n" +
      "let flexible: any = \"Ada\"\n" +
      "let strict: int = flexible\n" +
      "let opaque: unknown = 1\n" +
      "let record: object = { a: 1 }\n" +
      "let token: symbol = makeSymbol()\n" +
      "let recovered: number = fail()\n";

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    expect(messages).toEqual([]);
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

  it("infers object method types and checks method bodies", () => {
    const source = `fun demo() {
  let calc = { add(a: int, b: int): int { return a + b } }
  let value: int = calc.add(1, 2)
  let bad: string = calc.add(1, 2)
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' is not assignable to type 'string'");
    expect(messages.some((message) => message.includes("Property 'add' does not exist"))).toBe(false);
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

  it("infers shorthand and spread object literal shapes and checks spread operands", () => {
    const source = `fun demo() {
  let a = 1
  let base = { name: "Ada" }
  let merged = { a, ...base, name: "Grace" }
  let age: int = merged.name
  let invalid = { ...a }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
    expect(messages).toContain("Spread types may only be created from object types; got 'int'");
    expect(messages.some((message) => message.includes("Undefined variable 'a'"))).toBe(false);
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

  it("specializes explicit generic function calls", () => {
    const source = `fun identity<T>(value: T): T {
  return value
}
let ok: string = identity<string>("hello")
let wrongReturn: number = identity<string>("hello")
let wrongArgument = identity<number>("hello")
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'number'");
    expect(messages).toContain("Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'");
    expect(messages.some((message) => message.includes("Unknown type 'T'"))).toBe(false);
  });

  it("infers generic function type arguments from call arguments", () => {
    const source = `fun identity<T>(value: T): T {
  return value
}
fun first<T>(items: T[]): T {
  return items[0]
}
let okString: string = identity("hello")
let wrongString: int = identity("hello")
let okArray: int = first([1, 2, 3])
let wrongArray: string = first([1, 2, 3])
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'string' is not assignable to type 'int'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type 'int' is not assignable to type 'string'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Unknown type 'T'"))).toBe(false);
  });

  it("infers generic function type arguments from contextual return types", () => {
    const source = `fun make<T>(): T {
}
fun empty<T>(): T[] {
}
let text: string = make()
let numbers: int[] = empty()
let badExplicit: string = make<number>()
let badArray: int[] = empty<string>()
let assigned: string
assigned = make()
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'number' is not assignable to type 'string'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type 'string[]' is not assignable to type 'int[]'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Type 'T' is not assignable"))).toBe(false);
  });

  it("uses array and object literal context for nested generic call return inference", () => {
    const source = `interface Box {
  value: string
}
fun make<T>(): T {
}
let values: string[] = [make()]
let boxed: Box = { value: make() }
let badValues: int[] = [make<string>()]
let badBox: Box = { value: make<number>() }
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'string[]' is not assignable to type 'int[]'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type '{ value: number }' is not assignable to type 'Box'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Type 'T' is not assignable"))).toBe(false);
  });

  it("contextually types function arguments before generic call inference", () => {
    const source = `interface Mapper<T, U> {
  map(item: T): U
}
fun mapValue<T, U>(value: T, mapper: Mapper<T, U>): U {
}
let okNumber: number = mapValue(1, { map: item => 1 })
let okText: string = mapValue("hello", { map: item => "ok" })
let wrongArgument = mapValue(1, { map: item => item.missing })
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = symbolsOfVisibleSymbolsAt(source, 4, 3);

    expect(symbols.get("okNumber")?.valueType).toBe("number");
    expect(symbols.get("okText")?.valueType).toBe("string");
    expect(messages).toContain(
      "Argument 2 of type '{ map: (item: int) => unknown }' is not assignable to parameter 'mapper' of type 'Mapper<int, U>'"
    );
    expect(messages.some((message) => message.includes("Undefined variable 'item'"))).toBe(false);
    expect(messages.some((message) => message.includes("Type 'T' is not assignable"))).toBe(false);
  });

  it("keeps explicit generic function type arguments authoritative over inference", () => {
    const source = `fun identity<T>(value: T): T {
  return value
}
let wrongArgument = identity<number>("hello")
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'");
  });

  it("resolves generic type aliases in annotations and member access", () => {
    const source = `class Box<T> {
  value: T
}
type Text = string
type TextBox = Box<Text>
type Boxed<T> = Box<T>
let ok: Text = "hello"
let bad: Text = 1
let box: Boxed<Text> = new Box<string>()
let value: string = box.value
let wrongValue: int = box.value
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'int' is not assignable to type 'string'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type 'string' is not assignable to type 'int'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Unknown type 'Text'"))).toBe(false);
    expect(messages.some((message) => message.includes("Unknown type 'Boxed'"))).toBe(false);
  });

  it("accepts mapped and conditional aliases conservatively", () => {
    const source = `type Optional<T> = { [K in keyof T]?: T[K] }
type Element<T> = T extends (infer U)[] ? U : T
let optional: Optional<{ name: string }> = { name: "Ada" }
let element: Element<string[]> = "Ada"
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
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

  it("treats class accessors as typed properties and validates accessor parameters", () => {
    const source = `class Box {
  get value(): string {
    return "ok"
  }
  set value(next: string) {
  }
  get bad(value: string): string {
    return value
  }
  set missing() {
  }
}
let box: Box
const ok: string = box.value
const fail: int = box.value
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
    expect(messages).toContain("Getter 'bad' cannot declare parameters");
    expect(messages).toContain("Setter 'missing' must declare exactly one parameter");
    expect(messages.some((message) => message.includes("Property 'value' does not exist"))).toBe(false);
  });

  it("treats getter shorthand members as typed properties", () => {
    const source = `class Rect {
  width: number
  height: number
  area: number => this.width * this.height
}
let rect: Rect
const ok: number = rect.area
const fail: string = rect.area
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'number' is not assignable to type 'string'");
    expect(messages.some((message) => message.includes("Property 'area' does not exist"))).toBe(false);
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

  it("validates constrained generic type arguments on declarations and calls", () => {
    const source = `interface Entity {
  id: string
}
class User implements Entity {
  id: string
}
class Box<T extends Entity> {
  value: T
}
fun readId<T extends Entity>(value: T): string {
}
fun demo() {
  const okBox: Box<User> = new Box<User>()
  const badBox: Box<string> = new Box<string>()
  const ok = readId(new User())
  const bad = readId("nope")
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Type argument 'string' does not satisfy constraint 'Entity' for type parameter 'T'"
    );
    expect(messages.some((message) => message.includes("Type argument 'User' does not satisfy"))).toBe(false);
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

  it("reports optionality mismatch in implemented interface method parameters", () => {
    const source = `interface Runner {
  run(step: int): int
}
class BadRunner implements Runner {
  run(step?: int): int {
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'BadRunner' incorrectly implements interface 'Runner'. Property 'run' is of type '(step?: int) => int' but expected '(step: int) => int'"
    );
  });

  it("assumes void return type for interface methods without explicit return annotation", () => {
    const source = `interface Runner {
  run(step: int)
}
class BadRunner implements Runner {
  run(step: int): int {
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'BadRunner' incorrectly implements interface 'Runner'. Property 'run' is of type '(step: int) => int' but expected '(step: int) => void'"
    );
  });

  it("accepts class methods without explicit return type when interface method implies void", () => {
    const source = `interface Runner {
  run(step: int)
}
class GoodRunner implements Runner {
  run(step: int) {
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("incorrectly implements interface"))
    ).toBe(false);
  });

  it("accepts getter shorthand members for implemented interface properties", () => {
    const source = `interface Shape {
  area: number
}
class Rectangle implements Shape {
  width: number
  height: number
  area: number => this.width * this.height
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("incorrectly implements interface"))
    ).toBe(false);
  });

  it("resolves lambda parameters inside lambda scope", () => {
    const source = `declare function apply(fn): int
let x = apply((a, b, c) => a + b + c)
let y = apply(function(a: int, b: int, c: int) { return a + b + c })
let z = apply(callable { a, b, c -> a + b + c })
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message === "Undefined variable 'a'")).toBe(false);
    expect(messages.some((message) => message === "Undefined variable 'b'")).toBe(false);
    expect(messages.some((message) => message === "Undefined variable 'c'")).toBe(false);
  });

  it("loads ECMAScript runtime declarations as ambient globals", () => {
    const source = `fun demo() {
  let values = [1, 2]
  values.includes(1)
  values.join(",")
  let scores = new Map<string, number>()
  scores.set("ada", Math.max(1, 2))
  console.log(JSON.stringify(scores))
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("uses declared Array<T> members for T[] alias member resolution", () => {
    const source = `declare class Array<T> {
  map<R>(mapper: (item: T) => T): Array<R>
}
fun demo() {
  [1,2,3,4].map { it * 2 }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'map' does not exist"))).toBe(false);
    expect(messages.some((message) => message === "Undefined variable 'it'")).toBe(false);
  });

  it("does not require return paths for methods declared inside ambient classes", () => {
    const source = `declare class MathConstructor {
  abs(x: number): number
  ceil(x: number): number
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).not.toContain("Not all code paths return a value");
    expect(messages).toEqual([]);
  });



  it("uses TypeScript as assertions as semantic target types", () => {
    const source = `let unknownValue: unknown = "Ada"
let name: string = unknownValue as string
let unsafe = true as string
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Cannot assign value of type 'unknown' to 'string'"))).toBe(false);
    expect(messages).toContain("Type assertion from 'boolean' to 'string' may be unsafe because neither type is assignable to the other");
  });

  it("treats const assertions as erased assertions that keep the expression type", () => {
    const source = `let values = [1, 2] as const
let count: number = 1 as const
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("binds super in derived class methods for inherited member semantics", () => {
    const source = `class Base {
  label(): string { return "base" }
}
class Child extends Base {
  label(): string {
    return super.label()
  }
  mismatch(): number {
    let value: number = super.label()
    return value
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).not.toContain("Undefined variable 'super'");
    expect(messages).toContain("Type 'string' is not assignable to type 'number'");
  });

  it("validates private and protected class member access", () => {
    const source = `class Base {
  private secret: string
  protected token: string
  read() {
    return this.secret
  }
}
class Child extends Base {
  readToken() {
    return this.token
  }
}
let base: Base
let child: Child
base.secret
base.token
child.token
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Member 'secret' is private and can only be accessed within class 'Base'");
    expect(messages).toContain("Member 'token' is protected and can only be accessed within class 'Base' or its subclasses");
    expect(messages.filter((message) => message.includes("Member 'token' is protected"))).toHaveLength(2);
  });

  it("analyzes constructor parameter properties as typed readonly members", () => {
    const source = `
class User {
  constructor(public readonly id: string, private age: int) {}
  birthday() {
    this.age = this.age + 1
    this.id = "changed"
  }
}
let user = new User("a", 1)
let id: string = user.id
let hidden = user.age
let bad: int = user.id
`;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Cannot assign to readonly member 'id'");
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Member 'age' is private and can only be accessed within class 'User'");
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("validates readonly and abstract class member semantics", () => {
    const source = `abstract class Base {
  public readonly id: string
  abstract run(): void
  constructor() {
    this.id = "init"
  }
  rename() {
    this.id = "next"
  }
}
class Bad {
  abstract missing(): void
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Cannot assign to readonly member 'id'");
    expect(messages).toContain("Abstract member 'missing' can only appear within an abstract class");
    expect(messages).not.toContain("Class method 'run' must have a body");
  });

  it("validates override usage and compatibility against base members", () => {
    const source = `class Base {
  value: string
  read(v: int): string {
  }
}
class Child extends Base {
  override value: string
  override read(v: int): string {
  }
}
class NoBase {
  override name: string
}
class Wrong extends Base {
  override missing: int
  override read(v: string): string {
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Child"))).toBe(false);
    expect(messages).toContain(
      "Member 'name' cannot use 'override' because class 'NoBase' does not extend another class"
    );
    expect(messages).toContain(
      "Member 'missing' cannot override because no member with that name exists in base type 'Base'"
    );
    expect(messages).toContain(
      "Member 'read' override type '(v: string) => string' does not match base type '(v: int) => string'"
    );
  });

  it("reports class method signatures without body as semantic errors", () => {
    const source = `class Demo {
  say(): number
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Class method 'say' must have a body");
    expect(messages.some((message) => message.includes("Expected '{' to start class method body"))).toBe(false);
  });

  it("attaches missing implements contract errors to class name node", () => {
    const source = `interface Readable {
  say(): number
}
class Map implements Readable {
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const issue = analysis
      .getIssues()
      .find((candidate) => candidate.message.includes("Property 'say' is missing"));

    expect(issue).toBeDefined();
    expect(issue?.node.kind).toBe("Identifier");
    expect((issue?.node as { kind: string; name?: string }).name).toBe("Map");
  });

  it("attaches incompatible implements contract errors to member name node", () => {
    const source = `interface Readable {
  say(): number
}
class Map implements Readable {
  say(): string {
  }
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const issue = analysis
      .getIssues()
      .find((candidate) => candidate.message.includes("incorrectly implements interface"));

    expect(issue).toBeDefined();
    expect(issue?.node.kind).toBe("Identifier");
    expect((issue?.node as { kind: string; name?: string }).name).toBe("say");
  });
  it("checks rest parameters, spread arguments, and optional access types", () => {
    const source = `fun collect(label: string, ...values: int[]): int {
  return values[0]
}
let numbers: int[] = [1, 2, 3]
let moreNumbers = [0, ...numbers]
let ok: int = collect("ok", 1, 2, ...numbers)
let bad = collect("bad", "wrong")
interface MaybeRunner {
  run(): int
}
let maybe: MaybeRunner | undefined
let optionalCall = maybe?.run()
let optionalElement = numbers?.[0]
let badOptional: int = optionalCall
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = symbolsOfVisibleSymbolsAt(source, 12, 3);

    expect(symbols.get("moreNumbers")?.valueType).toBe("int[]");
    expect(symbols.get("optionalCall")?.valueType).toBe("int | undefined");
    expect(symbols.get("optionalElement")?.valueType).toBe("int | undefined");
    expect(messages).toContain("Argument 2 of type 'string' is not assignable to parameter 'values' of type 'int'");
    expect(messages).toContain("Type 'int | undefined' is not assignable to type 'int'");
  });

  it("supports variadic runtime Console methods", () => {
    const source = `console.log(42, 10, "ok")
console.error("boom", 1)
console.warn()
console.info(true, false)
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("requires rest parameters to use array types", () => {
    const source = `declare class Console {
  log(...a: any)
}
fun collect(...values: string) {
}
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Rest parameter 'a' must have an array type");
    expect(messages).toContain("Rest parameter 'values' must have an array type");
  });

  it("binds every identifier introduced by nested destructuring declarations", () => {
    const source = "let { id, name: displayName, nested: { value = 1 }, ...rest } = source\n" +
      "const [first, , third = 3, ...tail] = values\n" +
      "displayName; value; rest; first; third; tail\n" +
      "first = 4";
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((issue) => issue.message);

    for (const name of ["id", "displayName", "value", "rest", "first", "third", "tail"]) {
      expect(messages).not.toContain(`Undefined variable '${name}'`);
    }
    expect(messages).toContain("Cannot assign to 'first' because it is a constant");
  });

});


describe("enum semantic analysis", () => {
  it("binds enum declarations and resolves enum member access", () => {
    const source = "enum Direction { Up, Down }\nlet direction: Direction = Direction.Up\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    const visible = symbolsOfVisibleSymbolsAt(source, 1, 4);
    expect(visible.get("Direction")?.valueType).toBe("Direction");
  });

  it("reports unknown enum members and invalid initializer types", () => {
    const ast = parseFile(tokenizeReader('enum Direction { Up = true }\nlet value = Direction.Missing'));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Enum member 'Up' initializer must be assignable to int or string");
    expect(messages).toContain("Property 'Missing' does not exist on type 'Direction'");
  });
  it("resolves unqualified members inside classes and extension members", () => {
    const source = `class Counter(val value: int) {
  increment(amount: int): int { return value + amount }
}
fun Counter.doubled(): int { return value + value }
val Counter.next => increment(1)
`;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("checks extension properties only when declared or imported", () => {
    const missing = new Analysis(parseFile(tokenizeReader("val duration = 10.milliseconds")));
    expect(missing.getIssues().map((issue) => issue.message)).toContain(
      "Property 'milliseconds' does not exist on type 'int'"
    );

    const local = new Analysis(parseFile(tokenizeReader(
      "class Duration(val value: number)\nval number.milliseconds => Duration(this)\nval duration = 10.milliseconds"
    )));
    expect(local.getIssues()).toEqual([]);

    const imported = new Analysis(parseFile(tokenizeReader(
      'import { milliseconds } from "./duration"\nval duration = 10.milliseconds'
    )));
    expect(imported.getIssues()).toEqual([]);
  });

  it("checks explicit type annotations on extension properties", () => {
    const ok = new Analysis(parseFile(tokenizeReader(
      "class Duration(val value: number)\n" +
      "val number.milliseconds: Duration => Duration(this)\n" +
      "val duration: Duration = 10.milliseconds"
    )));
    expect(ok.getIssues()).toEqual([]);

    const mismatch = new Analysis(parseFile(tokenizeReader(
      "class Duration(val value: number)\n" +
      "val number.milliseconds: Duration => this"
    )));
    expect(mismatch.getIssues().map((issue) => issue.message)).toContain(
      "Type 'number' is not assignable to type 'Duration'"
    );
  });

  it("infers number for mixed int and number multiplication", () => {
    const source = `let a: number = 1
let b: int = 2
let leftMixed = a * b
let rightMixed = b * a
`;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const symbols = new Map(analysis.getVisibleSymbolsAt(3, 0).map((symbol) => [symbol.name, symbol]));

    expect(analysis.getIssues()).toEqual([]);
    expect(symbols.get("leftMixed")?.valueType).toBe("number");
    expect(symbols.get("rightMixed")?.valueType).toBe("number");
  });


  it("contextually interprets ambiguous brace arguments as lambdas or object literals", () => {
    const source = `interface Options { it: int }
declare function transform(fn: (value: int) => int): int
declare function consume(options: Options): int
let it = 4
let doubled = transform({ it })
let incremented = transform({ value -> value + 1 })
let consumed = consume({ it })
`;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("smart-casts identifiers in if and else branches for type and range checks", () => {
    const source = `class Cat { meow(): int { return 1 } }
class Dog { bark(): int { return 2 } }
fun speak(value: Cat | Dog) {
  if (value is Cat) { value.meow() } else { value.bark() }
  if (value instanceof Dog) { value.bark() } else { value.meow() }
}
fun classify(value: string | int) {
  if (value in 0 ... 10) { let numberValue: int = value } else { let textValue: string = value }
}
`;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

});

describe("destructured parameter analysis", () => {
  it("binds every identifier introduced by nested parameter patterns", () => {
    const source = "function unpack({ id, nested: { value = 1 }, ...meta }, [first, , ...tail]) { return id + value + first; meta; tail }";
    const messages = new Analysis(parseFile(tokenizeReader(source))).getIssues().map((issue) => issue.message);
    for (const name of ["id", "value", "meta", "first", "tail"]) {
      expect(messages).not.toContain(`Undefined variable '${name}'`);
    }
  });
});
