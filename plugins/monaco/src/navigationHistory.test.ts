import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import {
  pushNavigationTarget,
  sameNavigationTarget,
  stepBack,
  stepForward,
  type NavigationHistoryState,
} from "./navigationHistory";

describe("monaco navigation history", () => {
  it("compares targets by uri and position", () => {
    expect(sameNavigationTarget(
      { uri: "file:///main.my", lineNumber: 3, column: 4 },
      { uri: "file:///main.my", lineNumber: 3, column: 4 }
    )).toBe(true);
    expect(sameNavigationTarget(
      { uri: "file:///main.my", lineNumber: 3, column: 4 },
      { uri: "file:///main.my", lineNumber: 4, column: 4 }
    )).toBe(false);
  });

  it("pushes locations and clears forward history on new navigation", () => {
    const initial: NavigationHistoryState = { backStack: [], current: null, forwardStack: [] };
    const first = pushNavigationTarget(initial, { uri: "file:///main.my", lineNumber: 1, column: 1 });
    const second = pushNavigationTarget(first, { uri: "file:///es2025.d.ts", lineNumber: 100, column: 5 });
    const rewound = stepBack(second);
    const branched = pushNavigationTarget(rewound, { uri: "file:///demo.my", lineNumber: 7, column: 2 });

    expect(branched.current).toEqual({ uri: "file:///demo.my", lineNumber: 7, column: 2 });
    expect(branched.backStack).toEqual([{ uri: "file:///main.my", lineNumber: 1, column: 1 }]);
    expect(branched.forwardStack).toEqual([]);
  });

  it("moves backward and forward across navigation points", () => {
    const state = pushNavigationTarget(
      pushNavigationTarget(
        { backStack: [], current: null, forwardStack: [] },
        { uri: "file:///main.my", lineNumber: 5, column: 3 }
      ),
      { uri: "file:///es2025.d.ts", lineNumber: 1129, column: 13 }
    );

    const back = stepBack(state);
    expect(back.current).toEqual({ uri: "file:///main.my", lineNumber: 5, column: 3 });
    expect(back.forwardStack).toEqual([{ uri: "file:///es2025.d.ts", lineNumber: 1129, column: 13 }]);

    const forward = stepForward(back);
    expect(forward.current).toEqual({ uri: "file:///es2025.d.ts", lineNumber: 1129, column: 13 });
    expect(forward.backStack).toEqual([{ uri: "file:///main.my", lineNumber: 5, column: 3 }]);
  });
});
