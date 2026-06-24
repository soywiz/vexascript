import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { createInterfaceImplementationCodeActions } from "./interfaceImplementationFixes";

function semaDiagnostic(
  message: string,
  extra?: Pick<Diagnostic, "code" | "data">
): Diagnostic {
  return {
    severity: 1,
    source: "vexa-sema",
    message,
    ...(extra ?? {}),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

describe("interface implementation quick fixes", () => {
  it("creates missing interface methods with Not implemented body", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `interface MyInterface {
  say(a: number)
}
class Map implements MyInterface {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic("ignored", {
          code: VEXA_DIAGNOSTIC_CODES.IMPLEMENTS_MISSING_MEMBER,
          data: {
            className: "Map",
            interfaceName: "MyInterface",
            memberName: "say"
          }
        })
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Implement missing member 'say' in class 'Map'");
    expect(edit?.newText).toContain("override fun say(a: number): void {");
    expect(edit?.newText).toContain("throw Error(\"Not implemented\")");
  });

  it("creates a missing interface property as an override field", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `interface Box {
  val width: int
}
class Demo implements Box {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic("ignored", {
          code: VEXA_DIAGNOSTIC_CODES.IMPLEMENTS_MISSING_MEMBER,
          data: {
            className: "Demo",
            interfaceName: "Box",
            memberName: "width"
          }
        })
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(edit?.newText).toContain("override width: int");
  });

  it("implements an inherited abstract method left unimplemented by a subclass", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `abstract class Test(val ms: number) {
  abstract fun demo()
}
class Demo extends Test {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic("ignored", {
          code: VEXA_DIAGNOSTIC_CODES.ABSTRACT_MEMBER_NOT_IMPLEMENTED,
          data: {
            className: "Demo",
            baseClassName: "Test",
            memberName: "demo"
          }
        })
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Implement missing member 'demo' in class 'Demo'");
    expect(edit?.newText).toContain("override fun demo(): void {");
    expect(edit?.newText).toContain("throw Error(\"Not implemented\")");
  });

  it("fixes incompatible implemented method signatures", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `interface MyInterface {
  say(a: number)
}
class Map implements MyInterface {
  say() {
  }
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic("ignored", {
          code: VEXA_DIAGNOSTIC_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER,
          data: {
            className: "Map",
            interfaceName: "MyInterface",
            memberName: "say",
            expectedType: "(a: number) => void"
          }
        })
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Fix signature of 'say' to match interface 'MyInterface'");
    expect(edit?.newText).toBe("(a: number): void ");
  });

  it("fixes an override signature to match the abstract base member", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `abstract class Test(val ms: number) {
  abstract fun demo(a: int)
}
class Demo extends Test {
  override fun demo() {
  }
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic("ignored", {
          code: VEXA_DIAGNOSTIC_CODES.OVERRIDE_INCOMPATIBLE_MEMBER,
          data: {
            className: "Demo",
            baseClassName: "Test",
            memberName: "demo",
            expectedType: "(a: int) => void"
          }
        })
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Fix signature of 'demo' to match base class 'Test'");
    expect(edit?.newText).toBe("(a: int): void ");
  });

  it("fixes the signature of an abstract member implemented without 'override'", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `abstract class Test(val ms: number) {
  abstract fun demo(a: int)
}
class Demo extends Test {
  demo(): void {
  }
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic("ignored", {
          code: VEXA_DIAGNOSTIC_CODES.ABSTRACT_MEMBER_SIGNATURE_MISMATCH,
          data: {
            className: "Demo",
            baseClassName: "Test",
            memberName: "demo",
            expectedType: "(a: int) => void"
          }
        })
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Fix signature of 'demo' to match base class 'Test'");
    expect(edit?.newText).toBe("(a: int): void ");
  });

  it("supports message-pattern fallback when diagnostic metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-implements-fix-"));
    const file = join(root, "demo.vx");
    const source = `interface MyInterface {
  say(a: number)
}
class Map implements MyInterface {
  say() {
  }
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = await createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic(
          "Class 'Map' incorrectly implements interface 'MyInterface'. Property 'say' is of type '() => unknown' but expected '(a: number) => void'"
        )
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Fix signature of 'say' to match interface 'MyInterface'");
  });
});
