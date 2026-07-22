import { describe, expect, it } from "../test/expect";
import { monotonicNow, roundedMilliseconds } from "./time";

describe("monotonic clock", () => {
  it("returns finite non-decreasing high-resolution timestamps", () => {
    const first = monotonicNow();
    const second = monotonicNow();

    expect(Number.isFinite(first)).toBe(true);
    expect(second >= first).toBe(true);
  });

  it("rounds displayed durations without discarding sub-millisecond timing", () => {
    expect(roundedMilliseconds(1.23456)).toBe(1.23);
  });
});
