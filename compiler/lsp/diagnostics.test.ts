import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnostics, collectDiagnosticsFromSession, createDocumentDiagnosticReport } from "./diagnostics";
import { MYLANG_DIAGNOSTIC_CODES } from "./diagnosticCodes";

function diagnosticsFor(source: string) {
  const doc = TextDocument.create("file:///demo.my", "mylang", 1, source);
  return collectDiagnostics(source, (offset) => doc.positionAt(offset));
}

describe("lsp diagnostics", () => {
  it("keeps semantic analysis enabled after recoverable parser errors", () => {
    const source = dedent`
      let = 1
      let ok = missing
      `;

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
    const diagnostics = diagnosticsFor(dedent`
      switch (value) {
        default:
          break
        default:
          break
      }
    `);

    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.DUPLICATE_SWITCH_DEFAULT)
    ).toBe(true);
  });

  it("assigns a semantic diagnostic code to switch case fallthrough", () => {
    const diagnostics = diagnosticsFor(`switch (value) {
  case 1:
    value + 1
  default:
    break
}`);

    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.SWITCH_CASE_FALLTHROUGH)
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
    expect(wrongType?.range.start).toEqual({ line: 4, character: 2 });
    expect(missingValue?.range.start).toEqual({ line: 7, character: 2 });
  });

  it("anchors return type mismatch diagnostics on the return keyword", () => {
    const source = `async function load(): Promise<number> {
  return "bad"
}
`;
    const doc = TextDocument.create("file:///demo.my", "mylang", 1, source);
    const diagnostics = collectDiagnostics(source, (offset) => doc.positionAt(offset));
    const diagnostic = diagnostics.find(
      (item) => item.code === MYLANG_DIAGNOSTIC_CODES.RETURN_TYPE_MISMATCH
    );

    expect(diagnostic?.message).toBe("Type 'string' is not assignable to return type 'Promise<number>'");
    expect(diagnostic?.range.start).toEqual(doc.positionAt(source.indexOf("return")));
  });

  it("anchors member-call arity diagnostics on the member name", () => {
    const diagnostics = diagnosticsFor(dedent`
      fun demo() {
        Math.floor()
      }
      `
    );

    const missingArgument = diagnostics.find(
      (diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS
    );

    expect(missingArgument?.range.start).toEqual({ line: 1, character: 7 });
  });

  it("assigns a semantic diagnostic code when yield appears outside generator functions", () => {
    const diagnostics = diagnosticsFor(dedent`
      function bad() {
        yield 1
      }
      `
    );

    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.YIELD_OUTSIDE_GENERATOR)
    ).toBe(true);
  });

  it("anchors undefined operator diagnostics on the operator token", () => {
    const source = dedent`
      class Point(val x: number, val y: number) {
        operator+(other: Point): Point {
          return new Point(this.x + other.x, this.y + other.y)
        }
      }
      let b: unknown = undefined
      let result: Point = b / Point(1, 3)
      `;

    const doc = TextDocument.create("file:///demo.my", "mylang", 1, source);
    const diagnostics = collectDiagnostics(source, (offset) => doc.positionAt(offset));
    const diagnostic = diagnostics.find(
      (item) => item.code === MYLANG_DIAGNOSTIC_CODES.OPERATOR_NOT_DEFINED
    );

    expect(diagnostic?.message).toBe("Operator '/' is not defined for types 'unknown' and 'Point'");
    expect(diagnostic?.range.start).toEqual(doc.positionAt(source.indexOf("/")));
  });

  it("anchors nullable member-access diagnostics on the access dot", () => {
    const source = dedent`
      interface ElementLike {
        querySelector(value: string): ElementLike | null
      }
      let root: ElementLike
      root.querySelector(".demo").querySelector("test")
      `;

    const doc = TextDocument.create("file:///demo.my", "mylang", 1, source);
    const diagnostics = collectDiagnostics(source, (offset) => doc.positionAt(offset));
    const diagnostic = diagnostics.find(
      (item) =>
        item.message === "Object is possibly 'null' or 'undefined'. Use optional access '?.' or a non-null assertion '!'"
    );
    const expectedDotOffset = source.indexOf(".querySelector(\"test\")");

    expect(diagnostic?.range.start).toEqual(doc.positionAt(expectedDotOffset));
    expect(diagnostic?.range.end).toEqual(doc.positionAt(expectedDotOffset + 1));
  });

  it("creates a full document diagnostic report from a session", () => {
    const source = "function bad() {\n  yield 1\n}\n";
    const session = createAnalysisSession(source);
    const doc = TextDocument.create("file:///demo.my", "mylang", 7, source);

    const report = createDocumentDiagnosticReport(session, source, (offset) => doc.positionAt(offset), "7");

    expect(report.kind).toBe("full");
    if (report.kind === "full") {
      expect(report.resultId).toBe("7");
      expect(
        report.items.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.YIELD_OUTSIDE_GENERATOR)
      ).toBe(true);
    }
  });

  it("does not report missing return diagnostics for ambient class methods", () => {
    const diagnostics = diagnosticsFor(dedent`
      declare class MathConstructor {
        abs(x: number): number
        ceil(x: number): number
      }
      `
    );

    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.NOT_ALL_CODE_PATHS_RETURN)
    ).toBe(false);
  });

  it("assigns readonly-reassignment diagnostic code for const/val writes", () => {
    const source = dedent`
      const point = 1
      point = 2
      `;

    const diagnostics = diagnosticsFor(source);
    expect(
      diagnostics.some((diagnostic) => diagnostic.code === MYLANG_DIAGNOSTIC_CODES.READONLY_REASSIGNMENT)
    ).toBe(true);
  });

  it("does not report parser or semantic diagnostics for keyof, typeof, and indexed access types", () => {
    const source = dedent`
      interface Person { name: string; age: int }
      let person: Person = { name: "Ada", age: 36 }
      let key: keyof Person = "name"
      let name: typeof person.name = "Ada"
      let age: Person["age"] = 36
      `;

    expect(diagnosticsFor(source)).toEqual([]);
  });

  it("assigns typed implements diagnostic codes and metadata", () => {
    const source = dedent`
      interface Reader {
        say(a: number)
      }
      class Map implements Reader {
        say() {
        }
      }
      `;

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
