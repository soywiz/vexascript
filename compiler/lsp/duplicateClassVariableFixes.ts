import { NodeKind } from "compiler/ast/ast";
import type { ClassFieldMember, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { containsPosition, nodeRange, offsetToPosition, positionToOffset } from "./ranges";

function rangesEqual(left: Range, right: Range): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function classFieldAtDiagnostic(ast: Program, diagnostic: Diagnostic): ClassFieldMember | null {
  let found: ClassFieldMember | null = null;
  walkAst(ast, (node) => {
    if (node.kind !== NodeKind.ClassFieldMember) {
      return true;
    }
    const field = node as ClassFieldMember;
    const nameRange = nodeRange(field.name);
    if (!nameRange || !rangesEqual(nameRange, diagnostic.range)) {
      return true;
    }
    found = field;
    return false;
  });
  return found;
}

function memberRemovalRange(text: string, member: ClassFieldMember): Range | null {
  const range = nodeRange(member);
  if (!range) {
    return null;
  }

  const memberStart = positionToOffset(text, range.start);
  const memberEnd = positionToOffset(text, range.end);
  const previousBreak = text.lastIndexOf("\n", Math.max(0, memberStart - 1));
  const removalStart = previousBreak < 0 ? 0 : previousBreak + 1;
  const nextBreak = text.indexOf("\n", memberEnd);
  const removalEnd = nextBreak < 0 ? memberEnd : nextBreak + 1;

  return {
    start: offsetToPosition(text, removalStart),
    end: offsetToPosition(text, removalEnd)
  };
}

export function createDuplicateClassVariableCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  range: Range;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, ast, text, range, diagnostics } = params;
  if (!ast) {
    return [];
  }

  const actions: CodeAction[] = [];
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.code !== VEXA_DIAGNOSTIC_CODES.DUPLICATE_CLASS_VARIABLE ||
      !containsPosition(diagnostic.range, range.start)
    ) {
      continue;
    }

    const field = classFieldAtDiagnostic(ast, diagnostic);
    if (!field) {
      continue;
    }
    const removalRange = memberRemovalRange(text, field);
    if (!removalRange) {
      continue;
    }

    actions.push({
      title: `Remove duplicate class variable '${field.name.name}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [
            {
              range: removalRange,
              newText: ""
            }
          ]
        }
      }
    });
  }

  return actions;
}
