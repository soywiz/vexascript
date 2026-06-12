import { deriveSidebarState, sidebarToggleLabel, type SidebarState } from "compiler/utils/sidebarState";

export const COMPACT_WORKBENCH_MEDIA_QUERY = "(max-width: 1100px)";

export type WorkbenchSidebarState = SidebarState;

export const deriveWorkbenchSidebarState = deriveSidebarState;

export const workbenchSidebarToggleLabel = sidebarToggleLabel;
