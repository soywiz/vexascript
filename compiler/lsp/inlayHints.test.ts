import { describe, expect, it } from "vitest";
import { createAnalysisSession } from "./analysisSession";
import { createInlayHints } from "./inlayHints";

describe("inlay hints", () => {
  it("provides inferred type hints and parameter name hints", () => {
    const source =
      "fun sum(a: int, b: int): int {\n" +
      "  return a + b\n" +
      "}\n" +
      "fun demo() {\n" +
      "  val total = 1 + 2\n" +
      "  sum(1, 2)\n" +
      "}\n";

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain(": int");
    expect(labels).toContain("a: ");
    expect(labels).toContain("b: ");
  });

  it("provides constructor parameter name hints for new expressions", () => {
    const source =
      "class Point(val x: int, val y: int)\n" +
      "fun demo() {\n" +
      "  const point = new Point(1, 2)\n" +
      "}\n";

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain("x: ");
    expect(labels).toContain("y: ");
  });
});
