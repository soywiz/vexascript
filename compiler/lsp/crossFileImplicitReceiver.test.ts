import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import {
  findEnclosingReceiverTypeName,
  resolveImplicitReceiverMemberDefinition
} from "./crossFileImplicitReceiver";

describe("crossFileImplicitReceiver", () => {
  it("finds the enclosing receiver type inside extension bodies", () => {
    const source = dedent`
      fun CanvasRenderingContext2D.myDraw(): void {
        beginPath()
      }
    `;
    const session = createAnalysisSession(source);

    expect(findEnclosingReceiverTypeName(session.ast!, 1, 4)).toBe("CanvasRenderingContext2D");
  });

  it("returns null when the symbol is not an implicit receiver access", async () => {
    const source = dedent`
      class Box {
        value: int
      }
      fun demo(box: Box) {
        box.value
      }
    `;
    const session = createAnalysisSession(source);

    expect(await resolveImplicitReceiverMemberDefinition({
      uri: "file:///virtual/main.vx",
      line: 4,
      character: source.split("\n")[4]!.indexOf("value") + 2,
      session,
      sourceRoots: []
    })).toBeNull();
  });
});
