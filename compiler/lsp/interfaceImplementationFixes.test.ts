import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import { createInterfaceImplementationCodeActions } from "./interfaceImplementationFixes";

function semaDiagnostic(message: string): Diagnostic {
  return {
    severity: 1,
    source: "mylang-sema",
    message,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

describe("interface implementation quick fixes", () => {
  it("creates missing interface methods with Not implemented body", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-implements-fix-"));
    const file = join(root, "demo.my");
    const source = `interface MyInterface {
  say(a: number)
}
class Map implements MyInterface {
}
`;

    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const uri = pathToFileURL(file).toString();
    const actions = createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic(
          "Class 'Map' incorrectly implements interface 'MyInterface'. Property 'say' is missing"
        )
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Implement missing member 'say' in class 'Map'");
    expect(edit?.newText).toContain("say(a: number): unknown {");
    expect(edit?.newText).toContain("throw new Error(\"Not implemented\")");
  });

  it("fixes incompatible implemented method signatures", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-implements-fix-"));
    const file = join(root, "demo.my");
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
    const actions = createInterfaceImplementationCodeActions({
      uri,
      ast: session.ast,
      diagnostics: [
        semaDiagnostic(
          "Class 'Map' incorrectly implements interface 'MyInterface'. Property 'say' is of type '() => unknown' but expected '(a: number) => unknown'"
        )
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const edit = actions[0]?.edit?.changes?.[uri]?.[0];
    expect(actions[0]?.title).toBe("Fix signature of 'say' to match interface 'MyInterface'");
    expect(edit?.newText).toBe("(a: number): unknown ");
  });
});
