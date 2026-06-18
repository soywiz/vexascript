/**
 * Pure type-manipulation helpers. All functions are stateless and depend only
 * on their parameters plus the shared AnalysisType algebra.
 */
import type { AnalysisType } from "./types";
import { UNKNOWN_TYPE, builtinType, isSameType, literalType, unionType } from "./types";
import { isNullishType } from "./typeClassifiers";

const ASYNC_ITERATOR_TYPE_NAMES = new Set([
  "AsyncGenerator", "AsyncIterator", "AsyncIteratorObject"
]);

const ITERABLE_TYPE_NAMES = new Set([
  "AsyncGenerator", "AsyncIterator", "AsyncIteratorObject",
  "Generator", "Iterator", "IteratorObject", "IterableIterator", "Iterable"
]);

/** Builds a deduplicated union from a list of types, collapsing singletons. */
export function combineTypes(types: AnalysisType[]): AnalysisType {
  const uniqueTypes: AnalysisType[] = [];
  for (const type of types) {
    if (!uniqueTypes.some((existing) => isSameType(existing, type))) {
      uniqueTypes.push(type);
    }
  }
  if (uniqueTypes.length === 0) {
    return builtinType("void");
  }
  if (uniqueTypes.length === 1) {
    return uniqueTypes[0]!;
  }
  return unionType(uniqueTypes);
}

/** Extracts `T` from `Promise<T>`, or returns null for non-Promise types. */
export function unwrapPromiseType(type: AnalysisType): AnalysisType | null {
  if (type.kind !== "named" || type.name !== "Promise") {
    return null;
  }
  return type.typeArguments?.[0] ?? UNKNOWN_TYPE;
}

/** Returns true when the type is a union that contains at least one null or undefined member. */
export function hasNullishUnionMember(type: AnalysisType): boolean {
  return type.kind === "union" && type.types.some((member) => isNullishType(member));
}

/** Strips null and undefined members from a union type, collapsing the result. */
export function removeNullishFromType(type: AnalysisType): AnalysisType {
  if (type.kind !== "union") {
    return type;
  }
  const nonNullishTypes = type.types.filter((member) => !isNullishType(member));
  if (nonNullishTypes.length === 0) {
    return UNKNOWN_TYPE;
  }
  return nonNullishTypes.length === 1 ? nonNullishTypes[0]! : unionType(nonNullishTypes);
}

/**
 * Returns the element type carried by a spread argument. Handles array
 * literals, tuples, and `Array<T>` generics; falls back to `unknown`.
 */
export function spreadArgumentElementType(argumentType: AnalysisType): AnalysisType {
  if (argumentType.kind === "array") {
    return argumentType.elementType;
  }
  if (argumentType.kind === "tuple") {
    return argumentType.elements.length === 1 ? argumentType.elements[0]! : unionType(argumentType.elements);
  }
  if (argumentType.kind === "named" && argumentType.name === "Array" && argumentType.typeArguments?.[0]) {
    return argumentType.typeArguments[0];
  }
  return UNKNOWN_TYPE;
}

/** Returns the element type for an iterable type, or `unknown` when not iterable. */
export function elementTypeFromIterable(type: AnalysisType): AnalysisType {
  if (type.kind === "array") {
    return type.elementType;
  }
  if (type.kind === "range") {
    return type.elementType;
  }
  if (type.kind === "named" && ITERABLE_TYPE_NAMES.has(type.name) && (type.typeArguments?.length ?? 0) >= 1) {
    return type.typeArguments![0]!;
  }
  return UNKNOWN_TYPE;
}

/** Returns true when the type is an async iterator or async generator. */
export function isAsyncIteratorType(type: AnalysisType): boolean {
  return type.kind === "named" && ASYNC_ITERATOR_TYPE_NAMES.has(type.name);
}

/**
 * Parses a literal type name (`"str"`, `'str'`, `true`, `false`, or a numeric
 * literal) into its corresponding AnalysisType. Returns null for all other names.
 */
export function resolveLiteralTypeName(typeName: string): AnalysisType | null {
  if ((typeName.startsWith('"') && typeName.endsWith('"')) || (typeName.startsWith("'") && typeName.endsWith("'"))) {
    return literalType("string", typeName.slice(1, -1));
  }
  if (typeName === "true") {
    return literalType("boolean", true);
  }
  if (typeName === "false") {
    return literalType("boolean", false);
  }
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(typeName)) {
    return literalType("number", Number(typeName));
  }
  return null;
}
