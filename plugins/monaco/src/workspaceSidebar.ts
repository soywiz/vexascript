import { deriveSidebarState, sidebarToggleLabel, type SidebarState } from "compiler/utils/sidebarState";

export const COMPACT_WORKSPACE_MEDIA_QUERY = "(max-width: 900px)";

export type WorkspaceSidebarState = SidebarState;

export const deriveWorkspaceSidebarState = deriveSidebarState;

export const workspaceToggleLabel = sidebarToggleLabel;
