import {
  AnnotationApplication,
  ClassFieldMember,
  ClassStatement,
  Expr,
  IntLiteral,
} from "compiler/ast/ast";

export interface ForeignStructField {
  name: string;
  typeName: string;
  constructorParameter: boolean;
  constructorDefaultValue?: Expr;
  offset: number;
  size: number;
  alignment: number;
  dataViewGetter: string;
  dataViewSetter: string;
  cppType: string;
}

export interface ForeignStructDefinition {
  size: number;
  alignment: number;
  fields: ForeignStructField[];
}

export function isForeignStructClass(statement: ClassStatement): boolean {
  return (statement.annotations ?? []).some((candidate) => candidate.name.name === "FFIStruct");
}

function integerArgument(annotation: AnnotationApplication | undefined): number | undefined {
  const argument = annotation?.args[0];
  return argument instanceof IntLiteral ? argument.value : undefined;
}

function annotationInteger(
  annotations: readonly AnnotationApplication[] | undefined,
  name: string
): number | undefined {
  return integerArgument(annotations?.find((candidate) => candidate.name.name === name));
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function defaultFieldSize(typeName: string): number | null {
  switch (typeName) {
    case "boolean": return 1;
    case "int": return 4;
    case "long": return 8;
    case "number": return 8;
    default: return null;
  }
}

function fieldMapping(typeName: string, size: number): Pick<ForeignStructField, "dataViewGetter" | "dataViewSetter" | "cppType"> | null {
  if (typeName === "boolean" && size === 1) {
    return { dataViewGetter: "getUint8", dataViewSetter: "setUint8", cppType: "std::uint8_t" };
  }
  if (typeName === "int") {
    if (size === 1) return { dataViewGetter: "getInt8", dataViewSetter: "setInt8", cppType: "std::int8_t" };
    if (size === 2) return { dataViewGetter: "getInt16", dataViewSetter: "setInt16", cppType: "std::int16_t" };
    if (size === 4) return { dataViewGetter: "getInt32", dataViewSetter: "setInt32", cppType: "std::int32_t" };
  }
  if (typeName === "long" && size === 8) {
    return { dataViewGetter: "getBigInt64", dataViewSetter: "setBigInt64", cppType: "std::int64_t" };
  }
  if (typeName === "number") {
    if (size === 4) return { dataViewGetter: "getFloat32", dataViewSetter: "setFloat32", cppType: "float" };
    if (size === 8) return { dataViewGetter: "getFloat64", dataViewSetter: "setFloat64", cppType: "double" };
  }
  return null;
}

export function foreignStructForClass(statement: ClassStatement): ForeignStructDefinition | null {
  if (!isForeignStructClass(statement)) return null;
  const size = annotationInteger(statement.annotations, "FFIStruct");
  if (size === undefined) throw new Error("@FFIStruct requires a size");
  if (!Number.isInteger(size) || size <= 0) throw new Error("@FFIStruct size must be a positive integer");
  const alignment = annotationInteger(statement.annotations, "FFIAlign") ?? 1;
  if (!Number.isInteger(alignment) || !isPowerOfTwo(alignment)) {
    throw new Error("@FFIAlign must be a positive power of two");
  }
  if (size % alignment !== 0) {
    throw new Error("@FFIStruct size must be a multiple of its @FFIAlign value");
  }

  const fields: ForeignStructField[] = [];
  let cursor = 0;
  const constructorFields = (statement.primaryConstructorParameters ?? []).map((parameter) => ({
    name: parameter.name.name,
    typeName: parameter.typeAnnotation?.name ?? "",
    annotations: parameter.annotations,
    constructorParameter: true,
    constructorDefaultValue: parameter.defaultValue,
  }));
  const memberFields = statement.members
    .filter((member): member is ClassFieldMember => member instanceof ClassFieldMember && member.isStatic !== true)
    .map((field) => {
      if (field.computed) throw new Error("@FFIStruct does not support computed fields");
      if (field.initializer) throw new Error(`@FFIStruct field '${field.name.name}' cannot have an initializer`);
      return {
        name: field.name.name,
        typeName: field.typeAnnotation?.name ?? "",
        annotations: field.annotations,
        constructorParameter: false,
        constructorDefaultValue: undefined,
      };
    });
  for (const field of [...constructorFields, ...memberFields]) {
    if (fields.some((candidate) => candidate.name === field.name)) {
      throw new Error(`@FFIStruct field '${field.name}' is declared more than once`);
    }
    const typeName = field.typeName;
    const fieldSize = annotationInteger(field.annotations, "FFISize") ?? defaultFieldSize(typeName);
    if (fieldSize === null || fieldSize === undefined || !Number.isInteger(fieldSize) || fieldSize <= 0) {
      throw new Error(`@FFIStruct field '${field.name}' requires a supported type or @FFISize`);
    }
    const fieldAlignment = annotationInteger(field.annotations, "FFIAlign") ?? Math.min(fieldSize, alignment);
    if (!Number.isInteger(fieldAlignment) || !isPowerOfTwo(fieldAlignment) || fieldAlignment > alignment) {
      throw new Error(`@FFIAlign on field '${field.name}' must be a positive power of two no greater than the struct alignment`);
    }
    const explicitOffset = annotationInteger(field.annotations, "FFIOffset");
    const offset = explicitOffset ?? alignTo(cursor, fieldAlignment);
    if (!Number.isInteger(offset) || offset < 0 || offset % fieldAlignment !== 0 || offset + fieldSize > size) {
      throw new Error(`@FFIStruct field '${field.name}' is outside its ${size}-byte layout`);
    }
    const mapping = fieldMapping(typeName, fieldSize);
    if (!mapping) throw new Error(`@FFIStruct cannot map '${typeName}' with size ${fieldSize}`);
    fields.push({
      name: field.name,
      typeName,
      constructorParameter: field.constructorParameter,
      ...(field.constructorDefaultValue ? { constructorDefaultValue: field.constructorDefaultValue } : {}),
      offset,
      size: fieldSize,
      alignment: fieldAlignment,
      ...mapping,
    });
    cursor = Math.max(cursor, offset + fieldSize);
  }
  return { size, alignment, fields };
}
