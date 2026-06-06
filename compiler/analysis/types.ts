export type BuiltinTypeName =
  | "int"
  | "number"
  | "numeric"
  | "string"
  | "boolean"
  | "bigint"
  | "long"
  | "void"
  | "null"
  | "undefined"
  | "any"
  | "unknown"
  | "never"
  | "object"
  | "symbol";

/**
 * Runtime set of the built-in type names listed in {@link BuiltinTypeName}.
 * Shared single source of truth so the binder, type checker and tooling all
 * agree on which type names are intrinsic and should not be resolved as
 * user-declared classes/interfaces.
 */
export const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set<BuiltinTypeName>([
  "int",
  "number",
  "numeric",
  "string",
  "boolean",
  "bigint",
  "long",
  "void",
  "null",
  "undefined",
  "any",
  "unknown",
  "never",
  "object",
  "symbol"
]);

export interface UnknownType {
  kind: "unknown";
}

export interface BuiltinType {
  kind: "builtin";
  name: BuiltinTypeName;
}

export interface NamedType {
  kind: "named";
  name: string;
  typeArguments?: AnalysisType[];
}

export interface FunctionType {
  kind: "function";
  typeParameters?: string[];
  typeParameterConstraints?: Record<string, AnalysisType>;
  parameters: Array<{ name: string; type: AnalysisType; optional?: boolean; rest?: boolean }>;
  returnType: AnalysisType;
}

export interface ArrayType {
  kind: "array";
  elementType: AnalysisType;
}

export interface ObjectType {
  kind: "object";
  properties: Record<string, AnalysisType>;
}

export interface RangeType {
  kind: "range";
  elementType: AnalysisType;
}

export interface UnionType {
  kind: "union";
  types: AnalysisType[];
}

export interface IntersectionType {
  kind: "intersection";
  types: AnalysisType[];
}

export interface LiteralType {
  kind: "literal";
  base: "string" | "number" | "boolean";
  value: string | number | boolean;
}

export interface TupleType {
  kind: "tuple";
  elements: AnalysisType[];
}

export type AnalysisType =
  | UnknownType
  | BuiltinType
  | NamedType
  | FunctionType
  | ArrayType
  | ObjectType
  | RangeType
  | UnionType
  | IntersectionType
  | LiteralType
  | TupleType;

export const UNKNOWN_TYPE: AnalysisType = { kind: "unknown" };

export const BUILTIN_TYPES: Record<BuiltinTypeName, BuiltinType> = {
  int: { kind: "builtin", name: "int" },
  number: { kind: "builtin", name: "number" },
  numeric: { kind: "builtin", name: "numeric" },
  string: { kind: "builtin", name: "string" },
  boolean: { kind: "builtin", name: "boolean" },
  bigint: { kind: "builtin", name: "bigint" },
  long: { kind: "builtin", name: "long" },
  void: { kind: "builtin", name: "void" },
  null: { kind: "builtin", name: "null" },
  undefined: { kind: "builtin", name: "undefined" },
  any: { kind: "builtin", name: "any" },
  unknown: { kind: "builtin", name: "unknown" },
  never: { kind: "builtin", name: "never" },
  object: { kind: "builtin", name: "object" },
  symbol: { kind: "builtin", name: "symbol" }
};

export function builtinType(name: BuiltinTypeName): BuiltinType {
  return BUILTIN_TYPES[name];
}

export function namedType(name: string, typeArguments?: AnalysisType[]): NamedType {
  return {
    kind: "named",
    name,
    ...(typeArguments && typeArguments.length > 0 ? { typeArguments } : {})
  };
}

export function functionType(
  parameters: Array<{ name: string; type: AnalysisType; optional?: boolean; rest?: boolean }>,
  returnType: AnalysisType,
  typeParameters?: string[],
  typeParameterConstraints?: Record<string, AnalysisType>
): FunctionType {
  return {
    kind: "function",
    ...(typeParameters && typeParameters.length > 0 ? { typeParameters } : {}),
    ...(typeParameterConstraints && Object.keys(typeParameterConstraints).length > 0
      ? { typeParameterConstraints }
      : {}),
    parameters,
    returnType
  };
}

export function arrayType(elementType: AnalysisType = UNKNOWN_TYPE): ArrayType {
  return {
    kind: "array",
    elementType
  };
}

export function objectType(): ObjectType {
  return { kind: "object", properties: {} };
}

export function objectTypeWithProperties(properties: Record<string, AnalysisType>): ObjectType {
  return { kind: "object", properties };
}

export function rangeType(elementType: AnalysisType = builtinType("int")): RangeType {
  return {
    kind: "range",
    elementType
  };
}

export function unionType(types: AnalysisType[]): UnionType {
  return { kind: "union", types };
}

export function intersectionType(types: AnalysisType[]): IntersectionType {
  return { kind: "intersection", types };
}

export function literalType(base: LiteralType["base"], value: LiteralType["value"]): LiteralType {
  return { kind: "literal", base, value };
}

export function tupleType(elements: AnalysisType[]): TupleType {
  return { kind: "tuple", elements };
}

export function typeToString(type: AnalysisType): string {
  return typeToStringInternal(type, new Set<object>());
}

function typeToStringInternal(type: AnalysisType, seen: Set<object>): string {
  let trackedObject: object | undefined;
  if (typeof type === "object" && type !== null) {
    if (seen.has(type as object)) {
      if (type.kind === "named") {
        return type.name;
      }
      return type.kind;
    }
    trackedObject = type as object;
    seen.add(trackedObject);
  }
  try {
    switch (type.kind) {
      case "unknown":
        return "unknown";
      case "builtin":
        return type.name;
      case "named":
        if (!type.typeArguments || type.typeArguments.length === 0) {
          return type.name;
        }
        return `${type.name}<${type.typeArguments.map((argument) => typeToStringInternal(argument, seen)).join(", ")}>`;
      case "function": {
        const typeParameterPrefix = type.typeParameters && type.typeParameters.length > 0
          ? `<${type.typeParameters.map((parameter) => {
              const constraint = type.typeParameterConstraints?.[parameter];
              return constraint ? `${parameter} extends ${typeToStringInternal(constraint, seen)}` : parameter;
            }).join(", ")}>`
          : "";
        return `${typeParameterPrefix}(${type.parameters
          .map((parameter) => `${parameter.rest ? "..." : ""}${parameter.name}: ${typeToStringInternal(parameter.type, seen)}`)
          .join(", ")}) => ${typeToStringInternal(type.returnType, seen)}`;
      }
      case "array":
        return `${typeToStringInternal(type.elementType, seen)}[]`;
      case "object":
        if (Object.keys(type.properties).length === 0) {
          return "object";
        }
        return `{ ${Object.entries(type.properties)
          .map(([name, propertyType]) => `${name}: ${typeToStringInternal(propertyType, seen)}`)
          .join(", ")} }`;
      case "range":
        return `range<${typeToStringInternal(type.elementType, seen)}>`;
      case "union":
        return type.types.map((member) => typeToStringInternal(member, seen)).join(" | ");
      case "intersection":
        return type.types.map((member) => typeToStringInternal(member, seen)).join(" & ");
      case "literal":
        return type.base === "string" ? JSON.stringify(type.value) : String(type.value);
      case "tuple":
        return `[${type.elements.map((element) => typeToStringInternal(element, seen)).join(", ")}]`;
      default:
        return "unknown";
    }
  } finally {
    if (trackedObject) {
      seen.delete(trackedObject);
    }
  }
}

export function isUnknownType(type: AnalysisType): boolean {
  return type.kind === "unknown";
}

export function isSameType(a: AnalysisType, b: AnalysisType): boolean {
  return isSameTypeInternal(a, b, new WeakMap<object, WeakSet<object>>());
}

function isSameTypeInternal(
  a: AnalysisType,
  b: AnalysisType,
  seenPairs: WeakMap<object, WeakSet<object>>
): boolean {
  if (a === b) {
    return true;
  }

  const seenTargets = seenPairs.get(a as object);
  if (seenTargets?.has(b as object)) {
    return true;
  }
  if (seenTargets) {
    seenTargets.add(b as object);
  } else {
    seenPairs.set(a as object, new WeakSet([b as object]));
  }

  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === "builtin" && b.kind === "builtin") {
    return a.name === b.name;
  }

  if (a.kind === "named" && b.kind === "named") {
    if (a.name !== b.name) {
      return false;
    }
    const aArgs = a.typeArguments ?? [];
    const bArgs = b.typeArguments ?? [];
    if (aArgs.length !== bArgs.length) {
      return false;
    }
    for (let i = 0; i < aArgs.length; i += 1) {
      if (!isSameTypeInternal(aArgs[i]!, bArgs[i]!, seenPairs)) {
        return false;
      }
    }
    return true;
  }

  if (a.kind === "unknown" && b.kind === "unknown") {
    return true;
  }

  if (a.kind === "array" && b.kind === "array") {
    return isSameTypeInternal(a.elementType, b.elementType, seenPairs);
  }

  if (a.kind === "range" && b.kind === "range") {
    return isSameTypeInternal(a.elementType, b.elementType, seenPairs);
  }

  if (a.kind === "object" && b.kind === "object") {
    const aKeys = Object.keys(a.properties).sort();
    const bKeys = Object.keys(b.properties).sort();
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) {
        return false;
      }
      const key = aKeys[i]!;
      const aProperty = a.properties[key];
      const bProperty = b.properties[key];
      if (!aProperty || !bProperty || !isSameTypeInternal(aProperty, bProperty, seenPairs)) {
        return false;
      }
    }
    return true;
  }

  if (a.kind === "union" && b.kind === "union") {
    if (a.types.length !== b.types.length) {
      return false;
    }
    return a.types.every((aType, index) => isSameTypeInternal(aType, b.types[index]!, seenPairs));
  }

  if (a.kind === "intersection" && b.kind === "intersection") {
    if (a.types.length !== b.types.length) {
      return false;
    }
    return a.types.every((aType, index) => isSameTypeInternal(aType, b.types[index]!, seenPairs));
  }

  if (a.kind === "literal" && b.kind === "literal") {
    return a.base === b.base && a.value === b.value;
  }

  if (a.kind === "tuple" && b.kind === "tuple") {
    if (a.elements.length !== b.elements.length) {
      return false;
    }
    return a.elements.every((element, index) => isSameTypeInternal(element, b.elements[index]!, seenPairs));
  }

  if (a.kind === "function" && b.kind === "function") {
    if (a.parameters.length !== b.parameters.length) {
      return false;
    }
    for (let i = 0; i < a.parameters.length; i += 1) {
      if ((a.parameters[i]!.optional ?? false) !== (b.parameters[i]!.optional ?? false)) {
        return false;
      }
      if ((a.parameters[i]!.rest ?? false) !== (b.parameters[i]!.rest ?? false)) {
        return false;
      }
      if (!isSameTypeInternal(a.parameters[i]!.type, b.parameters[i]!.type, seenPairs)) {
        return false;
      }
    }
    return isSameTypeInternal(a.returnType, b.returnType, seenPairs);
  }

  return typeToString(a) === typeToString(b);
}
