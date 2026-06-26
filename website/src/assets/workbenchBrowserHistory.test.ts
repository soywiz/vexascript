import { describe, expect, it } from "../../../compiler/test/expect";
import {
  createWorkbenchBrowserHistorySnapshot,
  getWorkbenchBrowserHistoryEntryUri,
  pushWorkbenchBrowserHistorySnapshot,
  readWorkbenchBrowserHistorySnapshot,
  withWorkbenchBrowserHistoryCurrentPosition,
  withWorkbenchBrowserHistoryForwardTarget,
  writeWorkbenchBrowserHistorySnapshot,
} from "./workbenchBrowserHistory";

describe("website workbench browser history", () => {
  it("pushes file navigations and clears forward entries", () => {
    const initial = createWorkbenchBrowserHistorySnapshot("file:///src/main.vx");
    const second = pushWorkbenchBrowserHistorySnapshot(initial, "file:///src/counter.vx");
    const third = pushWorkbenchBrowserHistorySnapshot({
      back: second.back,
      current: second.current,
      forward: [{ uri: "file:///src/point.vx" }],
    }, "file:///src/time.vx");

    expect(third).toEqual({
      back: [{ uri: "file:///src/main.vx" }, { uri: "file:///src/counter.vx" }],
      current: { uri: "file:///src/time.vx" },
      forward: [],
    });
  });

  it("stores the next target on the previous entry before pushing a navigation", () => {
    const initial = createWorkbenchBrowserHistorySnapshot("file:///src/main.vx");
    const previous = withWorkbenchBrowserHistoryForwardTarget(initial, "file:///src/runtime.vx");
    const next = pushWorkbenchBrowserHistorySnapshot(previous, "file:///src/runtime.vx");

    expect(previous).toEqual({
      back: [],
      current: { uri: "file:///src/main.vx" },
      forward: [{ uri: "file:///src/runtime.vx" }],
    });
    expect(next).toEqual({
      back: [{ uri: "file:///src/main.vx" }],
      current: { uri: "file:///src/runtime.vx" },
      forward: [],
    });
  });

  it("stores and updates editor positions for history entries", () => {
    const initial = createWorkbenchBrowserHistorySnapshot({
      uri: "file:///src/main.vx",
      position: { lineNumber: 4, column: 8 },
    });
    const leavingCurrent = withWorkbenchBrowserHistoryCurrentPosition(initial, { lineNumber: 12, column: 3 });
    const next = pushWorkbenchBrowserHistorySnapshot(leavingCurrent, {
      uri: "file:///src/runtime.vx",
      position: { lineNumber: 2, column: 1 },
    });

    expect(next).toEqual({
      back: [{ uri: "file:///src/main.vx", position: { lineNumber: 12, column: 3 } }],
      current: { uri: "file:///src/runtime.vx", position: { lineNumber: 2, column: 1 } },
      forward: [],
    });
  });

  it("round-trips snapshots in history.state without dropping sibling state", () => {
    const snapshot = {
      back: [{ uri: "file:///src/main.vx", position: { lineNumber: 1, column: 2 } }],
      current: { uri: "file:///src/counter.vx", position: { lineNumber: 3, column: 4 } },
      forward: [{ uri: "file:///src/time.vx", position: { lineNumber: 5, column: 6 } }],
    };

    const state = writeWorkbenchBrowserHistorySnapshot(
      { page: "playground", nested: { keep: true } },
      "playground-editor",
      snapshot
    );

    expect(state.page).toBe("playground");
    expect(state.nested).toEqual({ keep: true });
    expect(readWorkbenchBrowserHistorySnapshot(state, "playground-editor")).toEqual(snapshot);
  });

  it("reads old string-only snapshots as URI entries", () => {
    const snapshot = readWorkbenchBrowserHistorySnapshot({
      __vexaWorkbenchHistory: {
        old: {
          back: ["file:///src/main.vx"],
          current: "file:///src/counter.vx",
          forward: ["file:///src/time.vx"],
        },
      },
    }, "old");

    expect(snapshot?.back.map(getWorkbenchBrowserHistoryEntryUri)).toEqual(["file:///src/main.vx"]);
    expect(snapshot?.current.uri).toBe("file:///src/counter.vx");
    expect(snapshot?.forward.map(getWorkbenchBrowserHistoryEntryUri)).toEqual(["file:///src/time.vx"]);
  });

  it("rejects malformed snapshots", () => {
    expect(readWorkbenchBrowserHistorySnapshot({
      __vexaWorkbenchHistory: {
        broken: { back: [123], current: { uri: "file:///src/main.vx" }, forward: [] },
      },
    }, "broken")).toBe(null);
  });
});
