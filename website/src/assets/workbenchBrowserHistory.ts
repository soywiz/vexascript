export interface WorkbenchBrowserHistorySnapshot {
  back: string[];
  current: string;
  forward: string[];
}

interface WorkbenchBrowserHistoryStateShape {
  __vexaWorkbenchHistory?: Record<string, WorkbenchBrowserHistorySnapshot>;
}

export function createWorkbenchBrowserHistorySnapshot(current: string): WorkbenchBrowserHistorySnapshot {
  return {
    back: [],
    current,
    forward: [],
  };
}

export function pushWorkbenchBrowserHistorySnapshot(
  snapshot: WorkbenchBrowserHistorySnapshot,
  nextUri: string
): WorkbenchBrowserHistorySnapshot {
  if (snapshot.current === nextUri) {
    return snapshot;
  }
  return {
    back: [...snapshot.back, snapshot.current],
    current: nextUri,
    forward: [],
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
    typeof snapshot.current !== "string" ||
    !Array.isArray(snapshot.forward)
  ) {
    return null;
  }
  if (
    snapshot.back.some((entry) => typeof entry !== "string") ||
    snapshot.forward.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  return {
    back: [...snapshot.back],
    current: snapshot.current,
    forward: [...snapshot.forward],
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
    back: [...snapshot.back],
    current: snapshot.current,
    forward: [...snapshot.forward],
  };
  baseState.__vexaWorkbenchHistory = historyMap;
  return baseState;
}
