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
      kind: "markdown",
      value: "```typescript\nvalue: string\n```"
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
      kind: "markdown",
      value: "```typescript\nvalue: string\n```\n\nBox value docs"
    });
  });

  it("shows the instantiated return type for a generic member call", async () => {
    const source = dedent`
      interface Mapper {
        map<T>(value: T): T
      }
      declare const mapper: Mapper
      const value = mapper.map("ready")
    `;
    const session = createAnalysisSession(source);
    const callLine = source.split("\n").findIndex((line) => line.includes("mapper.map"));
    const hover = await resolveMemberHoverAcrossFiles({
      uri: "file:///virtual/main.vx",
      line: callLine,
      character: source.split("\n")[callLine]!.indexOf(".map") + 2,
      session,
      sourceRoots: []
    });

    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "```typescript\nmap: (value: string) => string\n```"
    });
  });
});
