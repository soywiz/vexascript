import { describe, it } from "node:test";
import dedent from "compiler/utils/dedent";
import { expect } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import {
  createAssignVariableCodeActions,
  SELECT_CODE_ACTION_RANGE_COMMAND
} from "./assignVariableFixes";
import { sourceWithCursor } from "../test/sourceWithCursor";

const URI = "file:///demo.vx";

describe("assign variable quick fix", () => {
  it("offers a quick fix for a bare expression statement", () => {
    const cursor = sourceWithCursor(dedent`
      join^^^("hello", "world")
    `);
    const session = createAnalysisSession(cursor.source);
    const actions = createAssignVariableCodeActions({
      uri: URI,
      ast: session.ast,
      text: cursor.source,
      position: { line: cursor.line, character: cursor.character }
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Assign to variable");
    expect(actions[0]?.edit?.changes?.[URI]?.[0]?.newText).toBe('val variable = join("hello", "world")');
    expect(actions[0]?.command).toEqual({
      title: "Select variable name",
      command: SELECT_CODE_ACTION_RANGE_COMMAND,
      arguments: [
        URI,
        {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 12 }
        }
      ]
    });
  });

  it("does not offer the quick fix for assignment expressions", () => {
    const cursor = sourceWithCursor(dedent`
      value ^^^= readFile("demo.txt")
    `);
    const session = createAnalysisSession(cursor.source);
    const actions = createAssignVariableCodeActions({
      uri: URI,
      ast: session.ast,
      text: cursor.source,
      position: { line: cursor.line, character: cursor.character }
    });

    expect(actions).toHaveLength(0);
  });
});
