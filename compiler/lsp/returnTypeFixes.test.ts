import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { createReturnTypeCodeActions } from "./returnTypeFixes";

const URI = "file:///demo.my";

function positionToOffset(text: string, position: { line: number; character: number }): number {
  let line = 0;
  let character = 0;

  for (let offset = 0; offset < text.length; offset += 1) {
    if (line === position.line && character === position.character) {
      return offset;
    }

    if (text[offset] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }

  return text.length;
}

function applyEdits(
  text: string,
  edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]
): string {
  const ordered = [...edits].sort((a, b) => positionToOffset(text, b.range.start) - positionToOffset(text, a.range.start));
  let result = text;
  for (const edit of ordered) {
    const start = positionToOffset(result, edit.range.start);
    const end = positionToOffset(result, edit.range.end);
    result = `${result.slice(0, start)}${edit.newText}${result.slice(end)}`;
  }
  return result;
}

describe("explicit return type quick fixes", () => {
  it("adds an inferred return type to a function declaration", async () => {
    const source = "function add(a: number, b: number) {\n  return a + b\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 0, character: 34 }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Add explicit return type ': number'");
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe(
      "function add(a: number, b: number): number {\n  return a + b\n}\n"
    );
  });

  it("offers the fix while the cursor is inside the parameter list", async () => {
    const source = "function add(a: number, b: number) {\n  return a + b\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 0, character: 15 }
    });

    expect(actions).toHaveLength(1);
  });

  it("wraps the inferred type in Promise for async functions", async () => {
    const source = "async function load() {\n  return 1\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 0, character: 21 }
    });

    expect(actions).toHaveLength(1);
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe(
      "async function load(): Promise<int> {\n  return 1\n}\n"
    );
  });

  it("adds a return type to a class method", async () => {
    const source = "class C {\n  greet() {\n    return \"hi\"\n  }\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 1, character: 9 }
    });

    expect(actions).toHaveLength(1);
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe(
      "class C {\n  greet(): string {\n    return \"hi\"\n  }\n}\n"
    );
  });

  it("does not offer the fix when a return type already exists", async () => {
    const source = "function add(a: number, b: number): number {\n  return a + b\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 0, character: 34 }
    });

    expect(actions).toEqual([]);
  });

  it("does not offer the fix when the return type cannot be inferred", async () => {
    const source = "function noop() {\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 0, character: 14 }
    });

    expect(actions).toEqual([]);
  });

  it("does not offer the fix outside the signature header", async () => {
    const source = "function add(a: number, b: number) {\n  return a + b\n}\n";
    const session = createAnalysisSession(source);
    const actions = await createReturnTypeCodeActions({
      uri: URI,
      ast: session.ast,
      analysis: session.analysis,
      position: { line: 1, character: 5 }
    });

    expect(actions).toEqual([]);
  });
});
