export type BuiltinTypeName = "int" | "number" | "string" | "boolean" | "null" | "undefined";

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
}

export interface FunctionType {
  kind: "function";
  parameters: Array<{ name: string; type: AnalysisType }>;
  returnType: AnalysisType;
}

export interface ArrayType {
  kind: "array";
  elementType: AnalysisType;
}

export interface ObjectType {
  kind: "object";
}

export interface RangeType {
  kind: "range";
  elementType: AnalysisType;
}

export type AnalysisType =
  | UnknownType
  | BuiltinType
  | NamedType
  | FunctionType
  | ArrayType
  | ObjectType
  | RangeType;

export const UNKNOWN_TYPE: AnalysisType = { kind: "unknown" };

export const BUILTIN_TYPES: Record<BuiltinTypeName, BuiltinType> = {
  int: { kind: "builtin", name: "int" },
  number: { kind: "builtin", name: "number" },
  string: { kind: "builtin", name: "string" },
  boolean: { kind: "builtin", name: "boolean" },
  null: { kind: "builtin", name: "null" },
  undefined: { kind: "builtin", name: "undefined" }
};

export function builtinType(name: BuiltinTypeName): BuiltinType {
  return BUILTIN_TYPES[name];
}

export function namedType(name: string): NamedType {
  return { kind: "named", name };
}

export function functionType(
  parameters: Array<{ name: string; type: AnalysisType }>,
  returnType: AnalysisType
): FunctionType {
  return {
    kind: "function",
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
  return { kind: "object" };
}

export function rangeType(elementType: AnalysisType = builtinType("int")): RangeType {
  return {
    kind: "range",
    elementType
  };
}

export function typeToString(type: AnalysisType): string {
  switch (type.kind) {
    case "unknown":
      return "unknown";
    case "builtin":
      return type.name;
    case "named":
      return type.name;
    case "function":
      return `(${type.parameters
        .map((parameter) => `${parameter.name}: ${typeToString(parameter.type)}`)
        .join(", ")}) => ${typeToString(type.returnType)}`;
    case "array":
      return "array";
    case "object":
      return "object";
    case "range":
      return "range";
    default:
      return "unknown";
  }
}

export function isUnknownType(type: AnalysisType): boolean {
  return type.kind === "unknown";
}

export function isSameType(a: AnalysisType, b: AnalysisType): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === "builtin" && b.kind === "builtin") {
    return a.name === b.name;
  }

  if (a.kind === "named" && b.kind === "named") {
    return a.name === b.name;
  }

  if (a.kind === "unknown" && b.kind === "unknown") {
    return true;
  }

  return typeToString(a) === typeToString(b);
}
