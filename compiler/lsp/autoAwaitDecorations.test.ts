import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";

describe("auto-await decorations", () => {
  it("marks lines where a Promise is implicitly awaited inside a sync function", () => {
    const source =
      "async fun fetchValue(): Promise<int> { return 1 }\n" +
      "sync fun main(): void {\n" +
      "  let x = fetchValue()\n" +
      "  fetchValue()\n" +
      "}\n";

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!, {
      start: { line: 0, character: 0 },
      end: { line: 20, character: 0 }
    });

    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([2, 3]);
    expect(decorations[0]!.message).toContain("Implicit await");
  });

  it("emits a single decoration per line even with multiple auto-awaited expressions", () => {
    const source =
      "declare function use(a: int, b: int): void\n" +
      "async fun fetchValue(): Promise<int> { return 1 }\n" +
      "sync fun main(): void {\n" +
      "  use(fetchValue(), fetchValue())\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    expect(decorations.length).toBe(1);
    expect(decorations[0]!.range.start.line).toBe(3);
  });

  it("does not mark go-protected expressions, local references, or non-sync functions", () => {
    const source =
      "async fun fetchValue(): Promise<int> { return 1 }\n" +
      "sync fun main(): void {\n" +
      "  let stored = go fetchValue()\n" +
      "  let alias = stored\n" +
      "}\n" +
      "async fun other(): void {\n" +
      "  let y = fetchValue()\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    expect(decorations).toEqual([]);
  });

  it("restricts decorations to the requested range", () => {
    const source =
      "async fun fetchValue(): Promise<int> { return 1 }\n" +
      "sync fun main(): void {\n" +
      "  fetchValue()\n" +
      "  fetchValue()\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!, {
      start: { line: 3, character: 0 },
      end: { line: 3, character: 0 }
    });

    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([3]);
  });
});
