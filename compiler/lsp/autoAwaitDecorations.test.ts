import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";
import { collectImportedSymbolTypes } from "./importedDeclarations";

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

  it("does not auto-await inside an async function (async behaves like TypeScript)", () => {
    const source =
      "async fun fetchValue(): Promise<int> { return 1 }\n" +
      "async fun main(): Promise<void> {\n" +
      "  let x = fetchValue()\n" +
      "  fetchValue()\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!, {
      start: { line: 0, character: 0 },
      end: { line: 20, character: 0 }
    });

    // Auto-await is a `sync`-only feature; `async` requires explicit `await`.
    expect(decorations).toEqual([]);
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

  it("marks implicit awaits of a Promise-returning function imported from another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-auto-await-"));
    const depFile = join(root, "dep.my");
    const mainFile = join(root, "main.my");

    // The imported `delay` has no return type annotation; its Promise return
    // type is inferred from its body in the dependency's own analysis.
    const depSource =
      "class TimeSpan(val ms: number) {}\n" +
      "val number.seconds => TimeSpan(this * 1000.0)\n" +
      "fun delay(time: TimeSpan) => new Promise((resolve, reject) => { setTimeout(resolve, time.ms) })\n";
    const mainSource =
      "import { delay, seconds } from \"./dep\"\n" +
      "sync fun demo() {\n" +
      "  delay(1.seconds)\n" +
      "  delay(2.seconds)\n" +
      "}\n";

    await writeFile(depFile, depSource, "utf8");
    await writeFile(mainFile, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource);
    const importedSymbolTypes = await collectImportedSymbolTypes(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(mainSource, [], importedSymbolTypes);

    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);
    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([2, 3]);
    expect(decorations[0]!.message).toContain("Implicit await");
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
