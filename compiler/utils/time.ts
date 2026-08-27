/**
 * Returns a monotonic, high-resolution timestamp when the host provides one.
 * Browser and Node.js hosts provide the same monotonic timing API.
 */
export function monotonicNow(): number {
  return performance.now();
}

export function roundedMilliseconds(elapsedMs: number): number {
  return Math.round(elapsedMs * 100) / 100;
}
