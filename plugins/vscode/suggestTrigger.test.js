const { describe, it } = require("node:test");
const { expect } = require("../../compiler/test/expect");
const {
  shouldTriggerValueSuggestions,
  shouldKeepValueSuggestions,
  shouldTriggerMemberSuggestions,
} = require("./suggestTrigger.js");

describe("VS Code suggest trigger helper", () => {
  it("triggers value suggestions after ':' insertions", () => {
    expect(shouldTriggerValueSuggestions([
      { text: ":", rangeLength: 0 }
    ])).toBe(true);
    expect(shouldTriggerValueSuggestions([
      { text: ": ", rangeLength: 0 }
    ])).toBe(true);
    expect(shouldTriggerValueSuggestions([
      { text: "preference: ", rangeLength: 0 }
    ])).toBe(true);
  });

  it("does not trigger value suggestions for unrelated insertions", () => {
    expect(shouldTriggerValueSuggestions([
      { text: " ", rangeLength: 0 }
    ])).toBe(false);
    expect(shouldTriggerValueSuggestions([
      { text: "a", rangeLength: 0 }
    ])).toBe(false);
    expect(shouldTriggerValueSuggestions([
      { text: ":\n", rangeLength: 0 }
    ])).toBe(false);
  });

  it("keeps value suggestions alive for spaces and tabs while armed", () => {
    expect(shouldKeepValueSuggestions([
      { text: " ", rangeLength: 0 }
    ], {
      valueSuggestionsArmed: true
    })).toBe(true);
    expect(shouldKeepValueSuggestions([
      { text: "\t", rangeLength: 0 }
    ], {
      valueSuggestionsArmed: true
    })).toBe(true);
  });

  it("does not keep value suggestions alive when unarmed or on non-whitespace", () => {
    expect(shouldKeepValueSuggestions([
      { text: " ", rangeLength: 0 }
    ], {
      valueSuggestionsArmed: false
    })).toBe(false);
    expect(shouldKeepValueSuggestions([
      { text: "\"", rangeLength: 0 }
    ], {
      valueSuggestionsArmed: true
    })).toBe(false);
  });

  it("triggers member suggestions after property-reference operators", () => {
    expect(shouldTriggerMemberSuggestions([
      { text: ":", rangeLength: 0 }
    ], "center::")).toBe(true);
    expect(shouldTriggerMemberSuggestions([
      { text: "x", rangeLength: 0 }
    ], "center::x")).toBe(true);
  });

  it("does not trigger member suggestions after a single colon", () => {
    expect(shouldTriggerMemberSuggestions([
      { text: ":", rangeLength: 0 }
    ], "center:")).toBe(false);
  });
});
