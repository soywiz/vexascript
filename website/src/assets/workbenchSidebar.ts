export const COMPACT_WORKBENCH_MEDIA_QUERY = "(max-width: 1100px)";

export type WorkbenchSidebarState = {
  compact: boolean;
  open: boolean;
};

export function deriveWorkbenchSidebarState(
  previous: WorkbenchSidebarState,
  nextCompact: boolean
): WorkbenchSidebarState {
  if (!nextCompact) {
    return { compact: false, open: true };
  }
  if (!previous.compact) {
    return { compact: true, open: false };
  }
  return { compact: true, open: previous.open };
}

export function workbenchSidebarToggleLabel(state: WorkbenchSidebarState): string {
  return state.compact
    ? state.open ? "Hide workspace" : "Show workspace"
    : "Workspace";
}
