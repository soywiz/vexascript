export const COMPACT_WORKSPACE_MEDIA_QUERY = "(max-width: 900px)";

export type WorkspaceSidebarState = {
  compact: boolean;
  open: boolean;
};

export function deriveWorkspaceSidebarState(
  previous: WorkspaceSidebarState,
  nextCompact: boolean
): WorkspaceSidebarState {
  if (!nextCompact) {
    return { compact: false, open: true };
  }
  if (!previous.compact) {
    return { compact: true, open: false };
  }
  return { compact: true, open: previous.open };
}

export function workspaceToggleLabel(state: WorkspaceSidebarState): string {
  return state.compact
    ? state.open ? "Hide workspace" : "Show workspace"
    : "Workspace";
}
