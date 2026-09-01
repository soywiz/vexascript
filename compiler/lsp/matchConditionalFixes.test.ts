import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { sourceWithCursor } from "../test/sourceWithCursor";
import { createAnalysisSession } from "./analysisSession";
import { createMatchConditionalCodeActions } from "./matchConditionalFixes";

const URI = "file:///demo.vx";

function positionToOffset(text: string, position: { line: number; character: number }): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line && lineStart <= text.length) {
    const nextBreak = text.indexOf("\n", lineStart);
    if (nextBreak < 0) {
      return text.length;
    }
    line += 1;
    lineStart = nextBreak + 1;
  }
  return Math.min(text.length, lineStart + position.character);
}

function applyFirstEdit(
  text: string,
  action: ReturnType<typeof createMatchConditionalCodeActions>[number] | undefined
): string {
  const edit = action?.edit?.changes?.[URI]?.[0];
  if (!edit) {
    throw new Error("Expected code action edit");
  }
  const start = positionToOffset(text, edit.range.start);
  const end = positionToOffset(text, edit.range.end);
  return `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
}

function actionsAt(markedSource: string) {
  const cursor = sourceWithCursor(markedSource);
  const session = createAnalysisSession(cursor.source);
  const actions = createMatchConditionalCodeActions({
    uri: URI,
    ast: session.ast,
    text: cursor.source,
    position: { line: cursor.line, character: cursor.character }
  });
  return { source: cursor.source, actions };
}

describe("match and if-chain quick fixes", () => {
  it("converts a repeated equality chain to a subject match", () => {
    const marked = dedent`
      const label = if (value == 1) "one" else if (val^^^ue == 2) "two" else "other"
    `;

    const { source, actions } = actionsAt(marked);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert if chain to subject match");
    expect(applyFirstEdit(source, actions[0])).toBe(dedent`
      const label = match (value) {
        1 -> "one"
        2 -> "two"
        else -> "other"
      }
    `);
  });

  it("converts heterogeneous conditions to a condition match", () => {
    const marked = dedent`
      if (ready) {
        start()
      } else if (retryCount > 0) {
        ret^^^ry()
      } else {
        stop()
      }
    `;

    const { source, actions } = actionsAt(marked);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert if chain to condition match");
    expect(applyFirstEdit(source, actions[0])).toBe(dedent`
      match {
        ready -> {
          start()
        }
        retryCount > 0 -> {
          retry()
        }
        else -> {
          stop()
        }
      }
    `);
  });

  it("keeps different equality subjects in a condition match", () => {
    const marked = 'if (le^^^ft == 1) "left" else if (right == 2) "right" else "none"';

    const { source, actions } = actionsAt(marked);
    const action = actions[0];

    expect(action?.title).toBe("Convert if chain to condition match");
    expect(applyFirstEdit(source, action)).toBe(dedent`
      match {
        left == 1 -> "left"
        right == 2 -> "right"
        else -> "none"
      }
    `);
  });

  it("converts a subject match to an if chain using equality and matcher checks", () => {
    const marked = dedent`
      const bucket = match (score) {
        >= 10 -> "high"
        ^^^5 -> "five"
        else -> "low"
      }
    `;

    const { source, actions } = actionsAt(marked);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert subject match to if chain");
    expect(applyFirstEdit(source, actions[0])).toBe(
      'const bucket = if (score is >= 10) "high" else if (score == 5) "five" else "low"'
    );
  });

  it("converts a condition match to an if chain", () => {
    const marked = dedent`
      match {
        rea^^^dy -> start()
        retryCount > 0 -> retry()
        else -> stop()
      }
    `;

    const { source, actions } = actionsAt(marked);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Convert condition match to if chain");
    expect(applyFirstEdit(source, actions[0])).toBe(
      "if (ready) start() else if (retryCount > 0) retry() else stop()"
    );
  });

  it("preserves enclosing indentation when replacing a nested chain", () => {
    const marked = dedent`
      fun choose(value: int): string {
        return if (value == 1) {
          "one"
        } else if (value == 2) {
          "t^^^wo"
        } else {
          "other"
        }
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actions[0];

    expect(applyFirstEdit(source, action)).toBe(dedent`
      fun choose(value: int): string {
        return match (value) {
          1 -> {
            "one"
          }
          2 -> {
            "two"
          }
          else -> {
            "other"
          }
        }
      }
    `);
  });

  it("does not offer an if-chain conversion without else-if and else branches", () => {
    const marked = 'if (rea^^^dy) "yes" else "no"';

    expect(actionsAt(marked).actions).toEqual([]);
  });

  it("does not offer a reverse conversion for subject bindings", () => {
    const marked = dedent`
      match (value) {
        { payload: val pay^^^load } -> payload
        else -> null
      }
    `;

    expect(actionsAt(marked).actions).toEqual([]);
  });

  it("does not repeat the evaluation of a complex match subject", () => {
    const marked = dedent`
      match (readValue()) {
        ^^^1 -> "one"
        else -> "other"
      }
    `;

    expect(actionsAt(marked).actions).toEqual([]);
  });
});
