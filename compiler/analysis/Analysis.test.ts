import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "./Analysis";

function namesOfVisibleSymbolsAt(source: string, line: number, character: number): string[] {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return analysis.getVisibleSymbolsAt(line, character).map((symbol) => symbol.name).sort();
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
});
