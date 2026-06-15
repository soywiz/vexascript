const { describe, it } = require("node:test");
const { expect } = require("../../compiler/test/expect");
const { shouldRetriggerParameterHints } = require("./parameterHints.js");

describe("VS Code parameter hints helper", () => {
  it("re-triggers parameter hints when the user inserts a single comma", () => {
    expect(shouldRetriggerParameterHints([
      { text: ",", rangeLength: 0 }
    ])).toBe(true);
  });

  it("does not re-trigger parameter hints for replacements, deletions, or other text", () => {
    expect(shouldRetriggerParameterHints([{ text: ",", rangeLength: 1 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: "", rangeLength: 1 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: ", ", rangeLength: 0 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: "a", rangeLength: 0 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: "," }, { text: "," }])).toBe(false);
  });
});
