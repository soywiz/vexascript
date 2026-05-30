import { describe, expect, it } from "vitest";
import { buildAnalysisForSource } from "./analysisSession";

describe("lsp analysis session", () => {
  it("builds analysis even when parser recovered from syntax errors", () => {
    const source =
      "let = 1\n" +
      "let ok = 1\n" +
      "fun demo() {\n" +
      "  return ok\n" +
      "}\n";

    const analysis = buildAnalysisForSource(source);
    expect(analysis).not.toBeNull();
    expect(analysis?.getDefinitionAt(3, 9)?.symbol.name).toBe("ok");
  });

  it("returns null when source cannot be tokenized", () => {
    const analysis = buildAnalysisForSource("\"unterminated");
    expect(analysis).toBeNull();
  });
});
