import type { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/model";
import type { Identifier, MemberExpression, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import type { CodeAction } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { containsPosition, nodeRange, rangeSize, type Position } from "./ranges";

interface ImplicitReceiverTarget {
  identifier: Identifier;
  symbol: AnalysisSymbol;
}

interface ThisMemberTarget {
  member: MemberExpression;
  property: Identifier;
}

function symbolAtIdentifier(analysis: Analysis, identifier: Identifier): AnalysisSymbol | null {
  const start = identifier.firstToken?.range.start;
  if (!start) {
    return null;
  }
  return analysis.getSymbolAt(start.line, start.column)?.symbol ?? null;
}

function findImplicitReceiverIdentifierAtPosition(
  ast: Program,
  analysis: Analysis,
  position: Position
): ImplicitReceiverTarget | null {
  let bestTarget: ImplicitReceiverTarget | null = null;
  let bestSize = Number.POSITIVE_INFINITY;

  walkAst(ast, (node) => {
    if (node.kind !== "Identifier") {
      return;
    }

    const identifier = node as Identifier;
    const range = nodeRange(identifier);
    if (!range || !containsPosition(range, position)) {
      return;
    }

    const symbol = symbolAtIdentifier(analysis, identifier);
    if (!symbol || symbol.implicitReceiver !== true || symbol.implicitReceiverClassName) {
      return;
    }

    const size = rangeSize(range);
    if (size <= bestSize) {
      bestTarget = { identifier, symbol };
      bestSize = size;
    }
  });

  return bestTarget;
}

function findThisMemberAtPosition(
  ast: Program,
  position: Position
): ThisMemberTarget | null {
  let bestTarget: ThisMemberTarget | null = null;
  let bestSize = Number.POSITIVE_INFINITY;

  walkAst(ast, (node) => {
    if (node.kind !== "MemberExpression") {
      return;
    }

    const member = node as MemberExpression;
    if (
      member.computed ||
      member.object.kind !== "Identifier" ||
      (member.object as Identifier).name !== "this" ||
      member.property.kind !== "Identifier"
    ) {
      return;
    }

    const property = member.property as Identifier;
    const propertyRange = nodeRange(property);
    if (!propertyRange || !containsPosition(propertyRange, position)) {
      return;
    }

    const memberRange = nodeRange(member);
    if (!memberRange) {
      return;
    }

    const size = rangeSize(memberRange);
    if (size <= bestSize) {
      bestTarget = { member, property };
      bestSize = size;
    }
  });

  return bestTarget;
}

function canRemoveThisQualifier(analysis: Analysis, property: Identifier): boolean {
  const start = property.firstToken?.range.start;
  if (!start) {
    return false;
  }

  let hasImplicitReceiverMatch = false;
  for (const visible of analysis.getVisibleSymbolsAt(start.line, start.column)) {
    if (visible.name !== property.name) {
      continue;
    }
    if (visible.implicitReceiver === true && !visible.implicitReceiverClassName) {
      hasImplicitReceiverMatch = true;
      continue;
    }
    return false;
  }

  return hasImplicitReceiverMatch;
}

export function createThisCodeActions(params: {
  uri: string;
  ast: Program | null;
  analysis?: Analysis | null;
  position: Position;
}): CodeAction[] {
  const { uri, ast, analysis, position } = params;
  if (!ast || !analysis) {
    return [];
  }

  const actions: CodeAction[] = [];

  const thisMember = findThisMemberAtPosition(ast, position);
  if (thisMember && canRemoveThisQualifier(analysis, thisMember.property)) {
    const objectStart = thisMember.member.object.firstToken?.range.start;
    const propertyStart = thisMember.property.firstToken?.range.start;
    if (objectStart && propertyStart) {
      actions.push({
        title: `Remove 'this.' from '${thisMember.property.name}'`,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: objectStart.line, character: objectStart.column },
                  end: { line: propertyStart.line, character: propertyStart.column }
                },
                newText: ""
              }
            ]
          }
        }
      });
    }
  }

  const implicitReceiver = findImplicitReceiverIdentifierAtPosition(ast, analysis, position);
  if (implicitReceiver) {
    const start = implicitReceiver.identifier.firstToken?.range.start;
    if (start) {
      actions.push({
        title: `Add 'this.' to '${implicitReceiver.identifier.name}'`,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: start.line, character: start.column },
                  end: { line: start.line, character: start.column }
                },
                newText: "this."
              }
            ]
          }
        }
      });
    }
  }

  return actions;
}
