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
      "Unknown type 'MissingType'. Expected builtin type (int, number, string, boolean, bigint, long) or declared class/interface"
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
});
