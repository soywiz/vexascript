import { NodeKind } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { type AnalysisType, typeToString } from "compiler/analysis/types";
import type { Identifier, NewExpression, Program, VarDeclarator, VarStatement } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";

export function typeNameFromAnalysisType(type: AnalysisType | undefined): string | null {
  if (!type) {
    return null;
  }
  if (type.kind === "builtin") {
    return type.name;
  }
  if (type.kind === "named") {
    return typeToString(type);
  }
  return typeToString(type);
}

export function explicitTypeNameFromNewExpression(newExpression: NewExpression): string | null {
  if (newExpression.callee.kind !== NodeKind.Identifier) {
    return null;
  }
  const baseName = (newExpression.callee as Identifier).name;
  const typeArguments = (newExpression.typeArguments ?? []).map((typeArgument) => typeArgument.name);
  if (typeArguments.length > 0) {
    return `${baseName}<${typeArguments.join(", ")}>`;
  }
  return baseName;
}

export function inferredTypeNameLosesGenericArguments(typeName: string | null): boolean {
  if (!typeName) {
    return true;
  }
  return /<\s*any(?:\s*,\s*any)*\s*>$/.test(typeName);
}

export function declaredInitializerTypeName(
  declarationNode: Identifier,
  ast: Program
): string | null {
  let resolvedTypeName: string | null = null;
  walkAst(ast, (node) => {
    if (resolvedTypeName !== null || node.kind !== NodeKind.VarStatement) {
      return;
    }
    const varStatement = node as VarStatement;
    const candidates = varStatement.declarations?.length
      ? varStatement.declarations
      : [varStatement];
    for (const candidate of candidates) {
      const bindingName = candidate.kind === NodeKind.VarDeclarator
        ? (candidate as VarDeclarator).name
        : (candidate as VarStatement).name;
      const initializer = candidate.kind === NodeKind.VarDeclarator
        ? (candidate as VarDeclarator).initializer
        : (candidate as VarStatement).initializer;
      if (!bindingIdentifiers(bindingName).some((identifier) => identifier === declarationNode)) {
        continue;
      }
      resolvedTypeName = initializer?.kind === NodeKind.NewExpression
        ? explicitTypeNameFromNewExpression(initializer as NewExpression)
        : null;
      break;
    }
  });
  return resolvedTypeName;
}
