import type { FunctionDeclarationKind } from "./ast/ast";

export type CanonicalImmutableDeclaration = "const" | "val";
export type CanonicalFunctionDeclaration = FunctionDeclarationKind;

export interface CanonicalSyntax {
  immutableDeclaration: CanonicalImmutableDeclaration;
  functionDeclaration: CanonicalFunctionDeclaration;
}

export const DEFAULT_CANONICAL_SYNTAX: CanonicalSyntax = {
  immutableDeclaration: "const",
  functionDeclaration: "func"
};

export function canonicalSyntaxFromConfig(value: unknown): CanonicalSyntax | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const immutableDeclaration = record["immutableDeclaration"];
  const functionDeclaration = record["functionDeclaration"];
  return {
    immutableDeclaration: immutableDeclaration === "val" || immutableDeclaration === "const"
      ? immutableDeclaration
      : DEFAULT_CANONICAL_SYNTAX.immutableDeclaration,
    functionDeclaration:
      functionDeclaration === "fun" ||
      functionDeclaration === "fn" ||
      functionDeclaration === "func" ||
      functionDeclaration === "function"
        ? functionDeclaration
        : DEFAULT_CANONICAL_SYNTAX.functionDeclaration
  };
}
