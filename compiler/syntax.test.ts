import { describe, expect, it } from "./test/expect";
import { createPortableMonarchLanguage } from "./syntax";

describe("portable monarch syntax", () => {
  it("classifies type declaration keywords separately from identifiers", () => {
    const language = createPortableMonarchLanguage();
    const identifierRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`[A-Za-z_$][\w$]*`
    );

    expect(identifierRule?.cases?.["@typeKeywords"]).toBe("keywordType");
    expect(identifierRule?.cases?.["@functionKeywords"]).toBe("keywordFunction");
    expect(identifierRule?.cases?.["@modifierKeywords"]).toBe("keywordModifier");
    expect(language.declarationKeywords).toContain("val");
    expect(language.modifierKeywords).toContain("readonly");
    expect(language.modifierKeywords).toContain("fun");
    expect(language.functionKeywords).toEqual([]);
    expect(language.typeKeywords).toEqual(expect.arrayContaining([
      "class",
      "interface",
      "annotation",
      "enum",
      "extends",
      "implements"
    ]));
  });

  it("classifies annotation applications without swallowing their arguments", () => {
    const language = createPortableMonarchLanguage();
    const annotationRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`@[A-Za-z_$][\w$]*`
    );
    const stringRule = language.tokenizer["root"]?.find((rule) => rule.token === "string");
    const numberRule = language.tokenizer["root"]?.find((rule) => rule.token === "number.float");

    expect(annotationRule?.token).toBe("annotation");
    expect(stringRule?.match).toBe(String.raw`"([^"\\]|\\.)*"`);
    expect(numberRule?.match).toBe(String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[nNL])?\b`);
  });
});
