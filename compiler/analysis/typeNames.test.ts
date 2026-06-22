import { describe, expect, it } from "../test/expect";
import {
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  looksLikeFunctionTypeAnnotation,
  parseMappedTypeMemberText,
  parseAssertionTypePredicateText,
  parseReadonlyContainerTypeText,
  parseObjectTypeAnnotation,
  parseFunctionTypeAnnotation,
  splitArraySuffixTypeName,
  splitIndexedAccessTypeName,
  splitOptionalTypeSuffix,
  substituteTypeNameText,
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

describe("parseFunctionTypeAnnotation", () => {
  it("parses a simple function type with named parameters", () => {
    const result = parseFunctionTypeAnnotation("(x: string, y: number) => boolean");
    expect(result).toEqual({
      parameters: [
        { name: "x", typeName: "string" },
        { name: "y", typeName: "number" }
      ],
      returnTypeName: "boolean"
    });
  });

  it("parses a function type with no parameters", () => {
    const result = parseFunctionTypeAnnotation("() => void");
    expect(result).toEqual({ parameters: [], returnTypeName: "void" });
  });

  it("assigns generated names for untyped positional parameters", () => {
    const result = parseFunctionTypeAnnotation("(string, number) => void");
    expect(result?.parameters[0]?.name).toBe("arg1");
    expect(result?.parameters[0]?.typeName).toBe("string");
  });

  it("parses optional parameters", () => {
    const result = parseFunctionTypeAnnotation("(x?: string) => void");
    expect(result?.parameters[0]?.optional).toBe(true);
  });

  it("parses rest parameters", () => {
    const result = parseFunctionTypeAnnotation("(...args: string[]) => void");
    expect(result?.parameters[0]?.rest).toBe(true);
    expect(result?.parameters[0]?.typeName).toBe("string[]");
  });

  it("parses abstract constructor signatures", () => {
    const result = parseFunctionTypeAnnotation("abstract new (name: string, age: number) => User");
    expect(result).toEqual({
      parameters: [
        { name: "name", typeName: "string" },
        { name: "age", typeName: "number" }
      ],
      returnTypeName: "User",
      constructor: true
    });
  });

  it("preserves TypeScript assertion return types", () => {
    const result = parseFunctionTypeAnnotation("(value: unknown) => asserts value is string");
    expect(result).toEqual({
      parameters: [
        { name: "value", typeName: "unknown" }
      ],
      returnTypeName: "asserts value is string"
    });
  });

  it("parses compact generic constraints from imported declaration text", () => {
    const result = parseFunctionTypeAnnotation("<TextendsZodRawShape>(shape: T) => ZodObject<T>");
    expect(result).toEqual({
      parameters: [
        { name: "shape", typeName: "T" }
      ],
      returnTypeName: "ZodObject<T>",
      typeParameters: ["T"],
      typeParameterConstraints: {
        T: "ZodRawShape"
      }
    });
  });

  it("returns null for a non-function type text", () => {
    expect(parseFunctionTypeAnnotation("string")).toBeNull();
    expect(parseFunctionTypeAnnotation("{ x: number }")).toBeNull();
  });
});

describe("parseAssertionTypePredicateText", () => {
  it("parses a typed assertion predicate", () => {
    expect(parseAssertionTypePredicateText("asserts value is string")).toEqual({
      targetText: "value",
      assertedTypeText: "string"
    });
  });

  it("parses a bare truthy assertion predicate", () => {
    expect(parseAssertionTypePredicateText("asserts value")).toEqual({
      targetText: "value"
    });
  });

  it("returns null for non-assertion text", () => {
    expect(parseAssertionTypePredicateText("string")).toBeNull();
  });
});

describe("parseObjectTypeAnnotation", () => {
  it("parses a simple object type", () => {
    const result = parseObjectTypeAnnotation("{ name: string; age: number }");
    expect(result).toEqual([
      { name: "name", typeName: "string" },
      { name: "age", typeName: "number" }
    ]);
  });

  it("returns an empty array for an empty object type", () => {
    expect(parseObjectTypeAnnotation("{}")).toEqual([]);
  });

  it("parses optional properties", () => {
    const result = parseObjectTypeAnnotation("{ x?: number }");
    expect(result?.[0]?.optional).toBe(true);
    expect(result?.[0]?.name).toBe("x");
  });

  it("preserves readonly on property members", () => {
    const result = parseObjectTypeAnnotation("{ readonly x: string }");
    expect(result?.[0]?.name).toBe("x");
    expect(result?.[0]?.readonly).toBe(true);
  });

  it("returns null for a non-object type text", () => {
    expect(parseObjectTypeAnnotation("string")).toBeNull();
    expect(parseObjectTypeAnnotation("(x: string) => void")).toBeNull();
  });

  it("parses a constructor signature", () => {
    const result = parseObjectTypeAnnotation("{ new(x: string): MyClass }");
    expect(result?.[0]?.name).toBe("constructor");
  });
});

describe("looksLikeFunctionTypeAnnotation", () => {
  it("returns true when the text contains =>", () => {
    expect(looksLikeFunctionTypeAnnotation("(x: string) => void")).toBe(true);
  });

  it("returns false when the text has no =>", () => {
    expect(looksLikeFunctionTypeAnnotation("string")).toBe(false);
    expect(looksLikeFunctionTypeAnnotation("{ x: number }")).toBe(false);
  });
});

describe("splitArraySuffixTypeName", () => {
  it("strips a single [] suffix", () => {
    expect(splitArraySuffixTypeName("string[]")).toEqual({ elementTypeName: "string", arrayDepth: 1 });
  });

  it("strips multiple [] suffixes", () => {
    expect(splitArraySuffixTypeName("number[][]")).toEqual({ elementTypeName: "number", arrayDepth: 2 });
  });

  it("returns null when there is no [] suffix", () => {
    expect(splitArraySuffixTypeName("string")).toBeNull();
  });

  it("returns null for an empty element name", () => {
    expect(splitArraySuffixTypeName("[]")).toBeNull();
  });

  it("handles generic types with array suffix", () => {
    expect(splitArraySuffixTypeName("Array<string>[]")).toEqual({ elementTypeName: "Array<string>", arrayDepth: 1 });
  });
});

describe("splitIndexedAccessTypeName", () => {
  it("splits a simple T[K] form", () => {
    expect(splitIndexedAccessTypeName("Record[string]")).toEqual({
      objectTypeName: "Record",
      indexTypeName: "string",
    });
  });

  it("handles generics in the object type", () => {
    expect(splitIndexedAccessTypeName("Map<string, int>[string]")).toEqual({
      objectTypeName: "Map<string, int>",
      indexTypeName: "string",
    });
  });

  it("returns null when there is no ] at the end", () => {
    expect(splitIndexedAccessTypeName("string")).toBeNull();
  });

  it("returns null for array types (empty object part)", () => {
    expect(splitIndexedAccessTypeName("[]")).toBeNull();
  });

  it("returns null when the index part is empty", () => {
    expect(splitIndexedAccessTypeName("T[]")).toBeNull();
  });
});

describe("substituteTypeNameText", () => {
  it("substitutes type parameters nested inside function and union type text", () => {
    const substitutions = new Map<string, string>([
      ["P", "{}"],
      ["S", "{ time: number }"]
    ]);

    expect(substituteTypeNameText(
      "((prevState: Readonly<S>, props: Readonly<P>) => Pick<S, K> | Partial<S> | null) | (Pick<S, K> | Partial<S> | null)",
      substitutions
    )).toBe(
      "((prevState: Readonly<{ time: number }>, props: Readonly<{}>) => Pick<{ time: number }, K> | Partial<{ time: number }> | null) | (Pick<{ time: number }, K> | Partial<{ time: number }> | null)"
    );
  });

  it("does not rewrite parameter labels while substituting their type annotations", () => {
    const substitutions = new Map<string, string>([["T", "string"]]);

    expect(substituteTypeNameText("(value: T, next?: T) => T", substitutions)).toBe(
      "(value: string, next?: string) => string"
    );
  });
});

describe("parseReadonlyContainerTypeText", () => {
  it("parses readonly array shorthand", () => {
    expect(parseReadonlyContainerTypeText("readonly string[]")).toEqual({
      kind: "array",
      elementTypeText: "string"
    });
  });

  it("parses readonly tuple shorthand", () => {
    expect(parseReadonlyContainerTypeText("readonly [name: string, count: number]")).toEqual({
      kind: "tuple",
      tupleElementTypeTexts: ["string", "number"]
    });
  });

  it("parses readonly tuple shorthand without whitespace before the tuple", () => {
    expect(parseReadonlyContainerTypeText("readonly[ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]")).toEqual({
      kind: "tuple",
      tupleElementTypeTexts: ["ZodTypeAny", "ZodTypeAny", "ZodTypeAny[]"]
    });
  });

  it("returns null for non-readonly containers", () => {
    expect(parseReadonlyContainerTypeText("string[]")).toBeNull();
  });
});

describe("parseMappedTypeMemberText", () => {
  it("parses mapped members with key remapping and modifiers", () => {
    expect(parseMappedTypeMemberText('[K in keyof T as `label_${K}`]-?: T[K]')).toEqual({
      keyParameterName: "K",
      keySourceText: "keyof T",
      keyRemapText: "`label_${K}`",
      optionalModifier: "-?",
      valueTypeText: "T[K]"
    });
  });

  it("parses readonly mapped members", () => {
    expect(parseMappedTypeMemberText('-readonly [K in keyof T as Exclude<K, "skip">]: T[K]')).toEqual({
      readonlyModifier: "-readonly",
      keyParameterName: "K",
      keySourceText: "keyof T",
      keyRemapText: 'Exclude<K, "skip">',
      valueTypeText: "T[K]"
    });
  });
});
