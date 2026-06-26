export interface WorkbenchBrowserHistoryPosition {
  lineNumber: number;
  column: number;
}

export interface WorkbenchBrowserHistoryEntry {
  uri: string;
  position?: WorkbenchBrowserHistoryPosition;
}

export interface WorkbenchBrowserHistorySnapshot {
  back: WorkbenchBrowserHistoryEntry[];
  current: WorkbenchBrowserHistoryEntry;
  forward: WorkbenchBrowserHistoryEntry[];
}

interface WorkbenchBrowserHistoryStateShape {
  __vexaWorkbenchHistory?: Record<string, WorkbenchBrowserHistorySnapshot>;
}

type WorkbenchBrowserHistoryEntryInput = string | WorkbenchBrowserHistoryEntry;

function normalizeWorkbenchBrowserHistoryEntry(
  entry: WorkbenchBrowserHistoryEntryInput
): WorkbenchBrowserHistoryEntry {
  if (typeof entry === "string") {
    return { uri: entry };
  }
  return {
    uri: entry.uri,
    ...(entry.position ? { position: { ...entry.position } } : {}),
  };
}

function isWorkbenchBrowserHistoryEntryInput(value: unknown): value is WorkbenchBrowserHistoryEntryInput {
  if (typeof value === "string") {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as WorkbenchBrowserHistoryEntry;
  if (typeof entry.uri !== "string") {
    return false;
  }
  if (entry.position === undefined) {
    return true;
  }
  return typeof entry.position.lineNumber === "number"
    && typeof entry.position.column === "number";
}

export function getWorkbenchBrowserHistoryEntryUri(entry: WorkbenchBrowserHistoryEntry): string {
  return entry.uri;
}

export function withWorkbenchBrowserHistoryCurrentPosition(
  snapshot: WorkbenchBrowserHistorySnapshot,
  position?: WorkbenchBrowserHistoryPosition
): WorkbenchBrowserHistorySnapshot {
  return {
    ...snapshot,
    current: {
      ...snapshot.current,
      ...(position ? { position: { ...position } } : {}),
    },
  };
}

export function createWorkbenchBrowserHistorySnapshot(
  current: WorkbenchBrowserHistoryEntryInput
): WorkbenchBrowserHistorySnapshot {
  return {
    back: [],
    current: normalizeWorkbenchBrowserHistoryEntry(current),
    forward: [],
  };
}

export function pushWorkbenchBrowserHistorySnapshot(
  snapshot: WorkbenchBrowserHistorySnapshot,
  next: WorkbenchBrowserHistoryEntryInput
): WorkbenchBrowserHistorySnapshot {
  const nextEntry = normalizeWorkbenchBrowserHistoryEntry(next);
  if (snapshot.current.uri === nextEntry.uri) {
    return snapshot;
  }
  return {
    back: [...snapshot.back, snapshot.current],
    current: nextEntry,
    forward: [],
  };
}

export function withWorkbenchBrowserHistoryForwardTarget(
  snapshot: WorkbenchBrowserHistorySnapshot,
  next: WorkbenchBrowserHistoryEntryInput
): WorkbenchBrowserHistorySnapshot {
  const nextEntry = normalizeWorkbenchBrowserHistoryEntry(next);
  if (snapshot.current.uri === nextEntry.uri) {
    return snapshot;
  }
  return {
    ...snapshot,
    forward: [nextEntry],
  };
}

export function readWorkbenchBrowserHistorySnapshot(
  state: unknown,
  workbenchId: string
): WorkbenchBrowserHistorySnapshot | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const snapshot = (state as WorkbenchBrowserHistoryStateShape).__vexaWorkbenchHistory?.[workbenchId];
  if (!snapshot) {
    return null;
  }
  if (
    !Array.isArray(snapshot.back) ||
    !isWorkbenchBrowserHistoryEntryInput(snapshot.current) ||
    !Array.isArray(snapshot.forward)
  ) {
    return null;
  }
  if (
    snapshot.back.some((entry) => !isWorkbenchBrowserHistoryEntryInput(entry)) ||
    snapshot.forward.some((entry) => !isWorkbenchBrowserHistoryEntryInput(entry))
  ) {
    return null;
  }
  return {
    back: snapshot.back.map(normalizeWorkbenchBrowserHistoryEntry),
    current: normalizeWorkbenchBrowserHistoryEntry(snapshot.current),
    forward: snapshot.forward.map(normalizeWorkbenchBrowserHistoryEntry),
  };
}

export function writeWorkbenchBrowserHistorySnapshot(
  state: unknown,
  workbenchId: string,
  snapshot: WorkbenchBrowserHistorySnapshot
): Record<string, unknown> {
  const baseState = state && typeof state === "object"
    ? { ...(state as Record<string, unknown>) }
    : {};
  const historyState = baseState.__vexaWorkbenchHistory;
  const historyMap = historyState && typeof historyState === "object"
    ? { ...(historyState as Record<string, WorkbenchBrowserHistorySnapshot>) }
    : {};
  historyMap[workbenchId] = {
    back: snapshot.back.map(normalizeWorkbenchBrowserHistoryEntry),
    current: normalizeWorkbenchBrowserHistoryEntry(snapshot.current),
    forward: snapshot.forward.map(normalizeWorkbenchBrowserHistoryEntry),
  };
  baseState.__vexaWorkbenchHistory = historyMap;
  return baseState;
}
