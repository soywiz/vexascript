import { expect } from "./expect";

export function sourceWithCursor(source: string): {
  source: string;
  line: number;
  character: number;
} {
  const marker = "^^^";
  const offset = source.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(marker, offset + marker.length)).toBe(-1);

  const cleanSource = source.slice(0, offset) + source.slice(offset + marker.length);
  const beforeCursor = source.slice(0, offset);
  const lines = beforeCursor.split("\n");

  return {
    source: cleanSource,
    line: lines.length - 1,
    character: lines[lines.length - 1]?.length ?? 0
  };
}
