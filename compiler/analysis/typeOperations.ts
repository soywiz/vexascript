/**
 * Pure type-manipulation helpers. All functions are stateless and depend only
 * on their parameters plus the shared AnalysisType algebra.
 */
import { type AnalysisType, NamedType, UnionType, ArrayType, TupleType, RangeType } from "./types";
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
  if (!(type instanceof NamedType) || type.name !== "Promise") {
    return null;
  }
  return type.typeArguments?.[0] ?? UNKNOWN_TYPE;
}

/** Returns true when the type is a union that contains at least one null or undefined member. */
export function hasNullishUnionMember(type: AnalysisType): boolean {
  return type instanceof UnionType && type.types.some((member) => isNullishType(member));
}

/** Strips null and undefined members from a union type, collapsing the result. */
export function removeNullishFromType(type: AnalysisType): AnalysisType {
  if (!(type instanceof UnionType)) {
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
  if (argumentType instanceof ArrayType) {
    return argumentType.elementType;
  }
  if (argumentType instanceof TupleType) {
    return argumentType.elements.length === 1 ? argumentType.elements[0]! : unionType(argumentType.elements);
  }
  if (argumentType instanceof NamedType && argumentType.name === "Array" && argumentType.typeArguments?.[0]) {
    return argumentType.typeArguments[0];
  }
  return UNKNOWN_TYPE;
}

/** Returns the element type for an iterable type, or `unknown` when not iterable. */
export function elementTypeFromIterable(type: AnalysisType): AnalysisType {
  if (type instanceof ArrayType) {
    return type.elementType;
  }
  if (type instanceof RangeType) {
    return type.elementType;
  }
  if (type instanceof NamedType && ITERABLE_TYPE_NAMES.has(type.name) && (type.typeArguments?.length ?? 0) >= 1) {
    return type.typeArguments![0]!;
  }
  return UNKNOWN_TYPE;
}

/** Returns true when the type is an async iterator or async generator. */
export function isAsyncIteratorType(type: AnalysisType): boolean {
  return type instanceof NamedType && ASYNC_ITERATOR_TYPE_NAMES.has(type.name);
}

/**
 * Parses a literal type name (`"str"`, `'str'`, `true`, `false`, or a numeric
 * literal) into its corresponding AnalysisType. Returns null for all other names.
 */
export function resolveLiteralTypeName(typeName: string): AnalysisType | null {
  if (isQuotedLiteralTypeName(typeName)) {
    return literalType("string", typeName.slice(1, -1));
  }
  if (typeName === "true") {
    return literalType("boolean", true);
  }
  if (typeName === "false") {
    return literalType("boolean", false);
  }
  if (isDecimalLiteralTypeName(typeName)) {
    return literalType("number", Number(typeName));
  }
  return null;
}

function isQuotedLiteralTypeName(typeName: string): boolean {
  if (typeName.length < 2) return false;
  const quote = typeName[0];
  if ((quote !== '"' && quote !== "'") || typeName[typeName.length - 1] !== quote) return false;

  for (let index = 1; index < typeName.length - 1; index += 1) {
    const character = typeName[index];
    if (character === "\\") {
      if (index + 1 >= typeName.length - 1) return false;
      index += 1;
    } else if (character === quote) {
      return false;
    }
  }
  return true;
}

function isDecimalLiteralTypeName(typeName: string): boolean {
  let index = typeName.startsWith("-") ? 1 : 0;
  const integerStart = index;
  while (index < typeName.length && isAsciiDigit(typeName.charCodeAt(index))) index += 1;
  if (index === integerStart) return false;

  if (typeName[index] === ".") {
    index += 1;
    const fractionalStart = index;
    while (index < typeName.length && isAsciiDigit(typeName.charCodeAt(index))) index += 1;
    if (index === fractionalStart) return false;
  }

  if (typeName[index] === "e" || typeName[index] === "E") {
    index += 1;
    if (typeName[index] === "+" || typeName[index] === "-") index += 1;
    const exponentStart = index;
    while (index < typeName.length && isAsciiDigit(typeName.charCodeAt(index))) index += 1;
    if (index === exponentStart) return false;
  }

  return index === typeName.length;
}

function isAsciiDigit(character: number): boolean {
  return character >= 48 && character <= 57;
}
