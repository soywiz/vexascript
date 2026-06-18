import type { AnalysisType } from "./types";
import { typeToString } from "./types";

export function isNumberLikeType(type: AnalysisType): boolean {
  return (
    (type.kind === "builtin" && type.name === "number") ||
    (type.kind === "literal" && type.base === "number")
  );
}

/**
 * Formats an AnalysisType as a human-readable label for diagnostic messages.
 * Unlike typeToString, this renders function types in the `(p: T) => R` form
 * instead of a compact single-word representation.
 */
export function typeToDiagnosticLabel(type: AnalysisType): string {
  if (type.kind !== "function") {
    return typeToString(type);
  }
  const parameters = type.parameters
    .map((parameter) =>
      `${parameter.name}${parameter.optional === true ? "?" : ""}: ${typeToDiagnosticLabel(parameter.type)}`
    )
    .join(", ");
  return `(${parameters}) => ${typeToDiagnosticLabel(type.returnType)}`;
}
