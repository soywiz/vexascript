import { describe, expect, it } from "vitest";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems
} from "./completion";

describe("createCompletionItemsForPosition", () => {
  it("includes in-scope variables and parameters inside function body", () => {
    const source =
      "let top = 1\n" +
      "fun demo(a, b: int) {\n" +
      "  let inner = a\n" +
      "  return inner\n" +
      "}\n";
    const ast = parseFile(tokenizeReader(source));
    const items = createCompletionItemsForPosition(ast, 3, 3);
    const labels = items.map((item) => item.label);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(labels).toContain("a");
    expect(labels).toContain("b");
    expect(labels).toContain("inner");
    expect(labels).toContain("top");
    expect(labels).toContain("demo");
    expect(byLabel.get("top")?.detail).toBe("In-scope variable: int");
    expect(byLabel.get("inner")?.detail).toBe("In-scope variable: unknown");
    expect(byLabel.get("b")?.detail).toBe("In-scope parameter: int");
    expect(byLabel.get("demo")?.detail).toBe("In-scope function: (a: unknown, b: int) => unknown");
  });

  it("keeps keyword completions available", () => {
    const labels = createKeywordOnlyCompletionItems().map((item) => item.label);
    expect(labels).toContain("fn");
    expect(labels).toContain("type");
    expect(labels).toContain("interface");
    expect(labels).toContain("int");
    expect(labels).toContain("number");
    expect(labels).toContain("string");
    expect(labels).toContain("boolean");
  });

  it("includes auto-import completion items with additional text edits", () => {
    const source = "fun demo() {\n  return Poi\n}\n";
    const ast = parseFile(tokenizeReader(source));
    const items = createCompletionItemsForPosition(
      ast,
      1,
      12,
      undefined,
      [
        {
          symbol: { name: "Point", filePath: "/tmp/a.my", kind: "class" },
          importPath: "./a",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          }
        }
      ]
    );
    const point = items.find((item) => item.label === "Point");

    expect(point).toBeDefined();
    expect(point?.detail).toBe("Auto import from ./a");
    expect(point?.additionalTextEdits?.[0]?.newText).toBe(
      "import { Point } from \"./a\"\n"
    );
  });
});
