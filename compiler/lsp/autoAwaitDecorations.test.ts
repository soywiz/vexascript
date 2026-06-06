import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";

describe("auto-await decorations", () => {
  it("marks lines where a Promise is implicitly awaited inside a sync function", () => {
    const source = dedent`
      async fun fetchValue(): Promise<int> { return 1 }
      sync fun main(): void {
        let x = fetchValue()
        fetchValue()
      }
      `;

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
    const source = dedent`
      declare function use(a: int, b: int): void
      async fun fetchValue(): Promise<int> { return 1 }
      sync fun main(): void {
        use(fetchValue(), fetchValue())
      }
      `;

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    expect(decorations.length).toBe(1);
    expect(decorations[0]!.range.start.line).toBe(3);
  });

  it("does not mark go-protected expressions, local references, or non-sync functions", () => {
    const source = dedent`
      async fun fetchValue(): Promise<int> { return 1 }
      sync fun main(): void {
        let stored = go fetchValue()
        let alias = stored
      }
      `;

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    expect(decorations).toEqual([]);
  });

  it("marks explicit await expressions in async and sync functions", () => {
    const source = dedent`
      async fun fetchValue(): Promise<int> { return 1 }
      async fun usesAsync(): Promise<int> {
        return await fetchValue()
      }
      sync fun usesSync(): int {
        let pending = go fetchValue()
        return await pending
      }
      `;

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    // Explicit awaits are flagged on lines 2 and 6, even though `go`/local references are not.
    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([2, 6]);
    expect(decorations.every((decoration) => decoration.message.length > 0)).toBe(true);
  });

  it("restricts decorations to the requested range", () => {
    const source = dedent`
      async fun fetchValue(): Promise<int> { return 1 }
      sync fun main(): void {
        fetchValue()
        fetchValue()
      }
      `;

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!, {
      start: { line: 3, character: 0 },
      end: { line: 3, character: 0 }
    });

    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([3]);
  });
});
