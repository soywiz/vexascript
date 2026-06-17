import { describe, expect, it } from "../test/expect";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { createCallFixCodeActions } from "./callFixes";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";

const URI = "file:///demo.vx";

function diagnosticsFor(source: string) {
  const document = TextDocument.create(URI, "vexa", 1, source);
  const session = createAnalysisSession(source);
  const diagnostics = collectDiagnosticsFromSession(session, source, (offset) =>
    document.positionAt(offset)
  );
  return { session, diagnostics };
}

describe("call quick fixes", () => {
  it("adds missing declaration parameters for extra call arguments with inferred types", () => {
    const source = `fun test2(a: number, b: string) {
}
fun demo() {
  test2(1, "test", 3, 4)
}
`;

    const { session, diagnostics } = diagnosticsFor(source);
    const actions = createCallFixCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      diagnostics
    });

    const action = actions.find((candidate) =>
      candidate.title === "Add missing parameters to 'test2'"
    );
    expect(action).toBeDefined();
    expect(action?.edit?.changes?.[URI]?.[0]?.newText).toBe(", arg3: int, arg4: int");
  });

  it("changes declaration parameter type from mismatched call argument inferred type", () => {
    const source = `fun test2(a: number, b: string) {
}
fun demo() {
  test2("hello", 10)
}
`;

    const { session, diagnostics } = diagnosticsFor(source);
    const actions = createCallFixCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      diagnostics
    });

    const actionTitles = actions.map((action) => action.title);
    expect(actionTitles).toContain("Change parameter 'a' type to 'string'");
    expect(actionTitles).toContain("Change parameter 'b' type to 'int'");
  });

  it("offers a change-signature action that updates types and adds optional parameters", () => {
    const source = `fun test2(a: number, b: string) {
}
fun demo() {
  test2("hello", 10, 3)
}
`;

    const { session, diagnostics } = diagnosticsFor(source);
    const actions = createCallFixCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      diagnostics
    });

    const action = actions.find(
      (candidate) => candidate.title === "Change signature of 'test2' to match this call"
    );
    expect(action).toBeDefined();
    expect(action?.kind).toBe("refactor.rewrite");

    const edits = action?.edit?.changes?.[URI] ?? [];
    expect(edits.length).toBeGreaterThanOrEqual(3);
    expect(edits.some((edit) => edit.newText === "string")).toBe(true);
    expect(edits.some((edit) => edit.newText === "int")).toBe(true);
    expect(edits.some((edit) => edit.newText.includes("arg3?: int"))).toBe(true);
  });

  it("accepts call quick-fix hook by diagnostic code even when message changes", () => {
    const source = `fun test2(a: number, b: string) {
}
fun demo() {
  test2(1, "test", 3)
}
`;
    const session = createAnalysisSession(source);
    const document = TextDocument.create(URI, "vexa", 1, source);
    const argumentPosition = document.positionAt(source.lastIndexOf("3"));
    const diagnostics: Diagnostic[] = [
      {
        severity: 1,
        source: "vexa-sema",
        code: VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT,
        message: "custom message",
        range: {
          start: argumentPosition,
          end: argumentPosition
        }
      }
    ];

    const actions = createCallFixCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      diagnostics
    });

    expect(
      actions.some((action) => action.title === "Add missing parameters to 'test2'")
    ).toBe(true);
  });

  it("adds missing required JSX props for component calls", () => {
    const source = `interface InputProperties {
  mySpecialProp: any
  style?: string
}

const Input = (props: InputProperties) => <input {...props} />

function App() {
  return <Input style="test" />
}
`;

    const { session, diagnostics } = diagnosticsFor(source);
    const actions = createCallFixCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      diagnostics
    });

    const action = actions.find((candidate) => candidate.title === "Add missing props to 'Input'");
    expect(action).toBeDefined();
    expect(action?.edit?.changes?.[URI]?.[0]?.newText).toBe(" mySpecialProp={undefined}");
  });

  it("does not offer missing JSX prop fixes for optional props", () => {
    const source = `function MyButton({
  style: any?,
  onClick: (() => void)?,
  children: ComponentChildren?
}) {
  return <button style={style} onClick={onClick}>
    {children}
  </button>
}

function App() {
  return <MyButton></MyButton>
}
`;

    const { session, diagnostics } = diagnosticsFor(source);
    const actions = createCallFixCodeActions({
      uri: URI,
      text: source,
      ast: session.ast,
      analysis: session.analysis,
      diagnostics
    });

    expect(actions.some((candidate) => candidate.title === "Add missing props to 'MyButton'")).toBe(false);
  });
});
