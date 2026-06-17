import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { resolveMemberHoverAcrossFiles } from "./crossFileMemberHover";

describe("crossFileMemberHover", () => {
  it("returns structural member hover when no class declaration is available", async () => {
    const source = dedent`
      type Box = { value: string }
      fun demo(box: Box) {
        box.value
      }
    `;
    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: 2,
      character: source.split("\n")[2]!.indexOf("value") + 2,
      session,
      sourceRoots: []
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "value: string"
    });
  });

  it("includes resolved documentation in member hover", async () => {
    const source = dedent`
      class Box {
        /// Box value docs
        value: string
      }
      fun demo(box: Box) {
        box.value
      }
    `;
    const session = createAnalysisSession(source);
    const hover = await resolveMemberHoverAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: 5,
      character: source.split("\n")[5]!.indexOf("value") + 2,
      session,
      sourceRoots: []
    });

    expect(hover?.contents).toEqual({
      kind: "plaintext",
      value: "value: string\n\nBox value docs"
    });
  });
});
