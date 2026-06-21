import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createAutoAwaitDecorations } from "./autoAwaitDecorations";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { parseSource } from "compiler/pipeline/parse";

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

  it("anchors chained implicit awaits to the line of the chained member call", () => {
    const source = dedent`
      declare class Fetch { arrayBuffer(): Promise<ArrayBuffer> }
      declare fun fetch(path: string): Promise<Fetch>
      sync fun loadBytes(): Uint8Array {
        val res = fetch("file.bin")
          .arrayBuffer()
        return Uint8Array(res)
      }
      `;

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([3, 4]);
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

  it("anchors explicit multiline await decorations to the await keyword line only", () => {
    const source = dedent`
      async fun readFile(path: string): Promise<string> { return path }
      async fun demo(): Promise<void> {
        console.log(await readFile(
          "hello"
        ))
      }
      `;

    const session = createAnalysisSession(source);
    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);

    expect(decorations).toHaveLength(1);
    expect(decorations[0]!.range.start.line).toBe(2);
    expect(decorations[0]!.range.end.line).toBe(2);
  });

  it("marks implicit awaits of a Promise-returning function imported from another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-auto-await-"));
    const depFile = join(root, "dep.vx");
    const mainFile = join(root, "main.vx");

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
    const importedSymbols = (await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root]
    })).importedSymbols;
    const session = createAnalysisSession(mainSource, { importedSymbols: importedSymbols });

    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);
    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([2, 3]);
    expect(decorations[0]!.message).toContain("Implicit await");
  });

  it("marks implicit awaits for a workspace-style imported delay helper using ambient runtime declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-auto-await-workspace-"));
    const depFile = join(root, "time.vx");
    const mainFile = join(root, "main.vx");

    const ambientRuntimeSource = dedent`
      declare class Promise<T> {
        constructor(executor: ((arg1: T) => void, (reason: any) => void) => void)
      }
      declare type TimerHandler = ((value: any) => void) | string
      declare fun setTimeout(handler: TimerHandler, timeout?: number): number
    `;
    const parsedAmbientRuntime = parseSource(ambientRuntimeSource);
    expect(parsedAmbientRuntime.ast).toBeTruthy();
    const ambientDeclarations = parsedAmbientRuntime.ast!.body;

    const depSource = dedent`
      class TimeSpan(val ms: number)
      val number.seconds => TimeSpan(this * 1000.0)
      val number.milliseconds => TimeSpan(this)

      fun delay(time: TimeSpan) {
        return new Promise { resolve, reject ->
          setTimeout(resolve, time.ms)
        }
      }
    `;
    const mainSource = dedent`
      import { delay, seconds, milliseconds, TimeSpan } from "./time"

      sync fun demo() {
        delay(1.seconds)
        delay(250.milliseconds)
        console.log(TimeSpan(500.0).ms)
      }
    `;

    await writeFile(depFile, depSource, "utf8");
    await writeFile(mainFile, mainSource, "utf8");

    const baseSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
    const importedSymbols = (await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainFile).toString(),
      sourceRoots: [root],
      getSessionForFilePath: async (filePath) => {
        if (filePath !== depFile) {
          return null;
        }
        return createAnalysisSession(depSource, { ambientDeclarations: ambientDeclarations });
      },
    })).importedSymbols;
    const session = createAnalysisSession(mainSource, { importedSymbols: importedSymbols, ambientDeclarations: ambientDeclarations });

    const decorations = createAutoAwaitDecorations(session.ast!, session.analysis!);
    expect(decorations.map((decoration) => decoration.range.start.line)).toEqual([3, 4]);
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
