/**
 * Completion orchestrator: createCompletionItemsForPosition tries each
 * completion strategy in priority order — annotation completion, member
 * access (memberCompletion.ts), literal-receiver extension members, named
 * call arguments (argumentCompletion.ts), ranked in-scope symbols,
 * auto-imports (importCompletion.ts), and the keyword fallback — over the
 * shared contracts in completionModel.ts.
 */
import type { CompletionItem } from "vscode-languageserver/node.js";
import type { Program } from "compiler/ast/ast";
import { Analysis } from "compiler/analysis/Analysis";
import type { AutoImportSuggestion } from "./importFixes";
import { buildAutoImportCompletionItems, resolveAutoImportSuggestions } from "./importCompletion";
import { buildNamedArgumentCompletionItems, inferExpectedTypeForPosition } from "./argumentCompletion";
import { KEYWORD_COMPLETIONS, withCallSnippet } from "./completionModel";
import type { CompletionRequestOptions } from "./completionModel";
import { buildExtensionMemberCompletionItems, buildMemberAccessCompletions } from "./memberCompletion";
import { parseMemberAccessTarget } from "./memberCompletionParsing";
import { inferLiteralTypeName } from "./memberCompletionTypeNames";
import {
  buildContextualObjectLiteralCompletionItems,
  buildContextualObjectLiteralValueCompletionItems
} from "./objectLiteralCompletion";
import { buildVisibleSymbolCompletionItems } from "./symbolCompletion";
import {
  annotationCompletionItems,
  annotationPrefixAtPosition,
  shouldSuppressExistingSymbolCompletions
} from "./completionContext";

export async function createCompletionItemsForPosition(
  ast: Program,
  line: number,
  character: number,
  analysis?: Analysis | null,
  autoImportSuggestions: AutoImportSuggestion[] = [],
  options: CompletionRequestOptions = {}
): Promise<CompletionItem[]> {
  const resolvedAnalysis = analysis ?? new Analysis(ast);
  const annotationPrefix = annotationPrefixAtPosition(options.text, line, character);
  if (annotationPrefix !== null) {
    return annotationCompletionItems(ast, annotationPrefix);
  }
  const resolvedAutoImportSuggestions = await resolveAutoImportSuggestions({
    ast,
    analysis: resolvedAnalysis,
    line,
    character,
    provided: autoImportSuggestions,
    options
  });
  const memberCompletions = await buildMemberAccessCompletions(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (memberCompletions && memberCompletions.length > 0) {
    return memberCompletions.map(withCallSnippet);
  }
  const memberTarget = parseMemberAccessTarget(options.text, line, character);
  const literalReceiverType = memberTarget ? inferLiteralTypeName(memberTarget.objectPath) : null;
  if (memberTarget && literalReceiverType) {
    const literalExtensionCompletions = await buildExtensionMemberCompletionItems(
      ast,
      literalReceiverType,
      memberTarget.prefix,
      options,
      resolvedAnalysis
    );
    if (literalExtensionCompletions.length > 0) {
      return literalExtensionCompletions.map(withCallSnippet);
    }
  }
  const objectLiteralCompletions = await buildContextualObjectLiteralCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (objectLiteralCompletions.length > 0) {
    return objectLiteralCompletions;
  }

  const objectLiteralValueCompletions = await buildContextualObjectLiteralValueCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (objectLiteralValueCompletions.length > 0) {
    return objectLiteralValueCompletions;
  }

  const expectedTypeName = await inferExpectedTypeForPosition(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );

  const items: CompletionItem[] = [];
  const seenLabels = new Set<string>();
  const suppressExistingSymbolCompletions = shouldSuppressExistingSymbolCompletions(
    ast,
    line,
    character,
    options.text
  );

  // Named-argument suggestions (`url:`) are offered alongside the in-scope
  // symbols whenever the cursor is inside a call's argument list, ranked above
  // ordinary symbols so they surface first.
  const namedArgumentItems = await buildNamedArgumentCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  for (const item of namedArgumentItems) {
    if (seenLabels.has(item.label)) {
      continue;
    }
    seenLabels.add(item.label);
    items.push(item);
  }

  if (!suppressExistingSymbolCompletions) {
    items.push(
      ...buildVisibleSymbolCompletionItems({
        ast,
        analysis: resolvedAnalysis,
        line,
        character,
        expectedTypeName,
        options,
        seenLabels
      })
    );
  }

  if (!suppressExistingSymbolCompletions) {
    items.push(...buildAutoImportCompletionItems(ast, resolvedAutoImportSuggestions, seenLabels));
  }

  for (let index = 0; index < KEYWORD_COMPLETIONS.length; index += 1) {
    const item = KEYWORD_COMPLETIONS[index]!;
    if (seenLabels.has(item.label)) {
      continue;
    }
    seenLabels.add(item.label);
    items.push({
      ...item,
      sortText: `9-${String(index).padStart(4, "0")}-${item.label}`
    });
  }

  return items.map(withCallSnippet);
}

export function createKeywordOnlyCompletionItems(): CompletionItem[] {
  return [...KEYWORD_COMPLETIONS];
}
