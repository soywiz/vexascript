import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { collectDiagnostics } from "./diagnostics";
import { MYLANG_DIAGNOSTIC_CODES } from "./diagnosticCodes";

function diagnosticsFor(source: string) {
  const doc = TextDocument.create("file:///demo.my", "mylang", 1, source);
  return collectDiagnostics(source, (offset) => doc.positionAt(offset));
}

describe("lsp diagnostics", () => {
  it("keeps semantic analysis enabled after recoverable parser errors", () => {
    const source =
      "let = 1\n" +
      "let ok = missing\n";

    const diagnostics = diagnosticsFor(source);
    const parserMessages = diagnostics
      .filter((diagnostic) => diagnostic.source === "mylang-ls")
      .map((diagnostic) => diagnostic.message);
    const semanticMessages = diagnostics
      .filter((diagnostic) => diagnostic.source === "mylang-sema")
      .map((diagnostic) => diagnostic.message);

    expect(parserMessages).toContain("Expected identifier in variable declaration");
    expect(semanticMessages).toContain("Undefined variable 'missing'");
    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.PARSER_ERROR)
    ).toBe(true);
    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE)
    ).toBe(true);
  });

  it("assigns readonly-reassignment diagnostic code for const/val writes", () => {
    const source =
      "const point = 1\n" +
      "point = 2\n";

    const diagnostics = diagnosticsFor(source);
    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.READONLY_REASSIGNMENT)
    ).toBe(true);
  });
});
