import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createStringTemplateCodeActions } from "./stringTemplateFixes";

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

function applyEdit(
  text: string,
  edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }
): string {
  const start = positionToOffset(text, edit.range.start);
  const end = positionToOffset(text, edit.range.end);
  return `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
}

describe("string template quick fixes", () => {
  it("converts string concatenation chains into template literals", () => {
    const source = dedent`
      class Rectangle {
        describe() {
          return "Rectangle(" + this.width + "x" + this.height + ")"
        }
      }
      `;

    const session = createAnalysisSession(source);
    const actions = createStringTemplateCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 2, character: 33 }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert string concatenation to template literal");
    const edit = actions[0]?.edit?.changes?.[URI]?.[0];
    expect(edit?.newText).toBe("`Rectangle(${this.width}x${this.height})`");
    expect(edit ? applyEdit(source, edit) : source).toBe(dedent`
      class Rectangle {
        describe() {
          return \`Rectangle(\${this.width}x\${this.height})\`
        }
      }
      `
    );
  });

  it("escapes template-sensitive characters from string segments", () => {
    const source = "let label = \"a`\" + value + \"${b}\"\n";
    const session = createAnalysisSession(source);
    const actions = createStringTemplateCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 21 }
    });

    const edit = actions[0]?.edit?.changes?.[URI]?.[0];
    expect(edit?.newText).toBe("`a\\`${value}\\${b}`");
  });

  it("does not offer the fix for numeric addition", () => {
    const source = "let total = width + height\n";
    const session = createAnalysisSession(source);
    const actions = createStringTemplateCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      position: { line: 0, character: 18 }
    });

    expect(actions).toEqual([]);
  });
});
