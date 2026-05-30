import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
import type { Program } from "compiler/ast/ast";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";

const KEYWORD_COMPLETIONS: CompletionItem[] = [
  { label: "fn", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "type", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "interface", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "int", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "number", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "string", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "boolean", kind: CompletionItemKind.Keyword, detail: "Builtin type" }
];

function symbolKindToCompletionKind(symbol: AnalysisSymbol): CompletionItemKind {
  if (symbol.kind === "function" || symbol.kind === "method") {
    return CompletionItemKind.Function;
  }
  if (symbol.kind === "class") {
    return CompletionItemKind.Class;
  }
  return CompletionItemKind.Variable;
}

function symbolDetail(symbol: AnalysisSymbol): string {
  if (symbol.valueType) {
    return `In-scope ${symbol.kind}: ${symbol.valueType}`;
  }
  return `In-scope ${symbol.kind}`;
}

export function createCompletionItemsForPosition(
  ast: Program,
  line: number,
  character: number
): CompletionItem[] {
  const analysis = new Analysis(ast);
  const visibleSymbols = analysis.getVisibleSymbolsAt(line, character);

  const items: CompletionItem[] = [...KEYWORD_COMPLETIONS];
  for (const symbol of visibleSymbols) {
    items.push({
      label: symbol.name,
      kind: symbolKindToCompletionKind(symbol),
      detail: symbolDetail(symbol)
    });
  }

  return items;
}

export function createKeywordOnlyCompletionItems(): CompletionItem[] {
  return [...KEYWORD_COMPLETIONS];
}
