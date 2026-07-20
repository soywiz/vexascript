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

export type AnalysisTypeKind =
  | "unknown"
  | "builtin"
  | "named"
  | "function"
  | "array"
  | "object"
  | "range"
  | "union"
  | "intersection"
  | "literal"
  | "tuple";

export abstract class AnalysisTypeBase {
  declare private readonly __analysisTypeBrand: void;

  protected constructor(public kind: AnalysisTypeKind) {}
}

export class UnknownType extends AnalysisTypeBase {
  declare kind: "unknown";

  constructor() {
    super("unknown");
  }
}

export class BuiltinType extends AnalysisTypeBase {
  declare kind: "builtin";

  constructor(public name: BuiltinTypeName) {
    super("builtin");
  }
}

export class NamedType extends AnalysisTypeBase {
  declare kind: "named";

  constructor(public name: string, public typeArguments?: AnalysisType[]) {
    super("named");
  }
}

export interface FunctionTypeParameter {
  name: string;
  type: AnalysisType;
  optional?: boolean;
  rest?: boolean;
}

export class FunctionType extends AnalysisTypeBase {
  declare kind: "function";

  constructor(
    public parameters: FunctionTypeParameter[],
    public returnType: AnalysisType,
    public typeParameters?: string[],
    public typeParameterConstraints?: Record<string, AnalysisType>,
    public typeParameterDefaults?: Record<string, AnalysisType>,
    public assertion?: { target: string; type?: AnalysisType }
  ) {
    super("function");
  }
}

export class ArrayType extends AnalysisTypeBase {
  declare kind: "array";

  constructor(public elementType: AnalysisType, public isReadonly?: boolean) {
    super("array");
  }
}

export class ObjectType extends AnalysisTypeBase {
  declare kind: "object";

  constructor(public properties: Record<string, AnalysisType>) {
    super("object");
  }
}

export class RangeType extends AnalysisTypeBase {
  declare kind: "range";

  constructor(public elementType: AnalysisType) {
    super("range");
  }
}

export class UnionType extends AnalysisTypeBase {
  declare kind: "union";

  constructor(public types: AnalysisType[]) {
    super("union");
  }
}

export class IntersectionType extends AnalysisTypeBase {
  declare kind: "intersection";

  constructor(public types: AnalysisType[]) {
    super("intersection");
  }
}

export class LiteralType extends AnalysisTypeBase {
  declare kind: "literal";

  constructor(public base: "string" | "number" | "boolean", public value: string | number | boolean) {
    super("literal");
  }
}

export class TupleType extends AnalysisTypeBase {
  declare kind: "tuple";

  constructor(public elements: AnalysisType[], public isReadonly?: boolean) {
    super("tuple");
  }
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

export const UNKNOWN_TYPE: AnalysisType = new UnknownType();

export const BUILTIN_TYPES: Record<BuiltinTypeName, BuiltinType> = {
  int: new BuiltinType("int"),
  number: new BuiltinType("number"),
  numeric: new BuiltinType("numeric"),
  string: new BuiltinType("string"),
  boolean: new BuiltinType("boolean"),
  bigint: new BuiltinType("bigint"),
  long: new BuiltinType("long"),
  void: new BuiltinType("void"),
  null: new BuiltinType("null"),
  undefined: new BuiltinType("undefined"),
  any: new BuiltinType("any"),
  unknown: new BuiltinType("unknown"),
  never: new BuiltinType("never"),
  object: new BuiltinType("object"),
  symbol: new BuiltinType("symbol")
};

export function builtinType(name: BuiltinTypeName): BuiltinType {
  return BUILTIN_TYPES[name];
}

export function namedType(name: string, typeArguments?: AnalysisType[]): NamedType {
  return new NamedType(name, typeArguments && typeArguments.length > 0 ? typeArguments : undefined);
}

export function functionType(
  parameters: FunctionTypeParameter[],
  returnType: AnalysisType,
  typeParameters?: string[],
  typeParameterConstraints?: Record<string, AnalysisType>,
  typeParameterDefaults?: Record<string, AnalysisType>,
  assertion?: { target: string; type?: AnalysisType }
): FunctionType {
  return new FunctionType(
    parameters,
    returnType,
    typeParameters && typeParameters.length > 0 ? typeParameters : undefined,
    typeParameterConstraints && Object.keys(typeParameterConstraints).length > 0
      ? typeParameterConstraints
      : undefined,
    typeParameterDefaults && Object.keys(typeParameterDefaults).length > 0
      ? typeParameterDefaults
      : undefined,
    assertion
  );
}

export function arrayType(elementType: AnalysisType = UNKNOWN_TYPE, isReadonly: boolean = false): ArrayType {
  return new ArrayType(elementType, isReadonly ? true : undefined);
}

export function objectType(): ObjectType {
  return new ObjectType({});
}

export function objectTypeWithProperties(properties: Record<string, AnalysisType>): ObjectType {
  return new ObjectType(properties);
}

export function rangeType(elementType: AnalysisType = builtinType("int")): RangeType {
  return new RangeType(elementType);
}

export function unionType(types: AnalysisType[]): UnionType {
  const normalizedTypes: AnalysisType[] = [];
  for (const type of types) {
    normalizedTypes.push(type ?? UNKNOWN_TYPE);
  }
  return new UnionType(normalizedTypes);
}

export function intersectionType(types: AnalysisType[]): IntersectionType {
  return new IntersectionType(types);
}

export function literalType(base: LiteralType["base"], value: LiteralType["value"]): LiteralType {
  return new LiteralType(base, value);
}

export function tupleType(elements: AnalysisType[], isReadonly: boolean = false): TupleType {
  return new TupleType(elements, isReadonly ? true : undefined);
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
  let result: string;
  switch (type.kind) {
    case "unknown":
      result = "unknown";
      break;
    case "builtin":
      result = type.name;
      break;
    case "named":
      result = !type.typeArguments || type.typeArguments.length === 0
        ? type.name
        : `${type.name}<${type.typeArguments.map((argument) => typeToStringInternal(argument, seen)).join(", ")}>`;
      break;
    case "function": {
      const functionType = type as FunctionType;
      const renderedTypeParameters: string[] = [];
      for (const parameter of functionType.typeParameters ?? []) {
        const constraint = functionType.typeParameterConstraints?.[parameter];
        renderedTypeParameters.push(
          constraint ? `${parameter} extends ${typeToStringInternal(constraint, seen)}` : parameter
        );
      }
      const typeParameterPrefix = renderedTypeParameters.length > 0
        ? `<${renderedTypeParameters.join(", ")}>`
        : "";
      const renderedReturnType = functionType.assertion
        ? `asserts ${functionType.assertion.target}${functionType.assertion.type ? ` is ${typeToStringInternal(functionType.assertion.type, seen)}` : ""}`
        : typeToStringInternal(functionType.returnType, seen);
      const renderedParameters: string[] = [];
      for (const functionParameter of functionType.parameters) {
        renderedParameters.push(
          `${functionParameter.rest ? "..." : ""}${functionParameter.name}: ${typeToStringInternal(functionParameter.type, seen)}`
        );
      }
      result = `${typeParameterPrefix}(${renderedParameters.join(", ")}) => ${renderedReturnType}`;
      break;
    }
    case "array":
      result = `${type.isReadonly === true ? "readonly " : ""}${typeToStringInternal(type.elementType, seen)}[]`;
      break;
    case "object":
      result = Object.keys(type.properties).length === 0
        ? "object"
        : `{ ${Object.entries(type.properties)
          .map(([name, propertyType]) => `${name}: ${typeToStringInternal(propertyType, seen)}`)
          .join(", ")} }`;
      break;
    case "range":
      result = `range<${typeToStringInternal(type.elementType, seen)}>`;
      break;
    case "union": {
      const members = dedupeUnionDisplayMembers(flattenUnionDisplayMembers(type));
      const optionalMember = optionalTypeMember(members);
      if (optionalMember) {
        const rendered = typeToStringInternal(optionalMember, seen);
        result = needsParensForOptionalType(optionalMember) ? `(${rendered})?` : `${rendered}?`;
      } else {
        result = members.map((member) => typeToStringInternal(member, seen)).join(" | ");
      }
      break;
    }
    case "intersection":
      result = type.types.map((member) => typeToStringInternal(member, seen)).join(" & ");
      break;
    case "literal":
      result = type.base === "string" ? JSON.stringify(type.value) : String(type.value);
      break;
    case "tuple":
      result = `${type.isReadonly === true ? "readonly " : ""}[${type.elements.map((element) => typeToStringInternal(element, seen)).join(", ")}]`;
      break;
    default:
      result = "unknown";
      break;
  }
  if (trackedObject) seen.delete(trackedObject);
  return result;
}

function flattenUnionDisplayMembers(type: AnalysisType): AnalysisType[] {
  if (type.kind !== "union") {
    return [type];
  }
  const members: AnalysisType[] = [];
  for (const member of type.types) {
    members.push(...flattenUnionDisplayMembers(member));
  }
  return members;
}

function dedupeUnionDisplayMembers(members: AnalysisType[]): AnalysisType[] {
  const deduped: AnalysisType[] = [];
  for (const member of members) {
    if (deduped.some((existing) => isSameType(existing, member))) {
      continue;
    }
    deduped.push(member);
  }
  return deduped;
}

function optionalTypeMember(members: AnalysisType[]): AnalysisType | null {
  if (members.length !== 2) {
    return null;
  }
  const nonUndefinedMembers = members.filter((member) => !(member.kind === "builtin" && member.name === "undefined"));
  if (nonUndefinedMembers.length !== 1) {
    return null;
  }
  const optionalMember = nonUndefinedMembers[0]!;
  if (optionalMember.kind === "union") {
    return null;
  }
  if (optionalMember.kind === "builtin" && optionalMember.name === "null") {
    return null;
  }
  return optionalMember;
}

function needsParensForOptionalType(type: AnalysisType): boolean {
  return type.kind === "function" || type.kind === "intersection" || type.kind === "union";
}

export function isUnknownType(type: AnalysisType | null | undefined): boolean {
  return !type || type.kind === "unknown";
}

export function isSameType(
  a: AnalysisType | null | undefined,
  b: AnalysisType | null | undefined
): boolean {
  return isSameTypeInternal(a, b, new WeakMap<object, WeakSet<object>>());
}

function isSameTypeInternal(
  a: AnalysisType | null | undefined,
  b: AnalysisType | null | undefined,
  seenPairs: WeakMap<object, WeakSet<object>>
): boolean {
  if (!a || !b) {
    return false;
  }
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
    seenPairs.set(a as object, new WeakSet<object>([b as object]));
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
    return (a.isReadonly ?? false) === (b.isReadonly ?? false)
      && isSameTypeInternal(a.elementType, b.elementType, seenPairs);
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
    if ((a.isReadonly ?? false) !== (b.isReadonly ?? false) || a.elements.length !== b.elements.length) {
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
    if ((a.assertion?.target ?? null) !== (b.assertion?.target ?? null)) {
      return false;
    }
    if (!!a.assertion !== !!b.assertion) {
      return false;
    }
    if (a.assertion?.type || b.assertion?.type) {
      if (!a.assertion?.type || !b.assertion?.type || !isSameTypeInternal(a.assertion.type, b.assertion.type, seenPairs)) {
        return false;
      }
    }
    return isSameTypeInternal(a.returnType, b.returnType, seenPairs);
  }

  return typeToString(a) === typeToString(b);
}
