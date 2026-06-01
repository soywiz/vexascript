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

  it("assigns typed implements diagnostic codes and metadata", () => {
    const source =
      "interface Reader {\n" +
      "  say(a: number)\n" +
      "}\n" +
      "class Map implements Reader {\n" +
      "  say() {\n" +
      "  }\n" +
      "}\n";

    const diagnostics = diagnosticsFor(source);
    const incompatible = diagnostics.find(
      (diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER
    );
    expect(incompatible).toBeDefined();
    expect(incompatible?.data).toEqual({
      className: "Map",
      interfaceName: "Reader",
      memberName: "say",
      actualType: "() => void",
      expectedType: "(a: number) => void"
    });
  });
});
