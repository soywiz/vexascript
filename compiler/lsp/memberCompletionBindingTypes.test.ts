import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { sourceWithCursor } from "../test/sourceWithCursor";
import {
  findIdentifierAtPosition,
  inferClassNameFromAstVariableInitializer,
  inferTypeNameFromAstBindingAnnotation
} from "./memberCompletionBindingTypes";

describe("memberCompletionBindingTypes", () => {
  it("finds the smallest identifier at the cursor position", () => {
    const cursor = sourceWithCursor("person.na^^^me");
    const session = createAnalysisSession(cursor.source);

    expect(findIdentifierAtPosition(session.ast!, cursor.line, 1)?.name).toBe("person");
    expect(findIdentifierAtPosition(session.ast!, cursor.line, cursor.character)?.name).toBe("name");
  });

  it("infers class names from the nearest preceding new-expression initializer", () => {
    const session = createAnalysisSession(dedent`
      class Box
      fun demo() {
        let item = new OldBox()
        let item = new Box()
      }
    `);

    expect(inferClassNameFromAstVariableInitializer(session.ast!, "item", 4)).toBe("Box");
  });

  it("infers annotated binding types from parameters and variables", () => {
    const session = createAnalysisSession(dedent`
      fun demo(value: string) {
        let result: Array<int> = []
        value
        result
      }
    `);

    expect(inferTypeNameFromAstBindingAnnotation(session.ast!, "value", 3)).toBe("string");
    expect(inferTypeNameFromAstBindingAnnotation(session.ast!, "result", 4)).toBe("Array<int>");
  });
});
