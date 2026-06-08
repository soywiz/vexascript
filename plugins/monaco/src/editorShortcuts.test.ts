import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import { registerEditorShortcuts, RENAME_ACTION_ID } from "./editorShortcuts";

describe("monaco editor shortcuts", () => {
  const monaco = {
    KeyMod: { Alt: 1, CtrlCmd: 2, Shift: 4, WinCtrl: 8 },
    KeyCode: { Enter: 16, F6: 32, KeyS: 64, LeftArrow: 128, RightArrow: 256 },
  };

  it("maps Shift+F6 to Monaco rename", () => {
    const commands = new Map<number, () => void>();
    const requestedActions: string[] = [];
    let renameRunCount = 0;

    registerEditorShortcuts(
      {
        addCommand(keybinding, handler) {
          commands.set(keybinding, handler);
        },
        getAction(id) {
          requestedActions.push(id);
          return {
            run() {
              renameRunCount += 1;
            },
          };
        },
      },
      monaco,
      {
        navigateHistory() {},
        saveWorkspace() {},
      },
    );

    commands.get(monaco.KeyMod.Shift | monaco.KeyCode.F6)?.();

    expect(requestedActions).toEqual([RENAME_ACTION_ID]);
    expect(renameRunCount).toBe(1);
  });
});
