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

export const enum AnalysisTypeKind {
  Unknown,
  Builtin,
  Named,
  Function,
  Array,
  Object,
  Range,
  Union,
  Intersection,
  Literal,
  Tuple,
}

const ANALYSIS_TYPE_KIND_NAMES = [
  "unknown",
  "builtin",
  "named",
  "function",
  "array",
  "object",
  "range",
  "union",
  "intersection",
  "literal",
  "tuple",
] as const;

export abstract class AnalysisTypeBase {
  declare private readonly __analysisTypeBrand: void;

  protected constructor(public kind: AnalysisTypeKind) {}
}

export class UnknownType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Unknown;

  constructor() {
    super(AnalysisTypeKind.Unknown);
  }
}

export class BuiltinType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Builtin;

  constructor(public name: BuiltinTypeName) {
    super(AnalysisTypeKind.Builtin);
  }
}

export class NamedType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Named;

  constructor(public name: string, public typeArguments?: AnalysisType[]) {
    super(AnalysisTypeKind.Named);
  }
}

export interface FunctionTypeParameter {
  name: string;
  type: AnalysisType;
  /** Hidden leading receiver argument declared by `Receiver.(...) => Result`. */
  receiver?: boolean;
  optional?: boolean;
  rest?: boolean;
}

export class FunctionType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Function;

  constructor(
    public parameters: FunctionTypeParameter[],
    public returnType: AnalysisType,
    public typeParameters?: string[],
    public typeParameterConstraints?: ReadonlyMap<string, AnalysisType>,
    public typeParameterDefaults?: ReadonlyMap<string, AnalysisType>,
    public assertion?: { target: string; type?: AnalysisType }
  ) {
    super(AnalysisTypeKind.Function);
  }
}

export class ArrayType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Array;

  constructor(public elementType: AnalysisType, public isReadonly?: boolean) {
    super(AnalysisTypeKind.Array);
  }
}

export class ObjectType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Object;

  constructor(public properties: ReadonlyMap<string, AnalysisType>) {
    super(AnalysisTypeKind.Object);
  }
}

export class RangeType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Range;

  constructor(public elementType: AnalysisType) {
    super(AnalysisTypeKind.Range);
  }
}

export class UnionType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Union;

  constructor(public types: AnalysisType[]) {
    super(AnalysisTypeKind.Union);
  }
}

export class IntersectionType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Intersection;

  constructor(public types: AnalysisType[]) {
    super(AnalysisTypeKind.Intersection);
  }
}

export class LiteralType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Literal;

  constructor(public base: "string" | "number" | "boolean", public value: string | number | boolean) {
    super(AnalysisTypeKind.Literal);
  }
}

export class TupleType extends AnalysisTypeBase {
  declare kind: AnalysisTypeKind.Tuple;

  constructor(public elements: AnalysisType[], public isReadonly?: boolean) {
    super(AnalysisTypeKind.Tuple);
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
  typeParameterConstraints?: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
  typeParameterDefaults?: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
  assertion?: { target: string; type?: AnalysisType }
): FunctionType {
  return new FunctionType(
    parameters,
    returnType,
    typeParameters && typeParameters.length > 0 ? typeParameters : undefined,
    optionalAnalysisTypeMap(typeParameterConstraints),
    optionalAnalysisTypeMap(typeParameterDefaults),
    assertion
  );
}

function optionalAnalysisTypeMap(
  values: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType> | undefined
): ReadonlyMap<string, AnalysisType> | undefined {
  if (!values) return undefined;
  if (values instanceof Map) return values.size > 0 ? values : undefined;
  const map = new Map(Object.entries(values));
  return map.size > 0 ? map : undefined;
}

export function arrayType(elementType: AnalysisType = UNKNOWN_TYPE, isReadonly: boolean = false): ArrayType {
  return new ArrayType(elementType, isReadonly ? true : undefined);
}

export function objectType(): ObjectType {
  return new ObjectType(new Map());
}

export function objectTypeWithProperties(
  properties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>
): ObjectType {
  return new ObjectType(properties instanceof Map ? properties : new Map(Object.entries(properties)));
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
      if (type.kind === AnalysisTypeKind.Named) {
        return type.name;
      }
      return ANALYSIS_TYPE_KIND_NAMES[type.kind] ?? "unknown";
    }
    trackedObject = type as object;
    seen.add(trackedObject);
  }
  let result: string;
  switch (type.kind) {
    case AnalysisTypeKind.Unknown:
      result = "unknown";
      break;
    case AnalysisTypeKind.Builtin:
      result = type.name;
      break;
    case AnalysisTypeKind.Named:
      result = !type.typeArguments || type.typeArguments.length === 0
        ? type.name
        : `${type.name}<${type.typeArguments.map((argument) => typeToStringInternal(argument, seen)).join(", ")}>`;
      break;
    case AnalysisTypeKind.Function: {
      const functionType = type as FunctionType;
      const renderedTypeParameters: string[] = [];
      for (const parameter of functionType.typeParameters ?? []) {
        const constraint = functionType.typeParameterConstraints?.get(parameter);
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
        if (functionParameter.receiver) continue;
        renderedParameters.push(
          `${functionParameter.rest ? "..." : ""}${functionParameter.name}: ${typeToStringInternal(functionParameter.type, seen)}`
        );
      }
      const receiver = functionType.parameters.find((parameter) => parameter.receiver);
      result = `${typeParameterPrefix}${receiver ? `${typeToStringInternal(receiver.type, seen)}.` : ""}(${renderedParameters.join(", ")}) => ${renderedReturnType}`;
      break;
    }
    case AnalysisTypeKind.Array:
      result = `${type.isReadonly === true ? "readonly " : ""}${typeToStringInternal(type.elementType, seen)}[]`;
      break;
    case AnalysisTypeKind.Object: {
      const objectSource = type as ObjectType;
      if (objectSource.properties.size === 0) {
        result = "object";
        break;
      }
      const renderedProperties: string[] = [];
      for (const name of objectSource.properties.keys()) {
        renderedProperties.push(`${name}: ${typeToStringInternal(objectSource.properties.get(name)!, seen)}`);
      }
      result = `{ ${renderedProperties.join(", ")} }`;
      break;
    }
    case AnalysisTypeKind.Range:
      result = `range<${typeToStringInternal(type.elementType, seen)}>`;
      break;
    case AnalysisTypeKind.Union: {
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
    case AnalysisTypeKind.Intersection:
      result = type.types.map((member) => typeToStringInternal(member, seen)).join(" & ");
      break;
    case AnalysisTypeKind.Literal:
      result = type.base === "string" ? JSON.stringify(type.value) : String(type.value);
      break;
    case AnalysisTypeKind.Tuple:
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
  if (type.kind !== AnalysisTypeKind.Union) {
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
  const nonUndefinedMembers = members.filter((member) => !(member.kind === AnalysisTypeKind.Builtin && member.name === "undefined"));
  if (nonUndefinedMembers.length !== 1) {
    return null;
  }
  const optionalMember = nonUndefinedMembers[0]!;
  if (optionalMember.kind === AnalysisTypeKind.Union) {
    return null;
  }
  if (optionalMember.kind === AnalysisTypeKind.Builtin && optionalMember.name === "null") {
    return null;
  }
  return optionalMember;
}

function needsParensForOptionalType(type: AnalysisType): boolean {
  return type.kind === AnalysisTypeKind.Function || type.kind === AnalysisTypeKind.Intersection || type.kind === AnalysisTypeKind.Union;
}

export function isUnknownType(type: AnalysisType | null | undefined): boolean {
  return !type || type.kind === AnalysisTypeKind.Unknown;
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

  if (a.kind === AnalysisTypeKind.Builtin && b.kind === AnalysisTypeKind.Builtin) {
    return a.name === b.name;
  }

  if (a.kind === AnalysisTypeKind.Named && b.kind === AnalysisTypeKind.Named) {
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

  if (a.kind === AnalysisTypeKind.Unknown && b.kind === AnalysisTypeKind.Unknown) {
    return true;
  }

  if (a.kind === AnalysisTypeKind.Array && b.kind === AnalysisTypeKind.Array) {
    return (a.isReadonly ?? false) === (b.isReadonly ?? false)
      && isSameTypeInternal(a.elementType, b.elementType, seenPairs);
  }

  if (a.kind === AnalysisTypeKind.Range && b.kind === AnalysisTypeKind.Range) {
    return isSameTypeInternal(a.elementType, b.elementType, seenPairs);
  }

  if (a.kind === AnalysisTypeKind.Object && b.kind === AnalysisTypeKind.Object) {
    const aObject = a as ObjectType;
    const bObject = b as ObjectType;
    const aKeys = [...aObject.properties.keys()].sort();
    const bKeys = [...bObject.properties.keys()].sort();
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) {
        return false;
      }
      const key = aKeys[i]!;
      const aProperty = aObject.properties.get(key);
      const bProperty = bObject.properties.get(key);
      if (!aProperty || !bProperty || !isSameTypeInternal(aProperty, bProperty, seenPairs)) {
        return false;
      }
    }
    return true;
  }

  if (a.kind === AnalysisTypeKind.Union && b.kind === AnalysisTypeKind.Union) {
    if (a.types.length !== b.types.length) {
      return false;
    }
    return a.types.every((aType, index) => isSameTypeInternal(aType, b.types[index]!, seenPairs));
  }

  if (a.kind === AnalysisTypeKind.Intersection && b.kind === AnalysisTypeKind.Intersection) {
    if (a.types.length !== b.types.length) {
      return false;
    }
    return a.types.every((aType, index) => isSameTypeInternal(aType, b.types[index]!, seenPairs));
  }

  if (a.kind === AnalysisTypeKind.Literal && b.kind === AnalysisTypeKind.Literal) {
    return a.base === b.base && a.value === b.value;
  }

  if (a.kind === AnalysisTypeKind.Tuple && b.kind === AnalysisTypeKind.Tuple) {
    if ((a.isReadonly ?? false) !== (b.isReadonly ?? false) || a.elements.length !== b.elements.length) {
      return false;
    }
    return a.elements.every((element, index) => isSameTypeInternal(element, b.elements[index]!, seenPairs));
  }

  if (a.kind === AnalysisTypeKind.Function && b.kind === AnalysisTypeKind.Function) {
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
