import type { ClassFieldMember, ClassMethodMember, Program } from "compiler/ast/ast";
import type { CodeAction, Diagnostic } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatchAtPosition } from "./nodeSearch";
import { nodeRange, tokenStartPosition } from "./ranges";
import {
  diagnosticHasCode,
  MISSING_OVERRIDE_MODIFIER_PATTERN,
  VEXA_DIAGNOSTIC_CODES
} from "./diagnosticCodes";

function isMissingOverrideDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "vexa-sema") {
    return false;
  }
  // Match by code when present, falling back to the message so the fix is still
  // offered when the diagnostic payload carries no machine-readable code.
  return diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.MISSING_OVERRIDE_MODIFIER)
    || MISSING_OVERRIDE_MODIFIER_PATTERN.test(diagnostic.message);
}

function findClassMemberAtPosition(
  ast: Program,
  position: { line: number; character: number }
): ClassFieldMember | ClassMethodMember | null {
  return findBestMatchAtPosition(ast, position, (node) => {
    if (node.kind !== "ClassFieldMember" && node.kind !== "ClassMethodMember") {
      return null;
    }
    const member = node as ClassFieldMember | ClassMethodMember;
    const range = nodeRange(member);
    if (!range) {
      return null;
    }
    return { range, build: () => member };
  });
}

/**
 * Quick fix for the "must be declared with 'override'" diagnostic: inserts the
 * `override` modifier at the start of the member declaration. The modifier is
 * type-only and erased from emitted JavaScript.
 */
export function createOverrideModifierCodeActions(params: {
  uri: string;
  ast: Program | null;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, ast, diagnostics } = params;
  if (!ast) {
    return [];
  }

  const actions: CodeAction[] = [];
  for (const diagnostic of diagnostics) {
    if (!isMissingOverrideDiagnostic(diagnostic)) {
      continue;
    }
    const member = findClassMemberAtPosition(ast, diagnostic.range.start);
    if (!member || member.override === true || !member.firstToken) {
      continue;
    }
    const insertPosition = tokenStartPosition(member.firstToken);
    actions.push({
      title: `Add 'override' to '${member.name.name}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [
            {
              range: { start: insertPosition, end: insertPosition },
              newText: "override "
            }
          ]
        }
      }
    });
  }
  return actions;
}
