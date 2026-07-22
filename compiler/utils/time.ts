/**
 * Returns a monotonic, high-resolution timestamp when the host provides one.
 * The native emitter lowers the same API to its steady-clock implementation.
 */
export function monotonicNow(): number {
  return performance.now();
}

export function roundedMilliseconds(elapsedMs: number): number {
  return Math.round(elapsedMs * 100) / 100;
}
