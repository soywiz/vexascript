import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import { extractShowReferencesPayload, type CodeLensCommand } from "./codeLensCommands";

describe("monaco code lens commands", () => {
  it("extracts the payload for reference lenses", () => {
    const command: CodeLensCommand = {
      title: "3 references",
      command: "mylang.showReferences",
      arguments: [
        "file:///main.my",
        { line: 12, character: 4 },
        [
          {
            uri: "file:///main.my",
            range: {
              start: { line: 12, character: 4 },
              end: { line: 12, character: 15 },
            },
          },
        ],
      ],
    };

    expect(extractShowReferencesPayload(command)).toEqual({
      uri: "file:///main.my",
      position: { line: 12, character: 4 },
      locations: [
        {
          uri: "file:///main.my",
          range: {
            start: { line: 12, character: 4 },
            end: { line: 12, character: 15 },
          },
        },
      ],
    });
  });

  it("ignores commands with an unexpected payload", () => {
    expect(
      extractShowReferencesPayload({
        title: "broken",
        command: "mylang.showReferences",
        arguments: ["file:///main.my", { line: 1, character: 1 }, [{ nope: true }]],
      })
    ).toBeNull();
  });
});
