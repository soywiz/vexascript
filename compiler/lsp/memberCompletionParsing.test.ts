import { describe, expect, it } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import {
  findMemberAccessDot,
  parseMemberAccessTarget
} from "./memberCompletionParsing";

describe("memberCompletionParsing", () => {
  it("parses simple and optional member-access targets", () => {
    const simple = sourceWithCursor("point.he^^^ight");
    expect(parseMemberAccessTarget(simple.source, simple.line, simple.character)).toEqual({
      objectPath: "point",
      objectStartCharacter: 0,
      memberAccessStartCharacter: 5,
      prefix: "he"
    });

    const optional = sourceWithCursor("countRef.current?.sty^^^le");
    expect(parseMemberAccessTarget(optional.source, optional.line, optional.character)).toEqual({
      objectPath: "countRef.current",
      objectStartCharacter: 0,
      memberAccessStartCharacter: 17,
      prefix: "sty"
    });
  });

  it("finds lenient member-access dots after complex receivers", () => {
    const chained = sourceWithCursor("fetch(url).arrayBuf^^^fer");
    expect(findMemberAccessDot(chained.source, chained.line, chained.character)).toEqual({
      dotCharacter: 10,
      receiverEndCharacter: 10,
      prefix: "arrayBuf"
    });

    const trailingLambda = sourceWithCursor("items.map { it }.len^^^gth");
    expect(findMemberAccessDot(trailingLambda.source, trailingLambda.line, trailingLambda.character)).toEqual({
      dotCharacter: 16,
      receiverEndCharacter: 16,
      prefix: "len"
    });

    const chainOperator = sourceWithCursor("build()..val^^^ue");
    expect(findMemberAccessDot(chainOperator.source, chainOperator.line, chainOperator.character)).toEqual({
      dotCharacter: 8,
      receiverEndCharacter: 7,
      prefix: "val"
    });
  });

  it("finds leading dots on continuation lines", () => {
    const continued = sourceWithCursor("build()\n  .val^^^ue");
    expect(findMemberAccessDot(continued.source, continued.line, continued.character)).toEqual({
      dotCharacter: 2,
      receiverEndCharacter: null,
      prefix: "val"
    });

    const continuedChain = sourceWithCursor("build()\n  ..val^^^ue");
    expect(findMemberAccessDot(continuedChain.source, continuedChain.line, continuedChain.character)).toEqual({
      dotCharacter: 3,
      receiverEndCharacter: null,
      prefix: "val"
    });
  });

  it("rejects non-member-access dots such as decimal literals", () => {
    const decimal = sourceWithCursor("1.2^^^");
    expect(findMemberAccessDot(decimal.source, decimal.line, decimal.character)).toBeNull();
    expect(parseMemberAccessTarget(decimal.source, decimal.line, decimal.character)).toBeNull();
  });
});
