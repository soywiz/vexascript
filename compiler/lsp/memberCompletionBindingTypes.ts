import type { Expr, FunctionParameter, Identifier, Program, TypeAnnotation, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { walkAst } from "compiler/ast/traversal";
import { containsPosition, nodeRange, rangeSize } from "./ranges";

export function findIdentifierAtPosition(
  ast: Program,
  line: number,
  character: number
): Identifier | null {
  let best: { identifier: Identifier; size: number } | undefined;
  walkAst(ast, (node) => {
    if (node.kind !== "Identifier") {
      return;
    }
    const identifier = node as Identifier;
    const range = nodeRange(identifier);
    if (!range || !containsPosition(range, { line, character })) {
      return;
    }
    const size = rangeSize(range);
    if (!best || size < best.size) {
      best = { identifier, size };
    }
  });
  return best ? best.identifier : null;
}

export function inferClassNameFromAstVariableInitializer(
  ast: Program,
  variableName: string,
  line: number
): string | null {
  let bestLine = -1;
  let bestClassName: string | null = null;

  const maybeClassNameFromInitializer = (initializer: Expr | undefined): string | null => {
    if (!initializer || initializer.kind !== "NewExpression") {
      return null;
    }
    const newExpression = initializer as Expr & { kind: "NewExpression"; callee: Expr };
    if (newExpression.callee.kind === "Identifier") {
      return (newExpression.callee as Expr & { kind: "Identifier"; name: string }).name;
    }
    return null;
  };

  const considerDeclaration = (
    name: string,
    initializer: Expr | undefined,
    declarationLine: number
  ): void => {
    if (name !== variableName || declarationLine > line) {
      return;
    }
    const className = maybeClassNameFromInitializer(initializer);
    if (!className) {
      return;
    }
    if (declarationLine >= bestLine) {
      bestLine = declarationLine;
      bestClassName = className;
    }
  };

  walkAst(ast, (node) => {
    if (node.kind !== "VarStatement") {
      return;
    }
    const varStatement = node as VarStatement;
    if (varStatement.declarations && varStatement.declarations.length > 0) {
      for (const declaration of varStatement.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          const declarationLine = identifier.firstToken?.range.start.line ?? -1;
          considerDeclaration(identifier.name, declaration.initializer, declarationLine);
        }
      }
    } else {
      for (const identifier of bindingIdentifiers(varStatement.name)) {
        const declarationLine = identifier.firstToken?.range.start.line ?? -1;
        considerDeclaration(identifier.name, varStatement.initializer, declarationLine);
      }
    }
  });

  return bestClassName;
}

export function inferTypeNameFromAstBindingAnnotation(
  ast: Program,
  bindingName: string,
  line: number
): string | null {
  let bestLine = -1;
  let bestTypeName: string | null = null;

  const typeNameFromAnnotation = (typeAnnotation: TypeAnnotation | undefined): string | null => {
    if (!typeAnnotation) {
      return null;
    }
    if (typeAnnotation.kind === "Identifier") {
      return typeAnnotation.name;
    }
    if (typeAnnotation.kind === "TypeReference") {
      return typeAnnotation.name.name;
    }
    return null;
  };

  const considerDeclaration = (
    name: string,
    typeAnnotation: TypeAnnotation | undefined,
    declarationLine: number
  ): void => {
    if (name !== bindingName || declarationLine > line) {
      return;
    }
    const typeName = typeNameFromAnnotation(typeAnnotation);
    if (!typeName) {
      return;
    }
    if (declarationLine >= bestLine) {
      bestLine = declarationLine;
      bestTypeName = typeName;
    }
  };

  walkAst(ast, (node) => {
    if (node.kind === "FunctionParameter") {
      const parameter = node as FunctionParameter;
      for (const identifier of bindingIdentifiers(parameter.name)) {
        const declarationLine = identifier.firstToken?.range.start.line ?? -1;
        considerDeclaration(identifier.name, parameter.typeAnnotation, declarationLine);
      }
      return;
    }
    if (node.kind !== "VarStatement") {
      return;
    }
    const varStatement = node as VarStatement;
    if (varStatement.declarations && varStatement.declarations.length > 0) {
      for (const declaration of varStatement.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          const declarationLine = identifier.firstToken?.range.start.line ?? -1;
          considerDeclaration(identifier.name, declaration.typeAnnotation, declarationLine);
        }
      }
    } else {
      for (const identifier of bindingIdentifiers(varStatement.name)) {
        const declarationLine = identifier.firstToken?.range.start.line ?? -1;
        considerDeclaration(identifier.name, varStatement.typeAnnotation, declarationLine);
      }
    }
  });

  return bestTypeName;
}
