import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { createEmptyClassBodyCodeActions } from "./emptyClassBodyFixes";

const URI = "file:///demo.vx";

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

describe("empty class body quick fixes", () => {
  it("removes an empty body from a class with a primary constructor", () => {
    const source = "class TimeSpan(val ms: number) {\n}\n";
    const session = createAnalysisSession(source);
    const actions = createEmptyClassBodyCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 8 }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Remove empty class body");
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe("class TimeSpan(val ms: number)\n");
  });

  it("removes an empty inline body", () => {
    const source = "class Empty {}\n";
    const session = createAnalysisSession(source);
    const actions = createEmptyClassBodyCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 6 }
    });

    expect(actions).toHaveLength(1);
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe("class Empty\n");
  });

  it("does not offer the fix when the class has members", () => {
    const source = "class Point {\n  x: number\n}\n";
    const session = createAnalysisSession(source);
    const actions = createEmptyClassBodyCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 6 }
    });

    expect(actions).toEqual([]);
  });

  it("does not offer the fix when the class already has no braces", () => {
    const source = "class Empty\n";
    const session = createAnalysisSession(source);
    const actions = createEmptyClassBodyCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 6 }
    });

    expect(actions).toEqual([]);
  });

  it("preserves a body that contains only a comment", () => {
    const source = "class Empty {\n  // keep me\n}\n";
    const session = createAnalysisSession(source);
    const actions = createEmptyClassBodyCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 6 }
    });

    expect(actions).toEqual([]);
  });
});
