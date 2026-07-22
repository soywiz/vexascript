import { AssignmentExpression, Identifier, UpdateExpression, VarStatement } from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import { TokenType } from "compiler/parser/tokenizer";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { walkAstUntil } from "compiler/ast/traversal";
import { findNodeAtPosition } from "./nodeSearch";

export interface KeywordReplacement {
  from: "let" | "const" | "var" | "val";
  to: "let" | "const" | "var" | "val";
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
  character: number
): KeywordReplacement[] {
  const variableStatement = findNodeAtPosition(
    ast,
    { line, character },
    (node): node is VarStatement => node instanceof VarStatement
  );
  if (!variableStatement) {
    return [];
  }

  const declarationToken = variableStatement.firstToken;
  if (!declarationToken || declarationToken.type !== TokenType.IDENTIFIER) {
    return [];
  }

  if (!isPositionInsideTokenRange(declarationToken, line, character)) {
    return [];
  }

  const from = declarationToken.value as KeywordReplacement["from"];
  const tokenRange = {
    start: { line: declarationToken.range.start.line, character: declarationToken.range.start.column },
    end: { line: declarationToken.range.end.line, character: declarationToken.range.end.column }
  };

  const replacements: KeywordReplacement[] = [];

  if (from === "const") {
    replacements.push({ from, to: "val", range: tokenRange });
  } else if (from === "let") {
    replacements.push({ from, to: "var", range: tokenRange });
    const names = collectDeclaredNames(variableStatement);
    if (!isReassigned(ast, names)) {
      replacements.push({ from, to: "val", range: tokenRange });
    }
  } else if (from === "var") {
    const names = collectDeclaredNames(variableStatement);
    if (!isReassigned(ast, names)) {
      replacements.push({ from, to: "val", range: tokenRange });
    }
  } else if (from === "val") {
    replacements.push({ from, to: "var", range: tokenRange });
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
