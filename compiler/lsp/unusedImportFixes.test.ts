import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { createUnusedImportCodeActions } from "./unusedImportFixes";

const URI = "file:///demo.vx";

function positionAt(text: string, offset: number) {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: Math.min(offset, text.length) - lineStart };
}

function positionToOffset(text: string, position: { line: number; character: number }): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line && lineStart <= text.length) {
    const nextBreak = text.indexOf("\n", lineStart);
    if (nextBreak < 0) {
      return text.length;
    }
    line += 1;
    lineStart = nextBreak + 1;
  }
  return Math.min(text.length, lineStart + position.character);
}

function applyFirstEdit(text: string, action: NonNullable<ReturnType<typeof createUnusedImportCodeActions>[number]>) {
  const edit = action.edit?.changes?.[URI]?.[0];
  if (!edit) {
    throw new Error("Expected edit");
  }
  const start = positionToOffset(text, edit.range.start);
  const end = positionToOffset(text, edit.range.end);
  return text.slice(0, start) + edit.newText + text.slice(end);
}

function diagnosticsFor(source: string) {
  const session = createAnalysisSession(source);
  return collectDiagnosticsFromSession(session, source, (offset) => positionAt(source, offset));
}

describe("unused import quick fixes", () => {
  it("removes a single unused named import from a multi-specifier import", () => {
    const source = dedent`
      import { readFile, utimes } from "fs/promises"
      await readFile("demo.txt")
      `;
    const diagnostics = diagnosticsFor(source);
    const session = createAnalysisSession(source);
    const actions = createUnusedImportCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      diagnostics
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Remove unused import 'utimes'");
    expect(applyFirstEdit(source, actions[0]!)).toBe(dedent`
      import { readFile } from "fs/promises"
      await readFile("demo.txt")
      `);
  });

  it("removes the whole import statement when the last binding is unused", () => {
    const source = dedent`
      import { utimes } from "fs/promises"
      const value = 1
      `;
    const diagnostics = diagnosticsFor(source);
    const session = createAnalysisSession(source);
    const actions = createUnusedImportCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      diagnostics
    });

    expect(actions).toHaveLength(1);
    expect(applyFirstEdit(source, actions[0]!)).toBe("const value = 1");
  });

  it("removes an unused default import while keeping named imports", () => {
    const source = dedent`
      import util, { format } from "node:util"
      format("%d", 1)
      `;
    const diagnostics = diagnosticsFor(source);
    const session = createAnalysisSession(source);
    const actions = createUnusedImportCodeActions({
      uri: URI,
      ast: session.ast,
      text: source,
      diagnostics
    });

    expect(actions).toHaveLength(1);
    expect(applyFirstEdit(source, actions[0]!)).toBe(dedent`
      import { format } from "node:util"
      format("%d", 1)
      `);
  });
});
