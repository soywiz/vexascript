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
export const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set<string>([
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

export abstract class AnalysisType {
  declare private readonly __analysisTypeBrand: void;

  protected constructor(public kind: AnalysisTypeKind) {}
}

export class UnknownType extends AnalysisType {
  declare kind: AnalysisTypeKind.Unknown;

  constructor() {
    super(AnalysisTypeKind.Unknown);
  }
}

export abstract class NamedAnalysisType extends AnalysisType {
  protected constructor(kind: AnalysisTypeKind, public name: string) {
    super(kind);
  }
}

export class BuiltinType extends NamedAnalysisType {
  declare kind: AnalysisTypeKind.Builtin;
  declare name: BuiltinTypeName;

  constructor(name: BuiltinTypeName) {
    super(AnalysisTypeKind.Builtin, name);
  }
}

export class NamedType extends NamedAnalysisType {
  declare kind: AnalysisTypeKind.Named;

  constructor(name: string, public typeArguments?: AnalysisType[]) {
    super(AnalysisTypeKind.Named, name);
  }
}

export class FunctionTypeParameter {
  constructor(
    public name: string,
    public type: AnalysisType,
    /** Hidden leading receiver argument declared by `Receiver.(...) => Result`. */
    public receiver?: boolean,
    public optional?: boolean,
    public rest?: boolean
  ) {}
}

export class FunctionType extends AnalysisType {
  declare kind: AnalysisTypeKind.Function;

  constructor(
    public parameters: FunctionTypeParameter[],
    public returnType: AnalysisType,
    public typeParameters?: string[],
    public typeParameterConstraints?: ReadonlyMap<string, AnalysisType>,
    public typeParameterDefaults?: ReadonlyMap<string, AnalysisType>,
    public assertion?: { target: string; type?: AnalysisType },
    public constTypeParameters?: ReadonlySet<string>
  ) {
    super(AnalysisTypeKind.Function);
  }
}

export class ArrayType extends AnalysisType {
  declare kind: AnalysisTypeKind.Array;

  constructor(public elementType: AnalysisType, public isReadonly?: boolean) {
    super(AnalysisTypeKind.Array);
  }
}

export class ObjectType extends AnalysisType {
  declare kind: AnalysisTypeKind.Object;

  constructor(
    public properties: ReadonlyMap<string, AnalysisType>,
    /** Exact declaration owner retained when mapped/utility types copy properties. */
    public propertyOwnerTypeNames?: ReadonlyMap<string, string>
  ) {
    super(AnalysisTypeKind.Object);
  }
}

export class RangeType extends AnalysisType {
  declare kind: AnalysisTypeKind.Range;

  constructor(public elementType: AnalysisType) {
    super(AnalysisTypeKind.Range);
  }
}

export class UnionType extends AnalysisType {
  declare kind: AnalysisTypeKind.Union;

  constructor(public types: AnalysisType[]) {
    super(AnalysisTypeKind.Union);
  }
}

export class IntersectionType extends AnalysisType {
  declare kind: AnalysisTypeKind.Intersection;

  constructor(public types: AnalysisType[]) {
    super(AnalysisTypeKind.Intersection);
  }
}

export class LiteralType extends AnalysisType {
  declare kind: AnalysisTypeKind.Literal;

  constructor(public base: "string" | "number" | "boolean", public value: string | number | boolean) {
    super(AnalysisTypeKind.Literal);
  }
}

export class TupleType extends AnalysisType {
  declare kind: AnalysisTypeKind.Tuple;

  constructor(public elements: AnalysisType[], public isReadonly?: boolean) {
    super(AnalysisTypeKind.Tuple);
  }
}

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

export function namedTypeArgument(type: NamedType, index: number): AnalysisType | undefined {
  const typeArguments = type.typeArguments;
  return typeArguments ? typeArguments[index] : undefined;
}

export function functionType(
  parameters: FunctionTypeParameter[],
  returnType: AnalysisType,
  typeParameters?: string[],
  typeParameterConstraints?: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
  typeParameterDefaults?: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
  assertion?: { target: string; type?: AnalysisType },
  constTypeParameters?: ReadonlySet<string>
): FunctionType {
  return new FunctionType(
    parameters,
    returnType,
    typeParameters && typeParameters.length > 0 ? typeParameters : undefined,
    optionalAnalysisTypeMap(typeParameterConstraints),
    optionalAnalysisTypeMap(typeParameterDefaults),
    assertion,
    constTypeParameters && constTypeParameters.size > 0 ? constTypeParameters : undefined
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
  properties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
  propertyOwnerTypeNames?: ReadonlyMap<string, string>
): ObjectType {
  return new ObjectType(
    properties instanceof Map ? properties : new Map(Object.entries(properties)),
    propertyOwnerTypeNames && propertyOwnerTypeNames.size > 0
      ? propertyOwnerTypeNames
      : undefined
  );
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

let typeRenderCalls = 0;
let typeRenderWork = 0;

export function getTypeRenderMetrics(): { calls: number; work: number } {
  return { calls: typeRenderCalls, work: typeRenderWork };
}

export function resetTypeRenderMetrics(): void {
  typeRenderCalls = 0;
  typeRenderWork = 0;
}

export function typeToString(type: AnalysisType): string {
  typeRenderCalls += 1;
  return typeToStringInternal(type, { seen: new Set<object>(), work: 0 });
}

/** Cheap necessary-equality key used to avoid impossible structural comparisons. */
export function typeComparisonBucketKey(type: AnalysisType): string {
  if (type instanceof BuiltinType) return `builtin:${type.name}`;
  if (type instanceof NamedType) return `named:${type.name}:${type.typeArguments?.length ?? 0}`;
  if (type instanceof UnknownType) return "unknown";
  if (type instanceof ArrayType) return `array:${type.isReadonly === true ? 1 : 0}`;
  if (type instanceof RangeType) return "range";
  if (type instanceof ObjectType) {
    let nameHashSum = 0;
    let nameHashXor = 0;
    for (const name of type.properties.keys()) {
      let nameHash = 0;
      for (let index = 0; index < name.length; index += 1) {
        nameHash = ((nameHash * 31) ^ name.charCodeAt(index)) | 0;
      }
      nameHashSum = (nameHashSum + nameHash) | 0;
      nameHashXor ^= nameHash;
    }
    return `object:${type.properties.size}:${nameHashSum}:${nameHashXor}`;
  }
  if (type instanceof UnionType) return `union:${type.types.length}`;
  if (type instanceof IntersectionType) return `intersection:${type.types.length}`;
  if (type instanceof LiteralType) return `literal:${type.base}:${String(type.value)}`;
  if (type instanceof TupleType) return `tuple:${type.isReadonly === true ? 1 : 0}:${type.elements.length}`;
  if (type instanceof FunctionType) {
    return `function:${type.parameters.length}:${type.assertion?.target ?? ""}:${type.constTypeParameters?.size ?? 0}`;
  }
  return `kind:${type.kind}`;
}

const MAX_TYPE_RENDER_DEPTH = 64;
const MAX_TYPE_RENDER_WORK = 4_096;

interface TypeRenderState {
  seen: Set<object>;
  work: number;
}

function typeRenderFallback(type: AnalysisType): string {
  return type instanceof NamedType
    ? type.name
    : ANALYSIS_TYPE_KIND_NAMES[type.kind] ?? "unknown";
}

function typeToStringInternal(type: AnalysisType, state: TypeRenderState): string {
  typeRenderWork += 1;
  if (state.work >= MAX_TYPE_RENDER_WORK) {
    return typeRenderFallback(type);
  }
  state.work += 1;
  let trackedObject: object | undefined;
  if (typeof type === "object" && type !== null) {
    if (state.seen.size >= MAX_TYPE_RENDER_DEPTH) {
      return typeRenderFallback(type);
    }
    if (state.seen.has(type as object)) {
      return typeRenderFallback(type);
    }
    trackedObject = type as object;
    state.seen.add(trackedObject);
  }
  let result: string;
  if (type instanceof UnknownType) {
    result = "unknown";
  } else if (type instanceof BuiltinType) {
    result = type.name;
  } else if (type instanceof NamedType) {
    result = !type.typeArguments || type.typeArguments.length === 0
      ? type.name
      : `${type.name}<${type.typeArguments.map((argument) => typeToStringInternal(argument, state)).join(", ")}>`;
  } else if (type instanceof FunctionType) {
    const renderedTypeParameters: string[] = [];
    for (const parameter of type.typeParameters ?? []) {
      const constraint = type.typeParameterConstraints?.get(parameter);
      renderedTypeParameters.push(
        constraint ? `${parameter} extends ${typeToStringInternal(constraint, state)}` : parameter
      );
    }
    const typeParameterPrefix = renderedTypeParameters.length > 0
      ? `<${renderedTypeParameters.join(", ")}>`
      : "";
    const renderedReturnType = type.assertion
      ? `asserts ${type.assertion.target}${type.assertion.type ? ` is ${typeToStringInternal(type.assertion.type, state)}` : ""}`
      : typeToStringInternal(type.returnType, state);
    const renderedParameters: string[] = [];
    for (const functionParameter of type.parameters) {
      if (functionParameter.receiver) continue;
      renderedParameters.push(
        `${functionParameter.rest ? "..." : ""}${functionParameter.name}: ${typeToStringInternal(functionParameter.type, state)}`
      );
    }
    const receiver = type.parameters.find((parameter) => parameter.receiver);
    result = `${typeParameterPrefix}${receiver ? `${typeToStringInternal(receiver.type, state)}.` : ""}(${renderedParameters.join(", ")}) => ${renderedReturnType}`;
  } else if (type instanceof ArrayType) {
    const elementType = typeToStringInternal(type.elementType, state);
    result = `${type.isReadonly === true ? "readonly " : ""}${needsParensForArrayElement(type.elementType) ? `(${elementType})` : elementType}[]`;
  } else if (type instanceof ObjectType) {
    if (type.properties.size === 0) {
      result = "object";
    } else {
      const renderedProperties: string[] = [];
      for (const name of type.properties.keys()) {
        renderedProperties.push(`${name}: ${typeToStringInternal(type.properties.get(name)!, state)}`);
      }
      result = `{ ${renderedProperties.join(", ")} }`;
    }
  } else if (type instanceof RangeType) {
    result = `range<${typeToStringInternal(type.elementType, state)}>`;
  } else if (type instanceof UnionType) {
    const members = dedupeUnionDisplayMembers(flattenUnionDisplayMembers(type));
    const optionalMember = optionalTypeMember(members);
    if (optionalMember) {
      const rendered = typeToStringInternal(optionalMember, state);
      result = needsParensForOptionalType(optionalMember) ? `(${rendered})?` : `${rendered}?`;
    } else {
      result = members.map((member) => typeToStringInternal(member, state)).join(" | ");
    }
  } else if (type instanceof IntersectionType) {
    result = type.types.map((member) => typeToStringInternal(member, state)).join(" & ");
  } else if (type instanceof LiteralType) {
    result = type.base === "string" ? JSON.stringify(type.value) : String(type.value);
  } else if (type instanceof TupleType) {
    result = `${type.isReadonly === true ? "readonly " : ""}[${type.elements.map((element) => typeToStringInternal(element, state)).join(", ")}]`;
  } else {
    result = "unknown";
  }
  if (trackedObject) state.seen.delete(trackedObject);
  return result;
}

function flattenUnionDisplayMembers(type: AnalysisType): AnalysisType[] {
  if (!(type instanceof UnionType)) {
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
  const seenByIdentity = new Set<AnalysisType>();
  const candidatesByKey = new Map<string, AnalysisType[]>();
  for (const member of members) {
    if (seenByIdentity.has(member)) {
      continue;
    }
    seenByIdentity.add(member);
    const key = typeComparisonBucketKey(member);
    const candidates = candidatesByKey.get(key) ?? [];
    if (candidates.some((existing) => isSameType(existing, member))) {
      continue;
    }
    candidates.push(member);
    candidatesByKey.set(key, candidates);
    deduped.push(member);
  }
  const nonNeverMembers = deduped.filter(
    (member) => !(member instanceof BuiltinType && member.name === "never")
  );
  return nonNeverMembers.length > 0 ? nonNeverMembers : deduped;
}

function optionalTypeMember(members: AnalysisType[]): AnalysisType | null {
  if (members.length !== 2) {
    return null;
  }
  const nonUndefinedMembers = members.filter((member) => !(member instanceof BuiltinType && member.name === "undefined"));
  if (nonUndefinedMembers.length !== 1) {
    return null;
  }
  const optionalMember = nonUndefinedMembers[0]!;
  if (optionalMember instanceof UnionType) {
    return null;
  }
  if (optionalMember instanceof BuiltinType && optionalMember.name === "null") {
    return null;
  }
  return optionalMember;
}

function needsParensForOptionalType(type: AnalysisType): boolean {
  return type instanceof FunctionType || type instanceof IntersectionType || type instanceof UnionType;
}

function needsParensForArrayElement(type: AnalysisType): boolean {
  return type instanceof FunctionType || type instanceof IntersectionType || type instanceof UnionType;
}

export function isUnknownType(type: AnalysisType | null | undefined): boolean {
  return !type || type instanceof UnknownType;
}

let typeComparisonCalls = 0;

export function getTypeComparisonCalls(): number {
  return typeComparisonCalls;
}

export function resetTypeComparisonCalls(): void {
  typeComparisonCalls = 0;
}

export function isSameType(
  a: AnalysisType | null | undefined,
  b: AnalysisType | null | undefined
): boolean {
  typeComparisonCalls += 1;
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

  if (a instanceof BuiltinType && b instanceof BuiltinType) {
    return a.name === b.name;
  }

  if (a instanceof NamedType && b instanceof NamedType) {
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

  if (a instanceof UnknownType && b instanceof UnknownType) {
    return true;
  }

  if (a instanceof ArrayType && b instanceof ArrayType) {
    return (a.isReadonly ?? false) === (b.isReadonly ?? false)
      && isSameTypeInternal(a.elementType, b.elementType, seenPairs);
  }

  if (a instanceof RangeType && b instanceof RangeType) {
    return isSameTypeInternal(a.elementType, b.elementType, seenPairs);
  }

  if (a instanceof ObjectType && b instanceof ObjectType) {
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

  if (a instanceof UnionType && b instanceof UnionType) {
    if (a.types.length !== b.types.length) {
      return false;
    }
    return a.types.every((aType, index) => isSameTypeInternal(aType, b.types[index]!, seenPairs));
  }

  if (a instanceof IntersectionType && b instanceof IntersectionType) {
    if (a.types.length !== b.types.length) {
      return false;
    }
    return a.types.every((aType, index) => isSameTypeInternal(aType, b.types[index]!, seenPairs));
  }

  if (a instanceof LiteralType && b instanceof LiteralType) {
    return a.base === b.base && a.value === b.value;
  }

  if (a instanceof TupleType && b instanceof TupleType) {
    if ((a.isReadonly ?? false) !== (b.isReadonly ?? false) || a.elements.length !== b.elements.length) {
      return false;
    }
    return a.elements.every((element, index) => isSameTypeInternal(element, b.elements[index]!, seenPairs));
  }

  if (a instanceof FunctionType && b instanceof FunctionType) {
    if (!sameStringSet(a.constTypeParameters, b.constTypeParameters)) {
      return false;
    }
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
    if (!!a.assertion !== !!b.assertion) {
      return false;
    }
    if (a.assertion && b.assertion && a.assertion.target !== b.assertion.target) {
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

function sameStringSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
  if (!a) return true;
  return [...a].every((value) => b?.has(value));
}
