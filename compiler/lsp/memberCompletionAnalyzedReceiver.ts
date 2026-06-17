import type { Analysis } from "compiler/analysis/Analysis";
import type { Program } from "compiler/ast/ast";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import type { CompletionRequestOptions } from "./completionModel";
import { findMemberAccessDot } from "./memberCompletionParsing";
import { receiverTypeNameEndingAt } from "./memberCompletionTypeNames";
import type { CompletionItem } from "vscode-languageserver/node.js";

export interface AnalyzedReceiverCompletionResult {
  foundDot: boolean;
  items: CompletionItem[];
}

export async function buildAnalyzedReceiverMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache,
  buildMemberCompletionItemsForType: (
    ast: Program,
    analysis: Analysis,
    className: string,
    prefix: string,
    line: number,
    dotCharacter: number,
    prefixEndCharacter: number,
    options: CompletionRequestOptions,
    resolverOptions: ClassResolverOptions,
    resolverCache: ClassResolverCache
  ) => Promise<CompletionItem[]>
): Promise<AnalyzedReceiverCompletionResult> {
  const dot = findMemberAccessDot(options.text, line, character);
  if (!dot) {
    return {
      foundDot: false,
      items: []
    };
  }

  const receiverTypeName = receiverTypeNameEndingAt(analysis, line, dot.receiverEndCharacter);
  if (!receiverTypeName || receiverTypeName === "unknown") {
    return {
      foundDot: true,
      items: []
    };
  }

  return {
    foundDot: true,
    items: await buildMemberCompletionItemsForType(
      ast,
      analysis,
      receiverTypeName,
      dot.prefix,
      line,
      dot.dotCharacter,
      character,
      options,
      resolverOptions,
      resolverCache
    )
  };
}
