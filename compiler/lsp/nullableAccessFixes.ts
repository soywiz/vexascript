import type { MemberExpression, Program } from "compiler/ast/ast";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatch } from "./nodeSearch";
import { comparePosition, nodeRange, rangeSize, type NodeRange } from "./ranges";

const NULLABLE_MEMBER_ACCESS_MESSAGE =
  "Object is possibly 'null' or 'undefined'. Use optional access '?.' or a non-null assertion '!'";

interface NullableMemberTarget {
  member: MemberExpression;
  dotRange: Range;
}

function rangesEqual(left: NodeRange, right: Range): boolean {
  return comparePosition(left.start, right.start) === 0 && comparePosition(left.end, right.end) === 0;
}

function memberAccessDotRange(member: MemberExpression): Range | null {
  const objectLastToken = member.object.lastToken;
  const propertyFirstToken = member.property.firstToken;
  if (!objectLastToken || !propertyFirstToken) {
    return null;
  }

  return {
    start: {
      line: objectLastToken.range.end.line,
      character: objectLastToken.range.end.column
    },
    end: {
      line: objectLastToken.range.end.line,
      character: Math.min(propertyFirstToken.range.start.column, objectLastToken.range.end.column + 1)
    }
  };
}

function findNullableMemberTarget(ast: Program, diagnostic: Diagnostic): NullableMemberTarget | null {
  return findBestMatch(ast, (node) => {
    if (node.kind !== "MemberExpression") {
      return null;
    }

    const member = node as MemberExpression;
    if (member.optional === true || member.nonNullAsserted === true) {
      return null;
    }

    const dotRange = memberAccessDotRange(member);
    if (!dotRange || !rangesEqual(dotRange, diagnostic.range)) {
      return null;
    }

    const memberRange = nodeRange(member);
    if (!memberRange) {
      return null;
    }
    return { size: rangeSize(memberRange), value: { member, dotRange } };
  });
}

export function createNullableAccessCodeActions(params: {
  uri: string;
  ast: Program | null;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, ast, diagnostics } = params;
  if (!ast || diagnostics.length === 0) {
    return [];
  }

  const actions: CodeAction[] = [];
  const seen = new Set<string>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.message !== NULLABLE_MEMBER_ACCESS_MESSAGE) {
      continue;
    }
    const target = findNullableMemberTarget(ast, diagnostic);
    if (!target) {
      continue;
    }

    const key = `${target.dotRange.start.line}:${target.dotRange.start.character}:${target.dotRange.end.line}:${target.dotRange.end.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    actions.push({
      title: "Use optional access '?.'",
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [
            {
              range: target.dotRange,
              newText: "?."
            }
          ]
        }
      }
    });

    actions.push({
      title: "Use non-null assertion '!.'",
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [
            {
              range: target.dotRange,
              newText: "!."
            }
          ]
        }
      }
    });
  }

  return actions;
}
