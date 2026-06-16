import { describe, expect, it } from "../../../compiler/test/expect";
import {
  deriveWorkbenchSidebarState,
  workbenchSidebarToggleLabel,
  type WorkbenchSidebarState,
} from "./workbenchSidebar";

describe("website workbench sidebar", () => {
  it("closes the workspace when entering compact mode", () => {
    const previous: WorkbenchSidebarState = { compact: false, open: true };

    expect(deriveWorkbenchSidebarState(previous, true)).toEqual({
      compact: true,
      open: false,
    });
  });

  it("preserves drawer visibility while staying compact", () => {
    const previous: WorkbenchSidebarState = { compact: true, open: true };

    expect(deriveWorkbenchSidebarState(previous, true)).toEqual({
      compact: true,
      open: true,
    });
  });

  it("reopens the sidebar when returning to wide mode", () => {
    const previous: WorkbenchSidebarState = { compact: true, open: false };

    expect(deriveWorkbenchSidebarState(previous, false)).toEqual({
      compact: false,
      open: true,
    });
  });

  it("builds the toggle label from the current state", () => {
    expect(workbenchSidebarToggleLabel({ compact: true, open: false })).toBe("Show workspace");
    expect(workbenchSidebarToggleLabel({ compact: true, open: true })).toBe("Hide workspace");
    expect(workbenchSidebarToggleLabel({ compact: false, open: true })).toBe("Workspace");
  });
});
