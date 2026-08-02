export type PrimitiveMatcherKind = "string" | "number" | "boolean" | "bigint";

/** Maps VexaScript primitive type names to their shared runtime representation. */
export function primitiveMatcherKind(typeName: string): PrimitiveMatcherKind | null {
  switch (typeName) {
    case "string":
      return "string";
    case "int":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "long":
    case "bigint":
      return "bigint";
    default:
      return null;
  }
}
