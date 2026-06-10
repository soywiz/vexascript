import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";
import {
  createVexaScriptMonacoTheme,
  VEXA_MONACO_THEME_NAME,
} from "./theme";

describe("monaco theme", () => {
  it("defines distinct colors for regular and documentation comments", () => {
    const theme = createVexaScriptMonacoTheme();
    const regularComment = theme.rules.find((rule) => rule.token === "comment");
    const docComment = theme.rules.find((rule) => rule.token === "comment.doc");
    const jsxTag = theme.rules.find((rule) => rule.token === "tag");
    const jsxAttribute = theme.rules.find((rule) => rule.token === "attribute.name");

    expect(VEXA_MONACO_THEME_NAME).toBe("vexa-dark");
    expect(regularComment).toEqual({
      token: "comment",
      foreground: "6A9955",
    });
    expect(docComment).toEqual({
      token: "comment.doc",
      foreground: "9CDC8C",
      fontStyle: "italic",
    });
    expect(jsxTag).toEqual({
      token: "tag",
      foreground: "D4D4D4",
    });
    expect(jsxAttribute).toEqual({
      token: "attribute.name",
      foreground: "9CDCFE",
    });
  });
});
