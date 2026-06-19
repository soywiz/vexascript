import { describe, expect, it } from "../../../../compiler/test/expect";
import { completionInsertText } from "./providerConversions";

describe("completionInsertText", () => {
  it("expands method completions into call snippets", () => {
    expect(completionInsertText({
      label: "appendChild",
      kind: 2,
    })).toEqual({
      insertText: "appendChild($1)",
      insertTextFormat: 2,
      command: {
        title: "Trigger parameter hints",
        command: "editor.action.triggerParameterHints",
      },
    });
  });

  it("preserves explicit insert text from the language server", () => {
    expect(completionInsertText({
      label: "name",
      kind: 10,
      insertText: "name: ",
    })).toEqual({
      insertText: "name: ",
    });
  });

  it("preserves explicit commands from the language server", () => {
    expect(completionInsertText({
      label: "preference",
      kind: 5,
      insertText: "preference: ",
      command: {
        title: "Trigger suggest",
        command: "editor.action.triggerSuggest",
      },
    })).toEqual({
      insertText: "preference: ",
      command: {
        title: "Trigger suggest",
        command: "editor.action.triggerSuggest",
      },
    });
  });

  it("does not force snippets for non-callable completions", () => {
    expect(completionInsertText({
      label: "textContent",
      kind: 10,
    })).toEqual({
      insertText: "textContent",
    });
  });
});
