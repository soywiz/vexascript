import { describe, expect, it } from "vitest";
import { createAnalysisSession } from "./analysisSession";
import { createSignatureHelp } from "./signatureHelp";

describe("signature help", () => {
  it("provides function signature and active parameter index", () => {
    const source =
      "fun sum(a: int, b: int): int {\n" +
      "  return a + b\n" +
      "}\n" +
      "fun demo() {\n" +
      "  return sum(1, 2)\n" +
      "}\n";

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 4, 15);
    expect(help).toEqual({
      signatures: [
        {
          label: "sum(a: int, b: int)",
          parameters: [{ label: "a: int" }, { label: "b: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("provides constructor signature for new expressions", () => {
    const source =
      "class Point(val x: int, val y: int)\n" +
      "fun demo() {\n" +
      "  return new Point(1, 2)\n" +
      "}\n";

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const help = createSignatureHelp(session.ast!, session.analysis!, 2, 22);
    expect(help).toEqual({
      signatures: [
        {
          label: "new Point(x: int, y: int)",
          parameters: [{ label: "x: int" }, { label: "y: int" }]
        }
      ],
      activeSignature: 0,
      activeParameter: 1
    });
  });

  it("returns null when cursor is outside invocation", () => {
    const source = "fun demo() {\n  let value = 1\n}\n";
    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    expect(createSignatureHelp(session.ast!, session.analysis!, 1, 6)).toBeNull();
  });
});
