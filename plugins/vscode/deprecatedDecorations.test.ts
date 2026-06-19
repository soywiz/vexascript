import { createRequire } from "node:module";
import { describe, expect, it } from "compiler/test/expect";

const require = createRequire(import.meta.url);
const {
  DEPRECATED_DIAGNOSTIC_TAG,
  collectDeprecatedDiagnosticRanges
} = require("./deprecatedDecorations.js") as {
  DEPRECATED_DIAGNOSTIC_TAG: number;
  collectDeprecatedDiagnosticRanges(
    documentUri: string,
    diagnostics: Array<{
      tags?: number[];
      range?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
  ): Array<{
    start: { line: number; character: number };
    end: { line: number; character: number };
  }>;
};

describe("VS Code deprecated decorations", () => {
  it("extracts only deprecated diagnostic ranges", () => {
    const ranges = collectDeprecatedDiagnosticRanges("file:///sample.vx", [
      {
        tags: [DEPRECATED_DIAGNOSTIC_TAG],
        range: {
          start: { line: 7, character: 4 },
          end: { line: 7, character: 19 }
        }
      },
      {
        tags: [1],
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 4 }
        }
      }
    ]);

    expect(ranges).toEqual([
      {
        start: { line: 7, character: 4 },
        end: { line: 7, character: 19 }
      }
    ]);
  });
});
