import { describe, expect, it } from "../../../compiler/test/expect";
import {
  createWorkbenchBrowserHistorySnapshot,
  pushWorkbenchBrowserHistorySnapshot,
  readWorkbenchBrowserHistorySnapshot,
  writeWorkbenchBrowserHistorySnapshot,
} from "./workbenchBrowserHistory";

describe("website workbench browser history", () => {
  it("pushes file navigations and clears forward entries", () => {
    const initial = createWorkbenchBrowserHistorySnapshot("file:///src/main.vx");
    const second = pushWorkbenchBrowserHistorySnapshot(initial, "file:///src/counter.vx");
    const third = pushWorkbenchBrowserHistorySnapshot({
      back: second.back,
      current: second.current,
      forward: ["file:///src/point.vx"],
    }, "file:///src/time.vx");

    expect(third).toEqual({
      back: ["file:///src/main.vx", "file:///src/counter.vx"],
      current: "file:///src/time.vx",
      forward: [],
    });
  });

  it("round-trips snapshots in history.state without dropping sibling state", () => {
    const snapshot = {
      back: ["file:///src/main.vx"],
      current: "file:///src/counter.vx",
      forward: ["file:///src/time.vx"],
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

  it("rejects malformed snapshots", () => {
    expect(readWorkbenchBrowserHistorySnapshot({
      __vexaWorkbenchHistory: {
        broken: { back: [123], current: "file:///src/main.vx", forward: [] },
      },
    }, "broken")).toBe(null);
  });
});
