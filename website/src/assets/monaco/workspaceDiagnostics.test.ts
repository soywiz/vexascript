import dedent from "compiler/utils/dedent";
import { describe, expect, it } from "compiler/test/expect";
import { createAnalysisSession } from "compiler/lsp/analysisSession";
import { collectWorkspaceDiagnostics } from "./workspaceDiagnostics";

describe("workspace diagnostics", () => {
  it("includes deprecated member diagnostics with deprecated tags", async () => {
    const source = dedent`
      declare class Graphics {
        /** @deprecated since 8.0.0 Use fill instead */
        beginFill(color: number): Graphics
        fill(color: number): Graphics
      }

      val badge = Graphics()
      badge.beginFill(1)
      `;
    const session = createAnalysisSession(source);
    const model = {
      uri: { toString: () => "file:///sample.vx" },
      getValue: () => source,
      getPositionAt(offset: number) {
        const prior = source.slice(0, offset);
        const lines = prior.split("\n");
        return {
          lineNumber: lines.length,
          column: (lines.at(-1)?.length ?? 0) + 1
        };
      }
    };

    const diagnostics = await collectWorkspaceDiagnostics(model, session);
    const deprecated = diagnostics.find((diagnostic) => diagnostic.code === "MYL3003");

    expect(deprecated?.tags).toEqual([2]);
    expect(deprecated?.range).toEqual({
      start: { line: 7, character: 6 },
      end: { line: 7, character: 15 }
    });
  });
});
