import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";
import { formatFunctionTypeLabel, formatParameterLabel } from "./classResolver";

describe("formatParameterLabel", () => {
  it("renders a plain required parameter", () => {
    expect(formatParameterLabel({ name: "value", typeName: "string" })).toBe("value: string");
  });

  it("renders an optional parameter with a trailing question mark", () => {
    expect(formatParameterLabel({ name: "value", typeName: "string", optional: true })).toBe("value?: string");
  });

  it("renders a rest parameter with a leading ellipsis and no question mark", () => {
    expect(formatParameterLabel({ name: "items", typeName: "string[]", optional: true, rest: true })).toBe("...items: string[]");
  });
});

describe("formatFunctionTypeLabel", () => {
  it("renders a function type label from resolved parameters", () => {
    const label = formatFunctionTypeLabel(
      [
        { name: "first", typeName: "string" },
        { name: "second", typeName: "number", optional: true }
      ],
      "boolean"
    );
    expect(label).toBe("(first: string, second?: number) => boolean");
  });

  it("renders a rest parameter inline with the rest of the signature", () => {
    const label = formatFunctionTypeLabel(
      [{ name: "first", typeName: "string" }, { name: "rest", typeName: "string[]", rest: true }],
      "void"
    );
    expect(label).toBe("(first: string, ...rest: string[]) => void");
  });

  it("prefixes generic type parameters when provided", () => {
    const label = formatFunctionTypeLabel(
      [{ name: "value", typeName: "T" }],
      "T",
      ["T"]
    );
    expect(label).toBe("<T>(value: T) => T");
  });

  it("renders an empty parameter list", () => {
    expect(formatFunctionTypeLabel([], "void")).toBe("() => void");
  });
});
