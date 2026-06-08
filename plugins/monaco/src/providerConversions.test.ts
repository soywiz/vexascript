import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";
import { DiagnosticSeverity } from "compiler/lsp/diagnosticSeverity";
import { markerToDiagnostic } from "./providerConversions";

describe("monaco provider conversions", () => {
  it("preserves marker source and code for quick-fix diagnostics", () => {
    const diagnostic = markerToDiagnostic(
      {
        startLineNumber: 10,
        startColumn: 5,
        endLineNumber: 10,
        endColumn: 10,
        severity: 8,
        message: "Undefined variable 'Point'",
        code: "MYL2001",
        source: "mylang-sema",
      },
      { Error: 8, Warning: 4, Info: 2 }
    );

    expect(diagnostic).toEqual({
      range: {
        start: { line: 9, character: 4 },
        end: { line: 9, character: 9 },
      },
      severity: DiagnosticSeverity.Error,
      message: "Undefined variable 'Point'",
      code: "MYL2001",
      source: "mylang-sema",
    });
  });
});
