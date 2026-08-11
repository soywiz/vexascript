import {
  AssignmentExpression,
  ClassMethodMember,
  FunctionStatement,
  Identifier,
  InterfaceMethodMember,
  UpdateExpression,
  VarStatement
} from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import {
  DEFAULT_CANONICAL_SYNTAX,
  type CanonicalSyntax
} from "compiler/canonicalSyntax";
import { TokenType } from "compiler/parser/tokenizer";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { walkAstUntil } from "compiler/ast/traversal";
import { findNodeAtPosition } from "./nodeSearch";

export interface KeywordReplacement {
  from: "let" | "const" | "var" | "val" | "fun" | "fn" | "func" | "function";
  to: "let" | "const" | "var" | "val" | "fun" | "fn" | "func" | "function";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function isPositionInsideTokenRange(
  token:
    | {
        range: {
          start: { line: number; column: number };
          end: { line: number; column: number };
        };
      }
    | undefined,
  line: number,
  character: number
): boolean {
  if (!token) {
    return false;
  }

  const start = token.range.start;
  const end = token.range.end;

  if (line < start.line || line > end.line) {
    return false;
  }
  if (line === start.line && character < start.column) {
    return false;
  }
  if (line === end.line && character > end.column) {
    return false;
  }

  return true;
}

function collectDeclaredNames(varStatement: VarStatement): Set<string> {
  const names = new Set<string>();
  for (const id of bindingIdentifiers(varStatement.name)) {
    names.add(id.name);
  }
  for (const decl of varStatement.declarations ?? []) {
    for (const id of bindingIdentifiers(decl.name)) {
      names.add(id.name);
    }
  }
  return names;
}

function isReassigned(ast: Program, names: Set<string>): boolean {
  let found = false;
  walkAstUntil(ast, (node) => {
    if (found) return false;
    if (node instanceof AssignmentExpression) {
      const left = (node as AssignmentExpression).left;
      if (left instanceof Identifier && names.has((left as Identifier).name)) {
        found = true;
        return false;
      }
    }
    if (node instanceof UpdateExpression) {
      const arg = (node as UpdateExpression).argument;
      if (arg instanceof Identifier && names.has((arg as Identifier).name)) {
        found = true;
        return false;
      }
    }
    return true;
  });
  return found;
}

export function findDeclarationKeywordReplacementsAtPosition(
  ast: Program,
  line: number,
  character: number,
  canonicalSyntax: CanonicalSyntax = DEFAULT_CANONICAL_SYNTAX
): KeywordReplacement[] {
  const variableStatement = findNodeAtPosition(
    ast,
    { line, character },
    (node): node is VarStatement => node instanceof VarStatement
  );
  const functionDeclaration = findNodeAtPosition(
    ast,
    { line, character },
    (node): node is FunctionStatement | ClassMethodMember | InterfaceMethodMember =>
      node instanceof FunctionStatement ||
      node instanceof ClassMethodMember ||
      node instanceof InterfaceMethodMember
  );
  const functionToken = functionDeclaration?.declarationKeywordToken;
  if (functionToken && isPositionInsideTokenRange(functionToken, line, character)) {
    const from = functionToken.value as KeywordReplacement["from"];
    if (from === canonicalSyntax.functionDeclaration) {
      return [];
    }
    return [{
      from,
      to: canonicalSyntax.functionDeclaration,
      range: {
        start: { line: functionToken.range.start.line, character: functionToken.range.start.column },
        end: { line: functionToken.range.end.line, character: functionToken.range.end.column }
      }
    }];
  }

  if (!variableStatement) return [];

  const declarationToken = variableStatement.firstToken;
  if (
    !declarationToken ||
    declarationToken.type !== TokenType.IDENTIFIER ||
    !isPositionInsideTokenRange(declarationToken, line, character)
  ) return [];

  const from = declarationToken.value as KeywordReplacement["from"];
  const tokenRange = {
    start: { line: declarationToken.range.start.line, character: declarationToken.range.start.column },
    end: { line: declarationToken.range.end.line, character: declarationToken.range.end.column }
  };

  const replacements: KeywordReplacement[] = [];

  if (from === "const" || from === "val") {
    replacements.push({
      from,
      to: from === canonicalSyntax.immutableDeclaration ? "var" : canonicalSyntax.immutableDeclaration,
      range: tokenRange
    });
  } else if (from === "let") {
    replacements.push({ from, to: "var", range: tokenRange });
    const names = collectDeclaredNames(variableStatement);
    if (!isReassigned(ast, names)) {
      replacements.push({ from, to: canonicalSyntax.immutableDeclaration, range: tokenRange });
    }
  } else if (from === "var") {
    const names = collectDeclaredNames(variableStatement);
    if (!isReassigned(ast, names)) {
      replacements.push({ from, to: canonicalSyntax.immutableDeclaration, range: tokenRange });
    }
  }

  return replacements;
}

/** @deprecated Use findDeclarationKeywordReplacementsAtPosition */
export function findDeclarationKeywordReplacementAtPosition(
  ast: Program,
  line: number,
  character: number
): KeywordReplacement | null {
  return findDeclarationKeywordReplacementsAtPosition(ast, line, character)[0] ?? null;
}
