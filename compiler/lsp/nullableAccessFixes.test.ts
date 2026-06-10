import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnostics } from "./diagnostics";
import { createNullableAccessCodeActions } from "./nullableAccessFixes";

const URI = "file:///demo.vx";

describe("nullable access quick fixes", () => {
  it("offers optional access and non-null assertion fixes on a nullable member access dot", () => {
    const source = dedent`
      interface ElementLike {
        querySelector(value: string): ElementLike | null
      }
      let root: ElementLike
      root.querySelector(".demo").querySelector("test")
      `;
    const doc = TextDocument.create(URI, "vexa", 1, source);
    const session = createAnalysisSession(source);
    const diagnostics = collectDiagnostics(source, (offset) => doc.positionAt(offset));

    const actions = createNullableAccessCodeActions({
      uri: URI,
      ast: session.ast,
      diagnostics
    });

    expect(actions.map((action) => action.title)).toEqual([
      "Use optional access '?.'",
      "Use non-null assertion '!.'"
    ]);
    expect(actions[0]?.edit?.changes?.[URI]?.[0]?.newText).toBe("?.");
    expect(actions[1]?.edit?.changes?.[URI]?.[0]?.newText).toBe("!.");
  });
});
