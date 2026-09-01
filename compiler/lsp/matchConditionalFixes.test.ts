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

function actionNamed(
  actions: ReturnType<typeof createMatchConditionalCodeActions>,
  title: string
) {
  return actions.find((action) => action.title === title);
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

  it("converts consecutive returning if statements and a final return to a subject match", () => {
    const marked = dedent`
      class Renderer {
        private color(kind: FixtureKind): number {
          if (kind === 'player') return 0xffffff
          if (kind === 'enemy') return 0xff6b6b
          if (kind === 'water') return 0x2f9df4
          return 0x44^^^556f
        }
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Convert if chain to subject match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      class Renderer {
        private color(kind: FixtureKind): number {
          match (kind) {
            'player' -> return 0xffffff
            'enemy' -> return 0xff6b6b
            'water' -> return 0x2f9df4
            else -> return 0x44556f
          }
        }
      }
    `);
  });

  it("uses a subject match for strict-equality else-if chains", () => {
    const marked = dedent`
      if (kind === 'player') return 0xffffff
      else if (kind === 'enemy^^^') return 0xff6b6b
      else return 0x44556f
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Convert if chain to subject match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      match (kind) {
        'player' -> return 0xffffff
        'enemy' -> return 0xff6b6b
        else -> return 0x44556f
      }
    `);
  });

  it("converts a terminating if run without consuming following code", () => {
    const marked = dedent`
      fun handle(): void {
        if (ready) return
        if (failed^^^) return
        finish()
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Convert if chain to condition match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      fun handle(): void {
        match {
          ready -> return
          failed -> return
        }
        finish()
      }
    `);
  });

  it("converts consecutive continue guards inside a loop", () => {
    const marked = dedent`
      for (const item of items) {
        if (item.hidden) {
          log(item)
          continue
        }
        if (item.disabled^^^) continue
        render(item)
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Convert if chain to condition match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      for (const item of items) {
        match {
          item.hidden -> {
            log(item)
            continue
          }
          item.disabled -> continue
        }
        render(item)
      }
    `);
  });

  it("does not combine consecutive if statements when one branch can fall through", () => {
    const marked = dedent`
      if (rea^^^dy) return "ready"
      if (logging) log()
      if (failed) return "failed"
      return "idle"
    `;

    const { actions } = actionsAt(marked);

    expect(actionNamed(actions, "Convert if chain to condition match")).toBeUndefined();
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

  it("moves a return shared by every match arm outside the match", () => {
    const marked = dedent`
      class Renderer {
        private color(kind: FixtureKind): number {
          ma^^^tch {
            kind === 'player' -> return 0xffffff
            kind === 'enemy' -> return 0xff6b6b
            else -> return 0x445566
          }
        }
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Move return outside match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      class Renderer {
        private color(kind: FixtureKind): number {
          return match {
            kind === 'player' -> 0xffffff
            kind === 'enemy' -> 0xff6b6b
            else -> 0x445566
          }
        }
      }
    `);
  });

  it("moves a return outside a subject match with single-statement block arms", () => {
    const marked = dedent`
      fun label(value: int): string {
        match (value) {
          1 -> { ret^^^urn "one" }
          else -> { return "other" }
        }
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Move return outside match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      fun label(value: int): string {
        return match (value) {
          1 -> "one"
          else -> "other"
        }
      }
    `);
  });

  it("moves an assignment to the same stable member outside the match", () => {
    const marked = dedent`
      match {
        ready -> this.st^^^ate = "ready"
        failed -> this.state = "failed"
        else -> this.state = "idle"
      }
    `;

    const { source, actions } = actionsAt(marked);
    const action = actionNamed(actions, "Move assignment outside match");

    expect(action).toBeDefined();
    expect(applyFirstEdit(source, action)).toBe(dedent`
      this.state = match {
        ready -> "ready"
        failed -> "failed"
        else -> "idle"
      }
    `);
  });

  it("does not move branch control flow without a fallback arm", () => {
    const marked = dedent`
      match {
        rea^^^dy -> return "ready"
        failed -> return "failed"
      }
    `;

    const { actions } = actionsAt(marked);

    expect(actionNamed(actions, "Move return outside match")).toBeUndefined();
  });

  it("does not move mixed branch operations or assignments to different targets", () => {
    const mixed = actionsAt(dedent`
      match {
        rea^^^dy -> return "ready"
        else -> state = "idle"
      }
    `).actions;
    const differentTargets = actionsAt(dedent`
      match {
        rea^^^dy -> left.state = "ready"
        else -> right.state = "idle"
      }
    `).actions;

    expect(actionNamed(mixed, "Move return outside match")).toBeUndefined();
    expect(actionNamed(mixed, "Move assignment outside match")).toBeUndefined();
    expect(actionNamed(differentTargets, "Move assignment outside match")).toBeUndefined();
  });

  it("does not move an assignment with a side-effectful target outside the match", () => {
    const marked = dedent`
      match {
        rea^^^dy -> values[next()] = "ready"
        else -> values[next()] = "idle"
      }
    `;

    const { actions } = actionsAt(marked);

    expect(actionNamed(actions, "Move assignment outside match")).toBeUndefined();
  });

  it("does not discard comments when inspecting single-statement arm blocks", () => {
    const marked = dedent`
      match {
        ready -> {
          // Keep this explanation.
          ret^^^urn "ready"
        }
        else -> { return "idle" }
      }
    `;

    const { actions } = actionsAt(marked);

    expect(actionNamed(actions, "Move return outside match")).toBeUndefined();
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
