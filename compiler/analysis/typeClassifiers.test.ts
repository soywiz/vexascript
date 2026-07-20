import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisType, BuiltinTypeName } from "./types";
import { builtinType, literalType, namedType as createNamedType } from "./types";
import {
  isBigIntType,
  isIntType,
  isLongType,
  isNullishType,
  isNumberType,
  isNumericFamilyType,
  isNumericType,
  isPrimitiveLikeOperatorType,
  isStringLikeType,
} from "./typeClassifiers";

function builtin(name: string): AnalysisType {
  return builtinType(name as BuiltinTypeName);
}
function literal(base: string, value: string | number | boolean): AnalysisType {
  return literalType(base as "string" | "number" | "boolean", value);
}
function namedType(name: string): AnalysisType {
  return createNamedType(name);
}

describe("isIntType", () => {
  it("returns true for builtin int", () => {
    assert.equal(isIntType(builtin("int")), true);
  });

  it("returns true for integer numeric literal", () => {
    assert.equal(isIntType(literal("number", 42)), true);
  });

  it("returns false for float numeric literal", () => {
    assert.equal(isIntType(literal("number", 1.5)), false);
  });

  it("returns false for builtin number", () => {
    assert.equal(isIntType(builtin("number")), false);
  });

  it("returns false for string builtin", () => {
    assert.equal(isIntType(builtin("string")), false);
  });
});

describe("isStringLikeType", () => {
  it("returns true for builtin string", () => {
    assert.equal(isStringLikeType(builtin("string")), true);
  });

  it("returns true for string literal", () => {
    assert.equal(isStringLikeType(literal("string", "hello")), true);
  });

  it("returns false for number literal", () => {
    assert.equal(isStringLikeType(literal("number", 1)), false);
  });

  it("returns false for int builtin", () => {
    assert.equal(isStringLikeType(builtin("int")), false);
  });
});

describe("isBigIntType", () => {
  it("returns true for builtin bigint", () => {
    assert.equal(isBigIntType(builtin("bigint")), true);
  });

  it("returns false for long", () => {
    assert.equal(isBigIntType(builtin("long")), false);
  });

  it("returns false for int", () => {
    assert.equal(isBigIntType(builtin("int")), false);
  });
});

describe("isLongType", () => {
  it("returns true for builtin long", () => {
    assert.equal(isLongType(builtin("long")), true);
  });

  it("returns false for bigint", () => {
    assert.equal(isLongType(builtin("bigint")), false);
  });
});

describe("isNumberType", () => {
  it("returns true for builtin int", () => {
    assert.equal(isNumberType(builtin("int")), true);
  });

  it("returns true for builtin number", () => {
    assert.equal(isNumberType(builtin("number")), true);
  });

  it("returns true for numeric literal", () => {
    assert.equal(isNumberType(literal("number", 3)), true);
  });

  it("returns false for numeric builtin", () => {
    assert.equal(isNumberType(builtin("numeric")), false);
  });

  it("returns false for string", () => {
    assert.equal(isNumberType(builtin("string")), false);
  });
});

describe("isNumericType", () => {
  it("returns true for builtin numeric", () => {
    assert.equal(isNumericType(builtin("numeric")), true);
  });

  it("returns false for int", () => {
    assert.equal(isNumericType(builtin("int")), false);
  });

  it("returns false for number", () => {
    assert.equal(isNumericType(builtin("number")), false);
  });
});

describe("isNumericFamilyType", () => {
  it("returns true for numeric", () => {
    assert.equal(isNumericFamilyType(builtin("numeric")), true);
  });

  it("returns true for int", () => {
    assert.equal(isNumericFamilyType(builtin("int")), true);
  });

  it("returns true for number", () => {
    assert.equal(isNumericFamilyType(builtin("number")), true);
  });

  it("returns true for long", () => {
    assert.equal(isNumericFamilyType(builtin("long")), true);
  });

  it("returns true for bigint", () => {
    assert.equal(isNumericFamilyType(builtin("bigint")), true);
  });

  it("returns true for numeric literal", () => {
    assert.equal(isNumericFamilyType(literal("number", 5)), true);
  });

  it("returns false for string", () => {
    assert.equal(isNumericFamilyType(builtin("string")), false);
  });

  it("returns false for boolean", () => {
    assert.equal(isNumericFamilyType(builtin("boolean")), false);
  });
});

describe("isNullishType", () => {
  it("returns true for null", () => {
    assert.equal(isNullishType(builtin("null")), true);
  });

  it("returns true for undefined", () => {
    assert.equal(isNullishType(builtin("undefined")), true);
  });

  it("returns false for any", () => {
    assert.equal(isNullishType(builtin("any")), false);
  });

  it("returns false for string", () => {
    assert.equal(isNullishType(builtin("string")), false);
  });

  it("returns false for named type", () => {
    assert.equal(isNullishType(namedType("MyClass")), false);
  });
});

describe("isPrimitiveLikeOperatorType", () => {
  for (const name of ["int", "number", "string", "boolean", "bigint", "long", "any", "void", "null", "undefined"]) {
    it(`returns true for builtin ${name}`, () => {
      assert.equal(isPrimitiveLikeOperatorType(builtin(name)), true);
    });
  }

  it("returns true for literals", () => {
    assert.equal(isPrimitiveLikeOperatorType(literal("number", 1)), true);
    assert.equal(isPrimitiveLikeOperatorType(literal("string", "x")), true);
  });

  it("returns false for named types", () => {
    assert.equal(isPrimitiveLikeOperatorType(namedType("MyClass")), false);
  });

  it("returns false for object builtin-like names", () => {
    assert.equal(isPrimitiveLikeOperatorType(builtin("object")), false);
  });
});
