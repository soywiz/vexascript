import { describe, expect, it } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createClassResolverCache } from "./classResolver";
import { buildMemberCompletionItemsForType } from "./memberCompletion";
import { buildAnalyzedReceiverMemberAccessCompletions } from "./memberCompletionAnalyzedReceiver";

describe("memberCompletionAnalyzedReceiver", () => {
  it("returns no match when there is no member-access dot near the cursor", async () => {
    const { source, line, character } = sourceWithCursor("let value = ^^^1\n");
    const session = createAnalysisSession(source);

    expect(await buildAnalyzedReceiverMemberAccessCompletions(
      session.ast!,
      session.analysis!,
      line,
      character,
      { text: source },
      {},
      createClassResolverCache(),
      buildMemberCompletionItemsForType
    )).toEqual({
      foundDot: false,
      items: []
    });
  });

  it("builds member completions for analyzed call receivers", async () => {
    const { source, line, character } = sourceWithCursor(dedent`
      class Box {
        value: int
      }
      fun makeBox(): Box {
        return new Box()
      }
      makeBox().va^^^
    `);
    const session = createAnalysisSession(source);

    const result = await buildAnalyzedReceiverMemberAccessCompletions(
      session.ast!,
      session.analysis!,
      line,
      character,
      { text: source },
      {},
      createClassResolverCache(),
      buildMemberCompletionItemsForType
    );

    expect(result.foundDot).toBe(true);
    expect(result.items.some((item) => item.label === "value")).toBe(true);
  });
});
