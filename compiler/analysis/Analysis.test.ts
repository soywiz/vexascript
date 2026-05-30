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
});
