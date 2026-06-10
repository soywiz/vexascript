import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { collectCrossFileTypeDiagnostics } from "./crossFileTypeDiagnostics";
import { createTypeFixCodeActions } from "./typeFixes";

function positionAt(source: string, offset: number): { line: number; character: number } {
  const lines = source.slice(0, offset).split("\n");
  const line = Math.max(0, lines.length - 1);
  const character = (lines[line] ?? "").length;
  return { line, character };
}

function collectSameFileDiagnostics(source: string, session: ReturnType<typeof createAnalysisSession>) {
  return collectDiagnosticsFromSession(session, source, (offset) => positionAt(source, offset));
}

function rangeForText(source: string, text: string) {
  const startOffset = source.indexOf(text);
  if (startOffset < 0) {
    throw new Error(`Text not found: ${text}`);
  }
  return {
    start: positionAt(source, startOffset),
    end: positionAt(source, startOffset + text.length)
  };
}

describe("type quick fixes", () => {
  it("returns no actions when parsing or analysis artifacts are unavailable", async () => {
    const actionsWithoutAst = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: null,
      analysis: createAnalysisSession("const value = 1\n").analysis,
      diagnostics: [],
      sourceRoots: ["/tmp"]
    });
    const actionsWithoutAnalysis = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: createAnalysisSession("const value = 1\n").ast,
      analysis: null,
      diagnostics: [],
      sourceRoots: ["/tmp"]
    });

    expect(actionsWithoutAst).toEqual([]);
    expect(actionsWithoutAnalysis).toEqual([]);
  });

  it("adds a missing same-file field type from an assignment mismatch", async () => {
    const source = `class Point {
  y = 1
}
fun demo() {
  const point = new Point()
  point.y = "test"
}
`;
    const session = createAnalysisSession(source);
    const diagnostics = collectSameFileDiagnostics(source, session);

    const actions = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: ["/tmp"]
    });

    expect(actions.length).toBeGreaterThan(0);
    const edit = actions[0]?.edit?.changes?.["file:///tmp/main.vx"]?.[0];
    expect(edit?.newText).toBe(": string");
    expect(edit?.range).toEqual({
      start: { line: 1, character: 3 },
      end: { line: 1, character: 3 }
    });
    expect(actions[0]?.title).toBe("Change type of 'Point.y: unknown' to 'string'");
  });

  it("ignores type mismatch diagnostics that are not assignable member writes", async () => {
    const source = `fun takesInt(value: int) {}
takesInt("test")
`;
    const session = createAnalysisSession(source);
    const diagnostics = collectSameFileDiagnostics(source, session);

    const actions = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: ["/tmp"]
    });

    expect(actions).toEqual([]);
  });

  it("deduplicates repeated diagnostics for the same member edit", async () => {
    const source = `class Point {
  y = 1
}
fun demo() {
  const point = new Point()
  point.y = "test"
}
`;
    const session = createAnalysisSession(source);
    const diagnostics = collectSameFileDiagnostics(source, session);

    const actions = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: session.ast,
      analysis: session.analysis,
      diagnostics: [...diagnostics, ...diagnostics],
      sourceRoots: ["/tmp"]
    });

    expect(actions.length).toBe(1);
  });

  it("ignores computed member writes and unknown-source mismatches", async () => {
    const computedSource = `class Point {
  y = 1
}
fun demo() {
  const point = new Point()
  point["y"] = "test"
}
`;
    const computedSession = createAnalysisSession(computedSource);
    const computedActions = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: computedSession.ast,
      analysis: computedSession.analysis,
      diagnostics: [
        {
          source: "vexa-sema",
          message: "Type 'string' is not assignable to type 'int'",
          range: rangeForText(computedSource, "\"test\"")
        }
      ],
      sourceRoots: ["/tmp"]
    });

    const unknownSource = `class Point {
  y = 1
}
fun demo() {
  const point = new Point()
  point.y = mystery
}
`;
    const unknownSession = createAnalysisSession(unknownSource);
    const unknownActions = await createTypeFixCodeActions({
      uri: "file:///tmp/main.vx",
      ast: unknownSession.ast,
      analysis: unknownSession.analysis,
      diagnostics: [
        {
          source: "vexa-sema",
          message: "Type 'unknown' is not assignable to type 'int'",
          range: rangeForText(unknownSource, "mystery")
        }
      ],
      sourceRoots: ["/tmp"]
    });

    expect(computedActions).toEqual([]);
    expect(unknownActions).toEqual([]);
  });

  it("changes member type in imported class from assignment mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-type-fix-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class Point(val y: int)
`;
    const helloSource = `import { Point } from "./world"
fun demo() {
  const point = new Point(1)
  point.y = "test"
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = [
      ...collectSameFileDiagnostics(helloSource, session),
      ...await collectCrossFileTypeDiagnostics({
        uri: pathToFileURL(helloFile).toString(),
        session,
        sourceRoots: [root]
      })
    ];

    const actions = await createTypeFixCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: [root],
      getSessionForFilePath: () => null,
      commandName: "vexa.refreshDiagnostics"
    });

    expect(actions.length).toBeGreaterThan(0);
    const worldUri = pathToFileURL(worldFile).toString();
    const editText = actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText;
    expect(editText).toBe("string");
    expect(actions[0]?.title).toBe("Change type of 'Point.y: int' to 'string'");
    expect(actions[0]?.command?.command).toBe("vexa.refreshDiagnostics");
  });

  it("changes inherited generic member declaration type using specialized mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-type-fix-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class Base<T> {
  value: T
}
class Child extends Base<int> {
}
`;
    const helloSource = `import { Child } from "./world"
fun demo() {
  const child = new Child()
  child.value = "test"
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = [
      ...collectSameFileDiagnostics(helloSource, session),
      ...await collectCrossFileTypeDiagnostics({
        uri: pathToFileURL(helloFile).toString(),
        session,
        sourceRoots: [root]
      })
    ];

    const actions = await createTypeFixCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: [root]
    });

    expect(actions.length).toBeGreaterThan(0);
    const worldUri = pathToFileURL(worldFile).toString();
    const editText = actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText;
    expect(editText).toBe("string");
    expect(actions[0]?.title).toBe("Change type of 'Base.value: int' to 'string'");
  });
});
