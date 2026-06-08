export const RENAME_ACTION_ID = "editor.action.rename";

interface EditorAction {
  run(): unknown;
}

interface ShortcutEditor {
  addCommand(keybinding: number, handler: () => void): unknown;
  getAction(id: string): EditorAction | null | undefined;
}

interface ShortcutMonaco {
  KeyMod: {
    Alt: number;
    CtrlCmd: number;
    Shift: number;
    WinCtrl: number;
  };
  KeyCode: {
    Enter: number;
    F6: number;
    KeyS: number;
    LeftArrow: number;
    RightArrow: number;
  };
}

interface ShortcutHandlers {
  navigateHistory(direction: "back" | "forward"): void;
  saveWorkspace(): void;
}

export function registerEditorShortcuts(
  editor: ShortcutEditor,
  monaco: ShortcutMonaco,
  handlers: ShortcutHandlers,
): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    handlers.saveWorkspace();
  });
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
    void editor.getAction("editor.action.quickFix")?.run();
  });
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F6, () => {
    void editor.getAction(RENAME_ACTION_ID)?.run();
  });
  editor.addCommand(
    monaco.KeyMod.WinCtrl |
      monaco.KeyMod.CtrlCmd |
      monaco.KeyMod.Alt |
      monaco.KeyCode.LeftArrow,
    () => {
      handlers.navigateHistory("back");
    },
  );
  editor.addCommand(
    monaco.KeyMod.WinCtrl |
      monaco.KeyMod.CtrlCmd |
      monaco.KeyMod.Alt |
      monaco.KeyCode.RightArrow,
    () => {
      handlers.navigateHistory("forward");
    },
  );
}
