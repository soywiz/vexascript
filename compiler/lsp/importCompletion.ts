/**
 * Auto-import completion strategy: resolves importable top-level symbols
 * matching the identifier prefix at the cursor (when the caller did not
 * already provide suggestions) and renders them as completion items carrying
 * the additional text edit that inserts the import statement. Orchestrated by
 * createCompletionItemsForPosition in completion.ts.
 */
import type { CompletionItem } from "vscode-languageserver/node.js";
import type { Program } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import { buildAutoImportSuggestions, type AutoImportSuggestion } from "./importFixes";
import { CompletionItemKind, type CompletionRequestOptions } from "./completionModel";

export function identifierPrefixAtPosition(
  text: string | undefined,
  line: number,
  character: number
): string {
  if (!text) {
    return "";
  }
  const lineText = text.split("\n")[line] ?? "";
  const uptoCursor = lineText.slice(0, Math.max(0, Math.min(character, lineText.length)));
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(uptoCursor);
  return match?.[0] ?? "";
}

/**
 * Returns the caller-provided suggestions when present; otherwise resolves
 * them from the workspace exports visible to the document, excluding symbols
 * already in scope at the cursor.
 */
export async function resolveAutoImportSuggestions(params: {
  ast: Program;
  analysis: Analysis;
  line: number;
  character: number;
  provided: AutoImportSuggestion[];
  options: CompletionRequestOptions;
}): Promise<AutoImportSuggestion[]> {
  const { ast, analysis, line, character, provided, options } = params;
  if (provided.length > 0) {
    return provided;
  }
  if (!options.uri || !(options.sourceRoots?.length || options.getExportedSymbols)) {
    return [];
  }
  return buildAutoImportSuggestions({
    uri: options.uri,
    ast,
    sourceRoots: options.sourceRoots ?? [],
    ...(options.getExportedSymbols ? { getExportedSymbols: options.getExportedSymbols } : {}),
    prefix: identifierPrefixAtPosition(options.text, line, character),
    excludeSymbols: new Set(analysis.getVisibleSymbolsAt(line, character).map((symbol) => symbol.name))
  });
}

export function buildAutoImportCompletionItems(
  suggestions: AutoImportSuggestion[],
  seenLabels: Set<string>
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seenSuggestions = new Set<string>();
  for (const suggestion of suggestions) {
    const suggestionKey = `${suggestion.symbol.name}::${suggestion.importPath}`;
    if (seenSuggestions.has(suggestionKey)) {
      continue;
    }
    seenSuggestions.add(suggestionKey);
    if (seenLabels.has(suggestion.symbol.name)) {
      continue;
    }

    let kind: CompletionItemKind = CompletionItemKind.Variable;
    if (suggestion.symbol.kind === "class") {
      kind = CompletionItemKind.Class;
    } else if (suggestion.symbol.kind === "interface" || suggestion.symbol.kind === "type") {
      kind = CompletionItemKind.Interface;
    } else if (suggestion.symbol.kind === "function") {
      kind = CompletionItemKind.Function;
    }

    items.push({
      label: suggestion.symbol.name,
      kind,
      detail: `Auto import from ${suggestion.importPath}`,
      sortText: `8-${suggestion.symbol.name}`,
      additionalTextEdits: [
        {
          range: suggestion.range,
          newText: `import { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
        }
      ]
    });
  }
  return items;
}
