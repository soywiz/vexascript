import type { CodeAction, Diagnostic, Position } from "vscode-languageserver/node.js";
import { CHARACTER_LITERAL_LENGTH_ERROR } from "compiler/parser/parser";
import { TokenType, tokenize } from "compiler/parser/tokenizer";
import { CodeActionKind } from "./codeActionKinds";

function positionToOffset(text: string, position: Position): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line && lineStart < text.length) {
    const lineBreak = text.indexOf("\n", lineStart);
    if (lineBreak < 0) {
      return text.length;
    }
    line += 1;
    lineStart = lineBreak + 1;
  }
  return Math.min(text.length, lineStart + position.character);
}

export function createCharacterLiteralCodeActions(params: {
  uri: string;
  text: string;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, text, diagnostics } = params;
  const actions: CodeAction[] = [];
  const seenRanges = new Set<string>();

  for (const diagnostic of diagnostics) {
    if (diagnostic.message !== CHARACTER_LITERAL_LENGTH_ERROR) {
      continue;
    }
    const start = positionToOffset(text, diagnostic.range.start);
    const end = positionToOffset(text, diagnostic.range.end);
    const source = text.slice(start, end);
    const token = tokenize(source, { language: "vexa" })[0];
    if (token?.type !== TokenType.CHARACTER) {
      continue;
    }
    const key = `${start}:${end}`;
    if (seenRanges.has(key)) {
      continue;
    }
    seenRanges.add(key);
    actions.push({
      title: "Convert to double-quoted string",
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [{ range: diagnostic.range, newText: JSON.stringify(token.value) }]
        }
      }
    });
  }

  return actions;
}
