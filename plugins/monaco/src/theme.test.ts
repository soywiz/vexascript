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
    const docParam = theme.rules.find((rule) => rule.token === "comment.doc.param");
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
    expect(docParam).toEqual({
      token: "comment.doc.param",
      foreground: "D7BA7D",
      fontStyle: "bold",
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

  it("styles semantic keyword families independently", () => {
    const theme = createVexaScriptMonacoTheme();
    const modifierKeyword = theme.rules.find((rule) => rule.token === "keywordModifier");
    const functionKeyword = theme.rules.find((rule) => rule.token === "keywordFunction");
    const typeKeyword = theme.rules.find((rule) => rule.token === "keywordType");
    const controlKeyword = theme.rules.find((rule) => rule.token === "keywordControl");

    expect(modifierKeyword).toEqual({
      token: "keywordModifier",
      foreground: "569CD6",
    });
    expect(functionKeyword).toEqual({
      token: "keywordFunction",
      foreground: "DCDCAA",
    });
    expect(typeKeyword).toEqual({
      token: "keywordType",
      foreground: "4EC9B0",
    });
    expect(controlKeyword).toEqual({
      token: "keywordControl",
      foreground: "C586C0",
    });
  });
});
