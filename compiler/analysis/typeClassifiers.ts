import { BuiltinType, LiteralType } from "./types";
/**
 * Pure type-predicate helpers that classify AnalysisType values by their
 * built-in name or literal base. These functions have no dependency on
 * checker state and can be used by any analysis pass.
 */
import type { AnalysisType } from "./types";

export function isIntType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return (
    (type instanceof BuiltinType && type.name === "int") ||
    (type instanceof LiteralType && type.base === "number" && Number.isInteger(type.value))
  );
}

export function isStringLikeType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return (
    (type instanceof BuiltinType && type.name === "string") ||
    (type instanceof LiteralType && type.base === "string")
  );
}

export function isBigIntType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return type instanceof BuiltinType && type.name === "bigint";
}

export function isLongType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return type instanceof BuiltinType && type.name === "long";
}

export function isNumberType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return (
    (type instanceof BuiltinType && (type.name === "int" || type.name === "number")) ||
    (type instanceof LiteralType && type.base === "number")
  );
}

export function isNumericType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return type instanceof BuiltinType && type.name === "numeric";
}

/**
 * Whether a type belongs to the numeric tower rooted at `numeric`:
 * `numeric` itself, the integer family (`int`/`number` and numeric literals)
 * and the big-integer family (`long`/`bigint`).
 */
export function isNumericFamilyType(type: AnalysisType | null | undefined): boolean {
  return isNumericType(type) || isNumberType(type) || isLongType(type) || isBigIntType(type);
}

export function isNullishType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  return type instanceof BuiltinType && (type.name === "null" || type.name === "undefined");
}

export function isPrimitiveLikeOperatorType(type: AnalysisType | null | undefined): boolean {
  if (!type) return false;
  if (type instanceof BuiltinType) {
    return (
      type.name === "int" ||
      type.name === "number" ||
      type.name === "string" ||
      type.name === "boolean" ||
      type.name === "bigint" ||
      type.name === "long" ||
      type.name === "any" ||
      type.name === "void" ||
      type.name === "null" ||
      type.name === "undefined"
    );
  }
  if (type instanceof LiteralType) {
    return true;
  }
  return false;
}
