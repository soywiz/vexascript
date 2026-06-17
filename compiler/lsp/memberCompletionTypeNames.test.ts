import { describe, expect, it } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import {
  arrayTypeNameToArrayAlias,
  boxedCompletionTypeName,
  inferLiteralTypeName,
  nonNullishTypeName,
  recoveredReceiverTypeName,
  receiverTypeNameEndingAt
} from "./memberCompletionTypeNames";
import { COMPLETION_RECOVERY_MEMBER } from "./completionModel";

describe("memberCompletionTypeNames", () => {
  it("infers numeric literal receiver type names", () => {
    expect(inferLiteralTypeName("1")).toBe("int");
    expect(inferLiteralTypeName("1.5")).toBe("number");
    expect(inferLiteralTypeName("name")).toBeNull();
  });

  it("removes nullish union members when narrowing receiver types", () => {
    expect(nonNullishTypeName("HTMLElement | null | undefined")).toBe("HTMLElement");
    expect(nonNullishTypeName("null | undefined")).toBeNull();
  });

  it("maps array shorthand types to Array<T> aliases", () => {
    expect(arrayTypeNameToArrayAlias("int[]")).toBe("Array<int>");
    expect(arrayTypeNameToArrayAlias("int[][]")).toBe("Array<int[]>");
    expect(arrayTypeNameToArrayAlias("Map<string, int>")).toBeNull();
  });

  it("boxes nullable primitive receiver types for completion lookup", () => {
    expect(boxedCompletionTypeName("int | null")).toBe("Number");
    expect(boxedCompletionTypeName("boolean")).toBe("Boolean");
  });

  it("recovers receiver types from analyzed expression endings and recovery members", () => {
    const ending = sourceWithCursor(dedent`
      class Box
      fun demo() {
        let box = new Box()
        box.^^^
      }
    `);
    const endingSession = createAnalysisSession(ending.source);

    expect(receiverTypeNameEndingAt(endingSession.analysis!, ending.line, ending.character)).toBe("Box");

    const recoverySource = dedent`
      class Box
      fun demo() {
        let box = new Box()
        box.${COMPLETION_RECOVERY_MEMBER}
      }
    `;
    const recoverySession = createAnalysisSession(recoverySource);
    expect(recoveredReceiverTypeName(recoverySession.ast!, recoverySession.analysis!)).toBe("Box");
  });
});
