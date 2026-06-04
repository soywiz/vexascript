import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { createInlayHints } from "./inlayHints";

describe("inlay hints", () => {
  it("provides inferred type hints and parameter name hints", () => {
    const source =
      "class Box {\n" +
      "  fun size(a: int) {\n" +
      "    return 1\n" +
      "  }\n" +
      "}\n" +
      "fun sum(a: int, b: int) {\n" +
      "  return a + b\n" +
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
    const returnHints = hints.filter((hint) => hint.label === ": int");
    const lines = source.split("\n");

    expect(labels).toContain(": int");
    expect(returnHints).toContainEqual(
      expect.objectContaining({
        position: {
          line: 5,
          character: lines[5]!.indexOf(")") + 1
        }
      })
    );
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
