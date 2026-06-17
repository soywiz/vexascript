import { describe, expect, it } from "../test/expect";
import {
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  splitOptionalTypeSuffix,
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

  it("splits optional type suffixes only when the trailing '?' is top-level", () => {
    expect(splitOptionalTypeSuffix("string?")).toEqual({ typeName: "string", optional: true });
    expect(splitOptionalTypeSuffix("(() => void)?")).toEqual({ typeName: "(() => void)", optional: true });
    expect(splitOptionalTypeSuffix("T extends U ? X : Y")).toEqual({ typeName: "T extends U ? X : Y", optional: false });
    expect(splitOptionalTypeSuffix("[EventTarget?]")).toEqual({ typeName: "[EventTarget?]", optional: false });
  });
});
