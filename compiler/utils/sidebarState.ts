/**
 * Shared editor-shell sidebar state machine used by the Monaco workspace
 * sidebar (plugins/monaco) and the website workbench sidebar (website
 * embeds). Consumers keep their own compact-mode media-query breakpoints;
 * only the state transitions and toggle labelling are shared.
 */

export type SidebarState = {
  compact: boolean;
  open: boolean;
};

export function deriveSidebarState(previous: SidebarState, nextCompact: boolean): SidebarState {
  if (!nextCompact) {
    return { compact: false, open: true };
  }
  if (!previous.compact) {
    return { compact: true, open: false };
  }
  return { compact: true, open: previous.open };
}

export function sidebarToggleLabel(state: SidebarState): string {
  return state.compact
    ? state.open ? "Hide workspace" : "Show workspace"
    : "Workspace";
}
