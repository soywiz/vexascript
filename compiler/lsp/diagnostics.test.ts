import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnostics, collectDiagnosticsFromSession } from "./diagnostics";
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

  it("uses precomputed semantic issues from the analysis session", () => {
    const source = "let ok = missing\n";
    const doc = TextDocument.create("file:///demo.my", "mylang", 1, source);
    const session = createAnalysisSession(source);

    expect(session.semanticIssues.map((issue) => issue.message)).toContain(
      "Undefined variable 'missing'"
    );
    if (session.analysis) {
      session.analysis.getIssues = () => {
        throw new Error("diagnostics should not recompute analysis issues");
      };
    }

    const diagnostics = collectDiagnosticsFromSession(session, source, (offset) =>
      doc.positionAt(offset)
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Undefined variable 'missing'"
    );
  });

  it("assigns a semantic diagnostic code to duplicate switch defaults", () => {
    const diagnostics = diagnosticsFor(
      "switch (value) {\n" +
      "  default:\n" +
      "    break\n" +
      "  default:\n" +
      "    break\n" +
      "}\n"
    );

    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.DUPLICATE_SWITCH_DEFAULT)
    ).toBe(true);
  });

  it("assigns distinct return diagnostic codes at the nearest source locations", () => {
    const diagnostics = diagnosticsFor(`function incomplete(flag: boolean): int {
  if (flag) return 1
}
function wrong(): int {
  return "bad"
}
function empty(): int {
  return
}
`);

    const missingPath = diagnostics.find(
      (diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.NOT_ALL_CODE_PATHS_RETURN
    );
    const wrongType = diagnostics.find(
      (diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.RETURN_TYPE_MISMATCH
    );
    const missingValue = diagnostics.find(
      (diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.RETURN_VALUE_REQUIRED
    );

    expect(missingPath?.range.start).toEqual({ line: 0, character: 9 });
    expect(wrongType?.range.start).toEqual({ line: 4, character: 9 });
    expect(missingValue?.range.start).toEqual({ line: 7, character: 2 });
  });

  it("assigns a semantic diagnostic code when yield appears outside generator functions", () => {
    const diagnostics = diagnosticsFor(
      "function bad() {\n" +
      "  yield 1\n" +
      "}\n"
    );

    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.YIELD_OUTSIDE_GENERATOR)
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

  it("does not report parser or semantic diagnostics for keyof, typeof, and indexed access types", () => {
    const source =
      "interface Person { name: string; age: int }\n" +
      "let person: Person = { name: \"Ada\", age: 36 }\n" +
      "let key: keyof Person = \"name\"\n" +
      "let name: typeof person.name = \"Ada\"\n" +
      "let age: Person[\"age\"] = 36\n";

    expect(diagnosticsFor(source)).toEqual([]);
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
