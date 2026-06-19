import { describe, expect, it } from "compiler/test/expect";
import { shouldKeepValueSuggestions, shouldTriggerValueSuggestions } from "./suggestTrigger";

describe("monaco suggest trigger helper", () => {
  it("triggers value suggestions after ':' insertions", () => {
    expect(shouldTriggerValueSuggestions([{ text: ":", rangeLength: 0 }])).toBe(true);
    expect(shouldTriggerValueSuggestions([{ text: ": ", rangeLength: 0 }])).toBe(true);
    expect(shouldTriggerValueSuggestions([{ text: "preference: ", rangeLength: 0 }])).toBe(true);
  });

  it("keeps value suggestions alive for spaces and tabs while armed", () => {
    expect(shouldKeepValueSuggestions([{ text: " ", rangeLength: 0 }], true)).toBe(true);
    expect(shouldKeepValueSuggestions([{ text: "\t", rangeLength: 0 }], true)).toBe(true);
  });

  it("does not keep value suggestions alive when unarmed or on non-whitespace", () => {
    expect(shouldKeepValueSuggestions([{ text: " ", rangeLength: 0 }], false)).toBe(false);
    expect(shouldKeepValueSuggestions([{ text: "\"", rangeLength: 0 }], true)).toBe(false);
  });
});
