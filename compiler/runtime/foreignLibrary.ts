import { ClassMethodMember, ClassStatement, StringLiteral } from "compiler/ast/ast";

export interface ForeignLibraryDefinition {
  paths: string[];
}

export interface ForeignReturnDefinition {
  async: boolean;
  valueTypeName: string;
}

export function foreignLibraryForClass(statement: ClassStatement): ForeignLibraryDefinition | null {
  const annotation = (statement.annotations ?? []).find((candidate) => candidate.name.name === "FFILibrary");
  if (!annotation) return null;
  const paths = annotation.args
    .filter((argument): argument is StringLiteral => argument instanceof StringLiteral)
    .map((argument) => argument.value);
  return paths.length > 0 ? { paths } : null;
}

export function foreignSymbolName(method: ClassMethodMember): string {
  const annotation = (method.annotations ?? []).find((candidate) => candidate.name.name === "FFIName");
  const argument = annotation?.args[0];
  return argument instanceof StringLiteral ? argument.value : method.name.name;
}

export function foreignDenoType(typeName: string, result = false): string | null {
  switch (typeName) {
    case "int": return "i32";
    case "long": return "i64";
    case "number": return "f64";
    case "boolean": return "u8";
    case "string": return result ? null : "buffer";
    case "ArrayBuffer": return result ? null : "buffer";
    case "FFIPointer": return "pointer";
    case "void": return result ? "void" : null;
    default: return null;
  }
}

export function foreignReturnDefinition(typeName: string): ForeignReturnDefinition {
  const trimmed = typeName.trim();
  if (trimmed.startsWith("Promise<") && trimmed.endsWith(">")) {
    return { async: true, valueTypeName: trimmed.slice(8, -1).trim() };
  }
  return { async: false, valueTypeName: trimmed };
}
