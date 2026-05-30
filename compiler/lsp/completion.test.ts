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
      "fun demo(a, b) {\n" +
      "  let inner = a\n" +
      "  return inner\n" +
      "}\n";
    const ast = parseFile(tokenizeReader(source));
    const labels = createCompletionItemsForPosition(ast, 3, 3).map((item) => item.label);

    expect(labels).toContain("a");
    expect(labels).toContain("b");
    expect(labels).toContain("inner");
    expect(labels).toContain("top");
    expect(labels).toContain("demo");
  });

  it("keeps keyword completions available", () => {
    const labels = createKeywordOnlyCompletionItems().map((item) => item.label);
    expect(labels).toContain("fn");
    expect(labels).toContain("type");
    expect(labels).toContain("interface");
  });
});
