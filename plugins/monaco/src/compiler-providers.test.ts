import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import { TextDocument } from "vscode-languageserver-textdocument";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession, type AnalysisSession } from "compiler/lsp/analysisSession";
import { collectWorkspaceDiagnostics } from "./workspaceDiagnostics";

function createModel(uri: string, text: string) {
  const document = TextDocument.create(uri, "vexa", 1, text);
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    getPositionAt: (offset: number) => {
      const position = document.positionAt(offset);
      return { lineNumber: position.line + 1, column: position.character + 1 };
    },
  };
}

describe("monaco compiler providers", () => {
  it("includes cross-file import diagnostics for missing exports in workspace mode", async () => {
    const mainSource = dedent`
      import { Point, MissingPoint } from "./point"
      fun demo() {
        Point(1)
      }
    `;
    const pointSource = "class Point(val x: int)\n";
    const model = createModel("file:///main.vx", mainSource);
    const sessions = new Map<string, AnalysisSession>([
      ["/main.vx", createAnalysisSession(mainSource)],
      ["/point.vx", createAnalysisSession(pointSource)],
    ]);

    const diagnostics = await collectWorkspaceDiagnostics(
      model as never,
      sessions.get("/main.vx")!,
      {
        getSessionForFilePath: (filePath) => sessions.get(filePath) ?? null,
      }
    );

    const missingExport = diagnostics.find((diagnostic) =>
      diagnostic.message === "Module './point' has no exported symbol 'MissingPoint'"
    );

    expect(missingExport?.range.start).toEqual({ line: 0, character: 16 });
  });
});
