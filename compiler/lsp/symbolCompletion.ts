import type { CompletionItem } from "vscode-languageserver/node.js";
import type { Identifier, Program } from "compiler/ast/ast";
import type { Analysis, AnalysisSymbol } from "compiler/analysis/Analysis";
import { typeToString } from "compiler/analysis/types";
import { readDocumentationForSymbol } from "./documentation";
import type { CompletionRequestOptions } from "./completionModel";
import { symbolDetail, symbolKindToCompletionKind } from "./completionModel";

function symbolTypeName(symbol: AnalysisSymbol): string | null {
  if (symbol.valueType && symbol.valueType !== "unknown") {
    return symbol.valueType;
  }
  if (symbol.type) {
    return typeToString(symbol.type);
  }
  return null;
}

function isAssignableTypeName(sourceType: string, targetType: string): boolean {
  if (sourceType === targetType) {
    return true;
  }
  if (sourceType === "int" && targetType === "number") {
    return true;
  }
  if (sourceType === "long" && targetType === "bigint") {
    return true;
  }
  if (
    targetType === "numeric" &&
    (sourceType === "int" || sourceType === "number" || sourceType === "long" || sourceType === "bigint")
  ) {
    return true;
  }
  return false;
}

function symbolTypeRelevance(symbol: AnalysisSymbol, expectedTypeName: string | null): number {
  if (!expectedTypeName || expectedTypeName === "unknown") {
    return 0;
  }
  const candidateTypeName = symbolTypeName(symbol);
  if (!candidateTypeName) {
    return 0;
  }
  if (candidateTypeName === expectedTypeName) {
    return 2;
  }
  if (isAssignableTypeName(candidateTypeName, expectedTypeName)) {
    return 1;
  }
  return 0;
}

function symbolKindPriority(symbol: AnalysisSymbol): number {
  if (symbol.kind === "parameter") {
    return 0;
  }
  if (symbol.kind === "variable") {
    return 1;
  }
  if (symbol.kind === "function" || symbol.kind === "method") {
    return 2;
  }
  if (symbol.kind === "class") {
    return 3;
  }
  return 4;
}

function symbolReceiverPriority(symbol: AnalysisSymbol): number {
  if (symbol.implicitReceiver === true && symbol.name !== "this") {
    return 0;
  }
  if (symbol.name === "this") {
    return 2;
  }
  return 1;
}

type RankedVisibleSymbol = {
  symbol: AnalysisSymbol;
  scopeDistance: number;
  typeRelevance: number;
  receiverPriority: number;
  kindPriority: number;
};

function rankVisibleSymbols(visibleSymbols: AnalysisSymbol[], expectedTypeName: string | null): RankedVisibleSymbol[] {
  return visibleSymbols
    .map((symbol, scopeDistance) => ({
      symbol,
      scopeDistance,
      typeRelevance: symbolTypeRelevance(symbol, expectedTypeName),
      receiverPriority: symbolReceiverPriority(symbol),
      kindPriority: symbolKindPriority(symbol)
    }))
    .sort((left, right) => {
      if (left.typeRelevance !== right.typeRelevance) {
        return right.typeRelevance - left.typeRelevance;
      }
      if (left.receiverPriority !== right.receiverPriority) {
        return left.receiverPriority - right.receiverPriority;
      }
      if (left.scopeDistance !== right.scopeDistance) {
        return left.scopeDistance - right.scopeDistance;
      }
      if (left.kindPriority !== right.kindPriority) {
        return left.kindPriority - right.kindPriority;
      }
      return left.symbol.name.localeCompare(right.symbol.name);
    });
}

export interface VisibleSymbolCompletionRequest {
  ast: Program;
  analysis: Analysis;
  line: number;
  character: number;
  expectedTypeName: string | null;
  options: CompletionRequestOptions;
  seenLabels: Set<string>;
}

export function buildVisibleSymbolCompletionItems({
  ast,
  analysis,
  line,
  character,
  expectedTypeName,
  options,
  seenLabels
}: VisibleSymbolCompletionRequest): CompletionItem[] {
  const rankedSymbols = rankVisibleSymbols(
    analysis.getVisibleSymbolsAt(line, character),
    expectedTypeName
  );
  const items: CompletionItem[] = [];

  for (let index = 0; index < rankedSymbols.length; index += 1) {
    const entry = rankedSymbols[index]!;
    const symbol = entry.symbol;
    seenLabels.add(symbol.name);
    const documentation =
      symbol.node.kind === "Identifier"
        ? readDocumentationForSymbol(ast, symbol.node as Identifier, {
            ambientModuleDeclarations: options.ambientModuleDeclarations
          })
        : undefined;
    items.push({
      label: symbol.name,
      kind: symbolKindToCompletionKind(symbol),
      detail: symbolDetail(symbol),
      ...(documentation ? { documentation } : {}),
      sortText: `1-${entry.typeRelevance}-${String(entry.scopeDistance).padStart(4, "0")}-${String(index).padStart(4, "0")}-${symbol.name}`
    });
  }

  return items;
}
