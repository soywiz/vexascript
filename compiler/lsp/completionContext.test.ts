import { describe, expect, it } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import {
  annotationCompletionItems,
  annotationPrefixAtPosition,
  shouldSuppressExistingSymbolCompletions
} from "./completionContext";

describe("completionContext", () => {
  it("detects annotation prefixes at the cursor", () => {
    const { source, line, character } = sourceWithCursor("@Loc^^^");
    expect(annotationPrefixAtPosition(source, line, character)).toBe("Loc");
  });

  it("builds annotation completion items with parameter hints for parameterized annotations", () => {
    const source = dedent`
      annotation DemoTag(val value: string)
      annotation Marker
    `;
    const ast = parseFile(tokenizeReader(source));
    const byLabel = new Map(annotationCompletionItems(ast, "").map((item) => [item.label, item]));

    expect(byLabel.get("DemoTag")?.insertText).toBe("DemoTag($1)");
    expect(byLabel.get("DemoTag")?.command).toEqual({
      title: "Trigger parameter hints",
      command: "editor.action.triggerParameterHints"
    });
    expect(byLabel.get("Marker")?.insertText).toBe("Marker");
  });

  it("suppresses existing symbol completions while typing declaration names", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(): number => 1
      fun de^^^m()
    `);
    const ast = parseFile(tokenizeReader(source));

    expect(shouldSuppressExistingSymbolCompletions(ast, line, character, source)).toBe(true);
  });

  it("does not suppress existing symbol completions in ordinary expression positions", () => {
    const { source, line, character } = sourceWithCursor(dedent`
      fun demo(): number => 1
      fun run() {
        de^^^m
      }
    `);
    const ast = parseFile(tokenizeReader(source));

    expect(shouldSuppressExistingSymbolCompletions(ast, line, character, source)).toBe(false);
  });
});
