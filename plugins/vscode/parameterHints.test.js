const { describe, it } = require("node:test");
const { expect } = require("../../compiler/test/expect");
const {
  shouldRetriggerParameterHints,
  shouldRetriggerParameterHintsForSelectionChange
} = require("./parameterHints.js");

describe("VS Code parameter hints helper", () => {
  it("re-triggers parameter hints for simple single insertions while typing arguments", () => {
    expect(shouldRetriggerParameterHints([
      { text: "(", rangeLength: 0 }
    ])).toBe(true);
    expect(shouldRetriggerParameterHints([
      { text: ",", rangeLength: 0 }
    ])).toBe(true);
    expect(shouldRetriggerParameterHints([
      { text: " ", rangeLength: 0 }
    ])).toBe(true);
    expect(shouldRetriggerParameterHints([
      { text: "a", rangeLength: 0 }
    ])).toBe(true);
    expect(shouldRetriggerParameterHints([
      { text: "\"", rangeLength: 0 }
    ])).toBe(true);
  });

  it("does not re-trigger parameter hints for replacements, deletions, multiline edits, or batched edits", () => {
    expect(shouldRetriggerParameterHints([{ text: ",", rangeLength: 1 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: "", rangeLength: 1 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: "\n", rangeLength: 0 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: ",\n", rangeLength: 0 }])).toBe(false);
    expect(shouldRetriggerParameterHints([{ text: "," }, { text: "," }])).toBe(false);
  });

  it("re-triggers parameter hints when the caret moves within the current editor", () => {
    expect(shouldRetriggerParameterHintsForSelectionChange({
      selections: [{ isEmpty: true, active: { line: 3, character: 8 } }]
    }, {
      parameterHintsArmed: true,
      lastSelection: { line: 3, character: 5 }
    })).toBe(true);
  });

  it("does not re-trigger parameter hints unless they were already opened by typing", () => {
    expect(shouldRetriggerParameterHintsForSelectionChange({
      selections: [{ isEmpty: true, active: { line: 3, character: 8 } }]
    }, {
      parameterHintsArmed: false,
      lastSelection: { line: 3, character: 5 }
    })).toBe(false);
  });

  it("does not re-trigger parameter hints when the caret moves to another line", () => {
    expect(shouldRetriggerParameterHintsForSelectionChange({
      selections: [{ isEmpty: true, active: { line: 4, character: 2 } }]
    }, {
      parameterHintsArmed: true,
      lastSelection: { line: 3, character: 5 }
    })).toBe(false);
  });

  it("does not re-trigger parameter hints for multi-cursor or range selections", () => {
    expect(shouldRetriggerParameterHintsForSelectionChange({
      selections: [{ isEmpty: false }]
    })).toBe(false);
    expect(shouldRetriggerParameterHintsForSelectionChange({
      selections: [{ isEmpty: true }, { isEmpty: true }]
    })).toBe(false);
  });
});
