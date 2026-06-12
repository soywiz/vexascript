import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import {
  deriveWorkspaceSidebarState,
  workspaceToggleLabel,
  type WorkspaceSidebarState,
} from "./workspaceSidebar";

describe("monaco workspace sidebar", () => {
  it("switches to a closed drawer when entering compact mode", () => {
    const previous: WorkspaceSidebarState = { compact: false, open: true };

    expect(deriveWorkspaceSidebarState(previous, true)).toEqual({
      compact: true,
      open: false,
    });
  });

  it("keeps the current drawer visibility while remaining compact", () => {
    const previous: WorkspaceSidebarState = { compact: true, open: true };

    expect(deriveWorkspaceSidebarState(previous, true)).toEqual({
      compact: true,
      open: true,
    });
  });

  it("reopens the workspace when returning to wide mode", () => {
    const previous: WorkspaceSidebarState = { compact: true, open: false };

    expect(deriveWorkspaceSidebarState(previous, false)).toEqual({
      compact: false,
      open: true,
    });
  });

  it("derives the toggle button label from state", () => {
    expect(workspaceToggleLabel({ compact: true, open: false })).toBe("Show workspace");
    expect(workspaceToggleLabel({ compact: true, open: true })).toBe("Hide workspace");
    expect(workspaceToggleLabel({ compact: false, open: true })).toBe("Workspace");
  });
});
