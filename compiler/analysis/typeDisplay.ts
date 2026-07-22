import { NodeKind, nodeKindName } from "compiler/ast/ast";
import { type AnalysisType, FunctionType, BuiltinType, LiteralType } from "./types";
import { typeToString } from "./types";
import type { Expr } from "compiler/ast/ast";

export function isNumberLikeType(type: AnalysisType): boolean {
  return (
    (type instanceof BuiltinType && type.name === "number") ||
    (type instanceof LiteralType && type.base === "number")
  );
}

/**
 * Formats an AnalysisType as a human-readable label for diagnostic messages.
 * Unlike typeToString, this renders function types in the `(p: T) => R` form
 * instead of a compact single-word representation.
 */
/**
 * Maps a VexaScript built-in primitive type name to the corresponding boxed
 * interface name (`Number`, `String`, `Boolean`, `BigInt`). Returns null for
 * names that have no boxed equivalent.
 */
export function boxedInterfaceNameForBuiltin(name: string): string | null {
  if (name === "int" || name === "number" || name === "numeric") return "Number";
  if (name === "string") return "String";
  if (name === "boolean") return "Boolean";
  if (name === "bigint" || name === "long") return "BigInt";
  return null;
}

/**
 * Produces a short snippet label for an expression node, suitable for
 * inline diagnostic context. Returns null for simple identifiers (already
 * visible in the surrounding message).
 */
export function expressionSnippet(expression: Expr): string | null {
  if (expression.kind === NodeKind.Identifier) {
    return null;
  }
  const first = expression.firstToken?.value;
  const last = expression.lastToken?.value;
  if (!first && !last) {
    return nodeKindName(expression.kind);
  }
  if (first && last && first !== last) {
    return `${first} ... ${last}`;
  }
  if (first) {
    return first;
  }
  return last ?? nodeKindName(expression.kind);
}

export function typeToDiagnosticLabel(type: AnalysisType): string {
  if (!(type instanceof FunctionType)) {
    return typeToString(type);
  }
  const functionType = type as FunctionType;
  const parameters: string[] = [];
  for (const functionParameter of functionType.parameters) {
    if (functionParameter.receiver) continue;
    parameters.push(
      `${functionParameter.name}${functionParameter.optional === true ? "?" : ""}: ${typeToDiagnosticLabel(functionParameter.type)}`
    );
  }
  const receiver = functionType.parameters.find((parameter) => parameter.receiver);
  return `${receiver ? `${typeToDiagnosticLabel(receiver.type)}.` : ""}(${parameters.join(", ")}) => ${typeToDiagnosticLabel(functionType.returnType)}`;
}
