/**
 * Completion orchestrator: createCompletionItemsForPosition tries each
 * completion strategy in priority order — annotation completion, member
 * access (memberCompletion.ts), JSX block snippets, literal-receiver extension members, named
 * call arguments (argumentCompletion.ts), ranked in-scope symbols,
 * auto-imports (importCompletion.ts), and the keyword fallback — over the
 * shared contracts in completionModel.ts.
 */
import type { CompletionItem } from "vscode-languageserver/node.js";
import { AssignmentExpression, BinaryExpression, Identifier, JsxAttribute, MemberExpression, type Program } from "compiler/ast/ast";
import { Analysis } from "compiler/analysis/Analysis";
import { LiteralType, NamedType, UnionType, isSameType, type AnalysisType, typeToString } from "compiler/analysis/types";
import { walkAst } from "compiler/ast/traversal";
import type { AutoImportSuggestion } from "./importFixes";
import {
  buildAutoImportCompletionItems,
  identifierPrefixAtPosition,
  resolveAutoImportSuggestions
} from "./importCompletion";
import { buildNamedArgumentCompletionItems, inferExpectedTypeForPosition } from "./argumentCompletion";
import {
  CompletionItemKind,
  CompletionItemInsertTextFormat,
  KEYWORD_COMPLETIONS,
  matchesCompletionPrefix,
  symbolDetail,
  symbolKindToCompletionKind,
  withCallSnippet
} from "./completionModel";
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
  jsxBlockCompletionItemsAtPosition,
  shouldSuppressExistingSymbolCompletions
} from "./completionContext";
import { containsPosition, nodeRange, rangeSize } from "./ranges";

function literalValuesFromType(type: AnalysisType, analysis: Analysis): LiteralType[] {
  if (type instanceof LiteralType) return [type];
  if (type instanceof UnionType) return type.types.flatMap((member) => literalValuesFromType(member, analysis));
  if (type instanceof NamedType) {
    const resolved = analysis.getTopLevelSymbolType(type.name);
    if (resolved && !isSameType(resolved, type)) return literalValuesFromType(resolved, analysis);
  }
  return [];
}

function buildLiteralCompletionItems(
  type: AnalysisType,
  analysis: Analysis,
  line: number,
  character: number,
  text?: string
): CompletionItem[] {
  const lineText = text?.split("\n")[line] ?? "";
  const beforeCursor = lineText.slice(0, character);
  const afterCursor = lineText.slice(character);
  const openQuote = /(["'])[^"']*$/u.exec(beforeCursor)?.[1];
  const insideString = Boolean(openQuote && afterCursor.includes(openQuote));
  const seen = new Set<string>();
  return literalValuesFromType(type, analysis).flatMap((literal) => {
    const label = String(literal.value);
    if (seen.has(label)) return [];
    seen.add(label);
    const insertText = literal.base === "string" && !insideString
      ? JSON.stringify(literal.value)
      : label;
    return [{
      label,
      kind: CompletionItemKind.Value,
      detail: `Allowed value: ${typeToString(literal)}`,
      insertText,
      sortText: `0-literal-${label}`
    }];
  });
}

function buildAssignmentLiteralCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  text?: string
): CompletionItem[] {
  const position = { line, character };
  let best: AssignmentExpression | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  walkAst(ast, (node) => {
    if (!(node instanceof AssignmentExpression) || node.operator !== "=") return;
    const range = nodeRange(node);
    if (!range || !containsPosition(range, position)) return;
    const size = rangeSize(range);
    if (size <= bestSize) {
      best = node;
      bestSize = size;
    }
  });
  if (!best) return [];

  const target = (best as AssignmentExpression).left;
  const targetName = target instanceof Identifier
    ? target.name
    : target instanceof MemberExpression && target.computed !== true && target.property instanceof Identifier
      ? target.property.name
      : null;
  if (!targetName) return [];
  const targetType = analysis.getVisibleSymbolsAt(line, character)
    .find((symbol) => symbol.name === targetName)?.type;
  if (!targetType) return [];

  return buildLiteralCompletionItems(targetType, analysis, line, character, text);
}

function buildComparisonLiteralCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  text?: string
): CompletionItem[] {
  const position = { line, character };
  let best: BinaryExpression | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  walkAst(ast, (node) => {
    if (!(node instanceof BinaryExpression) || !["==", "!=", "===", "!=="].includes(node.operator)) return;
    const rightRange = nodeRange(node.right);
    if (!rightRange || !containsPosition(rightRange, position)) return;
    const size = rangeSize(rightRange);
    if (size <= bestSize) {
      best = node;
      bestSize = size;
    }
  });
  if (!best) return [];
  const targetType = analysis.getExpressionType((best as BinaryExpression).left);
  if (!targetType) return [];
  return buildLiteralCompletionItems(targetType, analysis, line, character, text);
}

function jsxTagPrefixAtPosition(text: string | undefined, line: number, character: number): string | null {
  const linePrefix = text?.split("\n")[line]?.slice(0, character);
  if (linePrefix === undefined) {
    return null;
  }
  const match = /<([A-Za-z_][A-Za-z0-9_.-]*)?$/u.exec(linePrefix);
  return match ? (match[1] ?? "") : null;
}

function jsxClosingTagPrefixAtPosition(text: string | undefined, line: number, character: number): string | null {
  const linePrefix = text?.split("\n")[line]?.slice(0, character);
  if (linePrefix === undefined) {
    return null;
  }
  const match = /<\/([A-Za-z_][A-Za-z0-9_.:-]*)?$/u.exec(linePrefix);
  return match ? (match[1] ?? "") : null;
}

/** Makes an incomplete opening JSX tag parseable so its declaration context can be reused. */
export function recoverSourceForJsxTagCompletion(text: string): string | null {
  const lines = text.split("\n");
  let recovered = false;
  const result = lines.map((line) => {
    const match = /<([A-Za-z_][A-Za-z0-9_.-]*)?\s*$/u.exec(line);
    if (!match) {
      return line;
    }
    recovered = true;
    const tag = match[1] ?? "div";
    return `${line.slice(0, match.index)}<${tag} />`;
  });
  return recovered ? result.join("\n") : null;
}

function buildJsxTagCompletionItems(analysis: Analysis, line: number, character: number, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const textEditRange = {
    start: { line, character: character - prefix.length },
    end: { line, character }
  };
  for (const [tagName, symbol] of analysis.getJsxIntrinsicElementSymbols()) {
    if (!matchesCompletionPrefix(tagName, prefix) || seen.has(tagName)) {
      continue;
    }
    seen.add(tagName);
    items.push({
      label: tagName,
      kind: CompletionItemKind.Value,
      detail: `Intrinsic JSX element: ${symbol.valueType}`,
      textEdit: { range: textEditRange, newText: tagName },
      sortText: `0-${tagName}`
    });
  }
  for (const symbol of analysis.getVisibleSymbolsAt(line, character)) {
    if (
      symbolKindToCompletionKind(symbol) !== CompletionItemKind.Function ||
      !/^[A-Z]/u.test(symbol.name) ||
      !matchesCompletionPrefix(symbol.name, prefix) ||
      seen.has(symbol.name)
    ) {
      continue;
    }
    seen.add(symbol.name);
    items.push({
      label: symbol.name,
      kind: CompletionItemKind.Function,
      detail: symbolDetail(symbol),
      textEdit: { range: textEditRange, newText: symbol.name },
      sortText: `1-${symbol.name}`
    });
  }
  return items;
}

function findTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let offset = start + 1; offset < text.length; offset += 1) {
    const current = text[offset]!;
    if (quote) {
      if (current === "\\") offset += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") quote = current;
    else if (current === "{") braceDepth += 1;
    else if (current === "}" && braceDepth > 0) braceDepth -= 1;
    else if (current === ">" && braceDepth === 0) return offset;
  }
  return -1;
}

function pendingJsxTagNames(text: string, cursorOffset: number): string[] {
  const stack: string[] = [];
  for (let offset = 0; offset < cursorOffset; offset += 1) {
    if (text[offset] !== "<") continue;
    const end = findTagEnd(text, offset);
    if (end < 0 || end >= cursorOffset) break;
    const tagText = text.slice(offset, end + 1);
    const closing = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/u.exec(tagText);
    if (closing) {
      const index = stack.lastIndexOf(closing[1]!);
      if (index >= 0) stack.splice(index, 1);
      offset = end;
      continue;
    }
    const opening = /^<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s|\/?>)/u.exec(tagText);
    if (opening && !/\/\s*>$/u.test(tagText)) {
      stack.push(opening[1]!);
    }
    offset = end;
  }
  return stack;
}

function buildJsxClosingTagCompletionItems(
  text: string,
  line: number,
  character: number,
  prefix: string
): CompletionItem[] {
  const names = pendingJsxTagNames(text, offsetAtPosition(text, line, character));
  const range = {
    start: { line, character: character - prefix.length },
    end: { line, character }
  };
  const seen = new Set<string>();
  return names.reverse().flatMap((name) => {
    if (seen.has(name) || !matchesCompletionPrefix(name, prefix)) return [];
    seen.add(name);
    return [{
      label: name,
      kind: CompletionItemKind.Value,
      detail: "Closing JSX element",
      textEdit: { range, newText: `${name}>` },
      sortText: `0-${name}`
    }];
  });
}

interface JsxAttributeCompletionContext {
  prefix: string;
  editStartCharacter: number;
}

function offsetAtPosition(text: string, line: number, character: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let currentLine = 0; currentLine < line; currentLine += 1) {
    offset += (lines[currentLine]?.length ?? 0) + 1;
  }
  return offset + Math.max(0, Math.min(character, lines[line]?.length ?? 0));
}

function followsCommaAtPosition(text: string | undefined, line: number, character: number): boolean {
  if (!text) {
    return false;
  }
  let offset = offsetAtPosition(text, line, character) - 1;
  while (offset >= 0 && /\s/u.test(text[offset]!)) {
    offset -= 1;
  }
  return text[offset] === ",";
}

function jsxAttributeCompletionContextAtPosition(
  text: string | undefined,
  line: number,
  character: number
): JsxAttributeCompletionContext | null {
  if (!text) {
    return null;
  }

  const cursorOffset = offsetAtPosition(text, line, character);

  let openingStart = -1;
  let braceDepth = 0;
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let offset = 0; offset < cursorOffset; offset += 1) {
    const current = text[offset]!;
    if (openingStart < 0) {
      if (current === "<" && /[A-Za-z_]/u.test(text[offset + 1] ?? "")) {
        openingStart = offset;
        braceDepth = 0;
        quote = null;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
    } else if (current === "{") {
      braceDepth += 1;
    } else if (current === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (current === ">" && braceDepth === 0) {
      openingStart = -1;
    } else if (current === "<" && braceDepth === 0 && /[A-Za-z_]/u.test(text[offset + 1] ?? "")) {
      openingStart = offset;
    }
  }
  if (openingStart < 0 || braceDepth !== 0 || quote !== null) {
    return null;
  }

  const openingText = text.slice(openingStart + 1, cursorOffset);
  const tag = /^([A-Za-z_][A-Za-z0-9_.-]*)/u.exec(openingText);
  if (!tag || !/^\s/u.test(openingText.slice(tag[0].length))) {
    return null;
  }
  const attributeText = openingText.slice(tag[0].length);
  const prefixMatch = /(?:^|\s)([A-Za-z_][A-Za-z0-9_:-]*)?$/u.exec(attributeText);
  if (!prefixMatch) {
    return null;
  }
  const prefix = prefixMatch[1] ?? "";
  return {
    prefix,
    editStartCharacter: character - prefix.length
  };
}

export function isJsxAttributeCompletionPosition(
  text: string | undefined,
  line: number,
  character: number
): boolean {
  return jsxAttributeCompletionContextAtPosition(text, line, character) !== null;
}

export function isContextualSpaceCompletionPosition(
  text: string | undefined,
  line: number,
  character: number
): boolean {
  return isJsxAttributeCompletionPosition(text, line, character)
    || followsCommaAtPosition(text, line, character);
}

function buildJsxAttributeCompletionItems(
  analysis: Analysis,
  line: number,
  character: number,
  context: JsxAttributeCompletionContext
): CompletionItem[] | null {
  const resolved = analysis.getJsxPropsAt(line, character);
  if (!resolved) {
    return null;
  }
  const provided = new Set(
    resolved.element.attributes
      .filter((attribute): attribute is JsxAttribute => attribute instanceof JsxAttribute)
      .map((attribute) => attribute.name)
  );
  const items: CompletionItem[] = [];
  for (const [name, type] of resolved.props) {
    if (provided.has(name) || !matchesCompletionPrefix(name, context.prefix)) {
      continue;
    }
    items.push({
      label: name,
      kind: CompletionItemKind.Property,
      detail: `JSX attribute: ${typeToString(type)}`,
      insertTextFormat: CompletionItemInsertTextFormat.Snippet,
      textEdit: {
        range: {
          start: { line, character: context.editStartCharacter },
          end: { line, character }
        },
        newText: `${name}={$1}`
      },
      sortText: `0-jsx-attribute-${name}`
    });
  }
  return items;
}

export async function createCompletionItemsForPosition(
  ast: Program | null,
  line: number,
  character: number,
  analysis?: Analysis | null,
  autoImportSuggestions: AutoImportSuggestion[] = [],
  options: CompletionRequestOptions = {}
): Promise<CompletionItem[]> {
  const jsxAttributeContext = jsxAttributeCompletionContextAtPosition(options.text, line, character);
  const continuesCommaCompletion = options.triggerCharacter === " "
    && followsCommaAtPosition(options.text, line, character);
  if (options.triggerCharacter === " " && !jsxAttributeContext && !continuesCommaCompletion) {
    return [];
  }
  const jsxBlockItems = jsxBlockCompletionItemsAtPosition(options.text, line, character);
  if (jsxBlockItems !== null) {
    return jsxBlockItems;
  }
  const jsxClosingTagPrefix = jsxClosingTagPrefixAtPosition(options.text, line, character);
  if (jsxClosingTagPrefix !== null && options.text) {
    return buildJsxClosingTagCompletionItems(options.text, line, character, jsxClosingTagPrefix);
  }
  if (!ast) {
    const jsxTagPrefix = jsxTagPrefixAtPosition(options.text, line, character);
    if (jsxTagPrefix !== null && options.text && options.recoverAnalysisSession) {
      const recoveredSource = recoverSourceForJsxTagCompletion(options.text);
      if (recoveredSource) {
        const recovered = await options.recoverAnalysisSession(recoveredSource);
        if (recovered.analysis) {
          return buildJsxTagCompletionItems(recovered.analysis, line, character, jsxTagPrefix);
        }
      }
    }
    return createKeywordOnlyCompletionItems();
  }
  const resolvedAnalysis = analysis ?? new Analysis(ast);
  const annotationPrefix = annotationPrefixAtPosition(options.text, line, character);
  if (annotationPrefix !== null) {
    return annotationCompletionItems(ast, annotationPrefix);
  }
  const jsxTagPrefix = jsxTagPrefixAtPosition(options.text, line, character);
  if (jsxTagPrefix !== null) {
    return buildJsxTagCompletionItems(resolvedAnalysis, line, character, jsxTagPrefix);
  }
  if (jsxAttributeContext) {
    const jsxAttributeItems = buildJsxAttributeCompletionItems(
      resolvedAnalysis,
      line,
      character,
      jsxAttributeContext
    );
    if (jsxAttributeItems !== null) {
      return jsxAttributeItems;
    }
  }
  const memberCompletions = await buildMemberAccessCompletions(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (memberCompletions !== null && memberCompletions.length > 0) {
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
  if (memberCompletions !== null) {
    return [];
  }
  const objectLiteralCompletions = await buildContextualObjectLiteralCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (objectLiteralCompletions !== null) {
    return objectLiteralCompletions;
  }

  const objectLiteralValueCompletions = await buildContextualObjectLiteralValueCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (objectLiteralValueCompletions !== null) {
    return objectLiteralValueCompletions;
  }

  if (options.triggerCharacter === "," || continuesCommaCompletion) {
    return [];
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
  for (const item of buildAssignmentLiteralCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options.text
  )) {
    seenLabels.add(item.label);
    items.push(item);
  }
  for (const item of buildComparisonLiteralCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options.text
  )) {
    if (seenLabels.has(item.label)) continue;
    seenLabels.add(item.label);
    items.push(item);
  }
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
        typedPrefix: identifierPrefixAtPosition(options.text, line, character),
        expectedTypeName,
        options,
        seenLabels
      })
    );
  }

  if (!suppressExistingSymbolCompletions) {
    const resolvedAutoImportSuggestions = await resolveAutoImportSuggestions({
      ast,
      analysis: resolvedAnalysis,
      line,
      character,
      provided: autoImportSuggestions,
      options
    });
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
