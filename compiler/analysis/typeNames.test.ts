import { describe, it } from "node:test";
import { expect } from "../../expect";
import {
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  splitTypeArgumentText
} from "./typeNames";

describe("type-name text structure", () => {
  it("splits only delimiters at the top structural level", () => {
    expect(splitTopLevelTypeText('{ value: string | int } | null', "|")).toEqual([
      "{ value: string | int }",
      "null"
    ]);
    expect(splitTypeArgumentText('string, { value: int, nested: [string, int] }')).toEqual([
      "string",
      "{ value: int, nested: [string, int] }"
    ]);
    expect(splitTopLevelDelimitedTypeText('left: { value: string; count: int }; right: boolean', new Set([";"]))).toEqual([
      "left: { value: string; count: int }",
      "right: boolean"
    ]);
  });

  it("finds top-level characters and matching delimiters while ignoring quoted text", () => {
    expect(findTopLevelTypeCharacter('{ value: "a:b" }: Result', ":")).toBe(16);
    expect(findMatchingTypeDelimiter('(value: "not )") => string', 0, "(", ")")).toBe(15);
  });
});
