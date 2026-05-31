export type BuiltinTypeName =
  | "int"
  | "number"
  | "string"
  | "boolean"
  | "bigint"
  | "long"
  | "null"
  | "undefined";

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
  parameters: Array<{ name: string; type: AnalysisType; optional?: boolean }>;
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
  bigint: { kind: "builtin", name: "bigint" },
  long: { kind: "builtin", name: "long" },
  null: { kind: "builtin", name: "null" },
  undefined: { kind: "builtin", name: "undefined" }
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
  parameters: Array<{ name: string; type: AnalysisType; optional?: boolean }>,
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

export function typeToString(type: AnalysisType): string {
  switch (type.kind) {
    case "unknown":
      return "unknown";
    case "builtin":
      return type.name;
    case "named":
      if (!type.typeArguments || type.typeArguments.length === 0) {
        return type.name;
      }
      return `${type.name}<${type.typeArguments.map((argument) => typeToString(argument)).join(", ")}>`;
    case "function":
      return `(${type.parameters
        .map((parameter) => `${parameter.name}: ${typeToString(parameter.type)}`)
        .join(", ")}) => ${typeToString(type.returnType)}`;
    case "array":
      return `${typeToString(type.elementType)}[]`;
    case "object":
      if (Object.keys(type.properties).length === 0) {
        return "object";
      }
      return `{ ${Object.entries(type.properties)
        .map(([name, propertyType]) => `${name}: ${typeToString(propertyType)}`)
        .join(", ")} }`;
    case "range":
      return `range<${typeToString(type.elementType)}>`;
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
    if (a.name !== b.name) {
      return false;
    }
    const aArgs = a.typeArguments ?? [];
    const bArgs = b.typeArguments ?? [];
    if (aArgs.length !== bArgs.length) {
      return false;
    }
    for (let i = 0; i < aArgs.length; i += 1) {
      if (!isSameType(aArgs[i]!, bArgs[i]!)) {
        return false;
      }
    }
    return true;
  }

  if (a.kind === "unknown" && b.kind === "unknown") {
    return true;
  }

  if (a.kind === "array" && b.kind === "array") {
    return isSameType(a.elementType, b.elementType);
  }

  if (a.kind === "range" && b.kind === "range") {
    return isSameType(a.elementType, b.elementType);
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
      if (!aProperty || !bProperty || !isSameType(aProperty, bProperty)) {
        return false;
      }
    }
    return true;
  }

  if (a.kind === "function" && b.kind === "function") {
    if (a.parameters.length !== b.parameters.length) {
      return false;
    }
    for (let i = 0; i < a.parameters.length; i += 1) {
      if ((a.parameters[i]!.optional ?? false) !== (b.parameters[i]!.optional ?? false)) {
        return false;
      }
      if (!isSameType(a.parameters[i]!.type, b.parameters[i]!.type)) {
        return false;
      }
    }
    return isSameType(a.returnType, b.returnType);
  }

  return typeToString(a) === typeToString(b);
}
