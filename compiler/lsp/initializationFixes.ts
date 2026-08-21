import type { CodeAction, Diagnostic, Position } from "vscode-languageserver/node.js";
import { ClassFieldMember, type Node, type Program, VarStatement, nodeStartOffset } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { childNodes } from "compiler/ast/traversal";
import type { Analysis } from "compiler/analysis/Analysis";
import { CodeActionKind } from "./codeActionKinds";
import { diagnosticHasCode, VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";

function positionAt(text: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: Math.max(0, Math.min(offset, text.length) - lineStart) };
}

function declarationOffsetsFromAnalysis(
  ast: Program,
  analysis: Analysis,
  diagnostic: Diagnostic
): { declarationStart: number; declarationEnd: number } | null {
  const symbolNode = analysis.getSymbolAt(
    diagnostic.range.start.line,
    diagnostic.range.start.character
  )?.symbol.node;
  if (!symbolNode) return null;

  const pending: Node[] = [ast];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const isDeclaration = node instanceof ClassFieldMember
      ? node.name === symbolNode
      : node instanceof VarStatement && (
        node.declarations?.length
          ? node.declarations.some((declaration) => bindingIdentifiers(declaration.name).some((identifier) => identifier === symbolNode))
          : bindingIdentifiers(node.name).some((identifier) => identifier === symbolNode)
      );
    if (isDeclaration) {
      return {
        declarationStart: node.firstToken?.range.start.offset ?? nodeStartOffset(node) ?? 0,
        declarationEnd: nodeStartOffset(symbolNode) ?? node.lastToken?.range.end.offset ?? 0,
      };
    }
    pending.push(...childNodes(node));
  }
  return null;
}

export function createInitializationCodeActions(params: {
  uri: string;
  text: string;
  ast: Program;
  analysis: Analysis | null;
  diagnostics: readonly Diagnostic[];
}): CodeAction[] {
  const actions: CodeAction[] = [];
  const seenOffsets = new Set<number>();
  for (const diagnostic of params.diagnostics) {
    if (
      !diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.VARIABLE_USED_BEFORE_INITIALIZATION) &&
      !diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.CLASS_FIELD_NOT_INITIALIZED)
    ) continue;
    const data = diagnostic.data as { declarationKeywordOffset?: unknown; declarationNameOffset?: unknown } | undefined;
    const recovered = params.analysis
      ? declarationOffsetsFromAnalysis(params.ast, params.analysis, diagnostic)
      : null;
    const declarationStart = typeof data?.declarationKeywordOffset === "number"
      ? data.declarationKeywordOffset
      : recovered?.declarationStart;
    const declarationEnd = typeof data?.declarationNameOffset === "number"
      ? data.declarationNameOffset
      : recovered?.declarationEnd;
    if (typeof declarationStart !== "number") continue;
    const searchEnd = typeof declarationEnd === "number" ? declarationEnd : declarationStart + 3;
    const declarationHead = params.text.slice(declarationStart, searchEnd);
    const relativeKeywordOffset = declarationHead.search(/\bvar\b/);
    if (relativeKeywordOffset < 0) continue;
    const keywordOffset = declarationStart + relativeKeywordOffset;
    if (seenOffsets.has(keywordOffset) || params.text[keywordOffset + 3] === "!") continue;
    seenOffsets.add(keywordOffset);
    const insertPosition = positionAt(params.text, keywordOffset + 3);
    actions.push({
      title: "Change 'var' to 'var!'",
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [params.uri]: [{
            range: { start: insertPosition, end: insertPosition },
            newText: "!",
          }],
        },
      },
    });
  }
  return actions;
}
