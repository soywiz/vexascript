import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { createTrailingLambdaCodeActions } from "./trailingLambdaFixes";

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

describe("trailing lambda quick fixes", () => {
  it("moves a sole lambda argument out of the parentheses", () => {
    const source = "const result = run({ resolve, reject -> resolve(1) })\n";
    const session = createAnalysisSession(source);
    const actions = createTrailingLambdaCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 25 }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Move lambda out of the call parentheses");
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe("const result = run { resolve, reject -> resolve(1) }\n");
  });

  it("moves a lambda out of a new expression with a sole argument", () => {
    const source = "const p = new Promise({ resolve, reject -> resolve(1) })\n";
    const session = createAnalysisSession(source);
    const actions = createTrailingLambdaCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 30 }
    });

    expect(actions).toHaveLength(1);
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe("const p = new Promise { resolve, reject -> resolve(1) }\n");
  });

  it("keeps the remaining arguments inside the parentheses", () => {
    const source = "demo(1, 2, { a, b -> a + b })\n";
    const session = createAnalysisSession(source);
    const actions = createTrailingLambdaCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 14 }
    });

    expect(actions).toHaveLength(1);
    const edits = actions[0]?.edit?.changes?.[URI] ?? [];
    expect(applyEdits(source, edits)).toBe("demo(1, 2) { a, b -> a + b }\n");
  });

  it("does not offer the fix when the lambda is already trailing", () => {
    const source = "demo(1, 2) { a, b -> a + b }\n";
    const session = createAnalysisSession(source);
    const actions = createTrailingLambdaCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 14 }
    });

    expect(actions).toEqual([]);
  });

  it("does not offer the fix for a non-lambda last argument", () => {
    const source = "demo(1, 2, 3)\n";
    const session = createAnalysisSession(source);
    const actions = createTrailingLambdaCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 6 }
    });

    expect(actions).toEqual([]);
  });
});
