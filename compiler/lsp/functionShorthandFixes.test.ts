import { describe, it } from "node:test";
import { expect } from "../../expect";
import { createAnalysisSession } from "./analysisSession";
import { createFunctionShorthandCodeActions } from "./functionShorthandFixes";

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

function applyEdit(
  text: string,
  edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }
): string {
  const start = positionToOffset(text, edit.range.start);
  const end = positionToOffset(text, edit.range.end);
  return `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
}

describe("function shorthand quick fixes", () => {
  it("converts a single-return class method to '=>' shorthand", () => {
    const source =
      "class Point {\n" +
      "  operator*(other: Point): Point {\n" +
      "    return Point(x * other.x, y * other.y)\n" +
      "  }\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const actions = createFunctionShorthandCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 2, character: 6 }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert single-return body to '=>' shorthand");
    const edit = actions[0]?.edit?.changes?.[URI]?.[0];
    expect(edit?.newText).toBe(" => Point(x * other.x, y * other.y)");
    expect(edit ? applyEdit(source, edit) : source).toBe(
      "class Point {\n" +
        "  operator*(other: Point) => Point(x * other.x, y * other.y)\n" +
        "}\n"
    );
  });

  it("converts a single-return function declaration to '=>' shorthand", () => {
    const source =
      "fun demo(value: int): int {\n" +
      "  return value + 1\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const actions = createFunctionShorthandCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 1, character: 4 }
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[URI]?.[0];
    expect(edit?.newText).toBe(" => value + 1");
    expect(edit ? applyEdit(source, edit) : source).toBe("fun demo(value: int) => value + 1\n");
  });

  it("converts '=>' shorthand back to a full body with return", () => {
    const source =
      "class Point {\n" +
      "  operator*(other: Point): Point => Point(x * other.x, y * other.y)\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const actions = createFunctionShorthandCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 1, character: 34 }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert '=>' shorthand to full body");
    const edit = actions[0]?.edit?.changes?.[URI]?.[0];
    expect(edit ? applyEdit(source, edit) : source).toBe(
      "class Point {\n" +
        "  operator*(other: Point): Point {\n" +
        "    return Point(x * other.x, y * other.y)\n" +
        "  }\n" +
        "}\n"
    );
  });

  it("does not offer shorthand when the body has more than one statement", () => {
    const source =
      "fun demo() {\n" +
      "  let value = 1\n" +
      "  return value\n" +
      "}\n";

    const session = createAnalysisSession(source);
    const actions = createFunctionShorthandCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 2, character: 4 }
    });

    expect(actions).toEqual([]);
  });
});
