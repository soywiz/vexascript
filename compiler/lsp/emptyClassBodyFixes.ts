import { ClassStatement } from "compiler/ast/ast";
import type { Node, Program } from "compiler/ast/ast";

import { type CodeAction } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findNodeAtPosition } from "./nodeSearch";
import { offsetToPosition, type Position } from "./ranges";

interface OffsetRangedToken {
  value?: string;
  range: {
    start: { offset: number };
    end: { offset: number };
  };
}

function isClassStatement(node: Node): node is ClassStatement {
  return node instanceof ClassStatement;
}

/**
 * Offers a quick fix to drop an empty class body (`class Foo { }` to
 * `class Foo`). The brace-less form is valid VexaScript, so when a class declares
 * no members and its body contains nothing but whitespace, the surrounding
 * braces are pure noise and can be removed.
 *
 * The fix is purely text-driven: the parser does not retain the body brace
 * tokens on {@link ClassStatement}, but the class node's `lastToken` is the
 * closing `}` whenever the braced form was used, which is enough to locate the
 * matching `{` and the header that precedes it.
 */
export function createEmptyClassBodyCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
}): CodeAction[] {
  const { uri, ast, text, position } = params;
  if (!ast) {
    return [];
  }

  const node = findNodeAtPosition(ast, position, isClassStatement);
  if (!node || node.members.length > 0) {
    return [];
  }

  const closeBrace = node.lastToken as OffsetRangedToken | undefined;
  if (!closeBrace || closeBrace.value !== "}") {
    return [];
  }

  const closeBraceStart = closeBrace.range.start.offset;
  const openBraceOffset = text.lastIndexOf("{", closeBraceStart);
  if (openBraceOffset < 0) {
    return [];
  }

  // Only remove a body that is genuinely empty: anything other than whitespace
  // between the braces (e.g. a comment) must be preserved.
  const between = text.slice(openBraceOffset + 1, closeBraceStart);
  if (between.trim().length > 0) {
    return [];
  }

  // Trim the whitespace that separates the class header from the opening brace
  // so `class Foo(...) {\n}` collapses cleanly to `class Foo(...)`.
  let removalStart = openBraceOffset;
  while (removalStart > 0 && /\s/.test(text[removalStart - 1] ?? "")) {
    removalStart -= 1;
  }

  const removalEnd = closeBrace.range.end.offset;

  return [
    {
      title: "Remove empty class body",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            {
              range: {
                start: offsetToPosition(text, removalStart),
                end: offsetToPosition(text, removalEnd)
              },
              newText: ""
            }
          ]
        }
      }
    }
  ];
}
