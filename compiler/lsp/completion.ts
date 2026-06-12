/**
 * Completion orchestrator: createCompletionItemsForPosition tries each
 * completion strategy in priority order — annotation completion, member
 * access (memberCompletion.ts), literal-receiver extension members, named
 * call arguments (argumentCompletion.ts), ranked in-scope symbols,
 * auto-imports (importCompletion.ts), and the keyword fallback — over the
 * shared contracts in completionModel.ts.
 */
import type { CompletionItem } from "vscode-languageserver/node.js";
import type {
  AnnotationStatement,
  ClassMethodMember,
  ClassStatement,
  FunctionStatement,
  Identifier,
  InterfaceStatement,
  InterfaceMethodMember,
  NamespaceStatement,
  Program,
  VarStatement
} from "compiler/ast/ast";
import { declarationIndexForStatements } from "compiler/analysis/declarationIndex";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import { typeToString } from "compiler/analysis/types";
import { readDocumentationFromProgramDeclaration } from "./documentation";
import type { AutoImportSuggestion } from "./importFixes";
import { buildAutoImportCompletionItems, resolveAutoImportSuggestions } from "./importCompletion";
import { containsPosition, nodeRange } from "./ranges";
import {
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";
import { buildNamedArgumentCompletionItems, inferExpectedTypeForPosition } from "./argumentCompletion";
import { CompletionCommand, CompletionItemInsertTextFormat, CompletionItemKind, KEYWORD_COMPLETIONS, symbolDetail, symbolKindToCompletionKind, withCallSnippet } from "./completionModel";
import type { CompletionRequestOptions } from "./completionModel";
import { buildExtensionMemberCompletionItems, buildMemberAccessCompletions, inferLiteralTypeName, parseMemberAccessTarget } from "./memberCompletion";


function annotationPrefixAtPosition(
  text: string | undefined,
  line: number,
  character: number
): string | null {
  if (!text) {
    return null;
  }
  const lineText = text.split("\n")[line] ?? "";
  const uptoCursor = lineText.slice(0, Math.max(0, Math.min(character, lineText.length)));
  const match = /@([A-Za-z_][A-Za-z0-9_]*)?$/u.exec(uptoCursor);
  return match ? match[1] ?? "" : null;
}

function collectAvailableAnnotations(program: Program): AnnotationStatement[] {
  const byName = new Map<string, AnnotationStatement>();
  for (const statement of declarationIndexForStatements(getVexaScriptRuntimeProgram().body).annotations) {
    byName.set(statement.name.name, statement);
  }
  for (const statement of declarationIndexForStatements(getEcmaScriptRuntimeProgram().body).annotations) {
    byName.set(statement.name.name, statement);
  }
  for (const statement of declarationIndexForStatements(program.body).annotations) {
    byName.set(statement.name.name, statement);
  }
  return [...byName.values()].sort((left, right) => left.name.name.localeCompare(right.name.name));
}

function annotationCompletionItems(program: Program, prefix: string): CompletionItem[] {
  const normalizedPrefix = prefix.trim();
  const items: CompletionItem[] = [];
  for (const annotation of collectAvailableAnnotations(program)) {
    const label = annotation.name.name;
    if (normalizedPrefix.length > 0 && !label.startsWith(normalizedPrefix)) {
      continue;
    }
    items.push({
      label,
      kind: CompletionItemKind.Function,
      detail: "Annotation",
      ...(annotation.parameters.length > 0
        ? {
            insertText: `${label}($1)`,
            insertTextFormat: CompletionItemInsertTextFormat.Snippet,
            command: {
              title: "Trigger parameter hints",
              command: CompletionCommand.TriggerParameterHints,
            }
          }
        : {
            insertText: label
          }),
      sortText: `0-${label}`
    });
  }
  return items;
}

function declarationNameRangeContainsPosition(identifier: Identifier, line: number, character: number): boolean {
  const range = nodeRange(identifier);
  return !!range && containsPosition(range, { line, character });
}

function isTextualDeclarationNamePosition(
  text: string | undefined,
  line: number,
  character: number
): boolean {
  if (!text) {
    return false;
  }

  const lineText = text.split("\n")[line] ?? "";
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);

  return [
    /^\s*fun\s+[A-Za-z_][A-Za-z0-9_]*$/u,
    /^\s*(?:let|val|var|const)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
    /^\s*(?:class|interface|namespace)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
  ].some((pattern) => pattern.test(uptoCursor));
}

function isDeclarationNamePosition(ast: Program, line: number, character: number): boolean {
  const matchesBinding = (identifier: Identifier): boolean =>
    declarationNameRangeContainsPosition(identifier, line, character);

  for (const statement of ast.body) {
    if (statement.kind === "FunctionStatement") {
      const fn = statement as FunctionStatement;
      if (matchesBinding(fn.name)) {
        return true;
      }
      for (const parameter of fn.parameters) {
        for (const binding of bindingIdentifiers(parameter.name)) {
          if (matchesBinding(binding)) {
            return true;
          }
        }
      }
      continue;
    }

    if (statement.kind === "VarStatement") {
      const variable = statement as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      if (bindings.some(matchesBinding)) {
        return true;
      }
      continue;
    }

    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      if (matchesBinding(classStatement.name)) {
        return true;
      }
      for (const parameter of classStatement.primaryConstructorParameters ?? []) {
        for (const binding of bindingIdentifiers(parameter.name)) {
          if (matchesBinding(binding)) {
            return true;
          }
        }
      }
      for (const member of classStatement.members) {
        if (matchesBinding(member.name)) {
          return true;
        }
        if (member.kind === "ClassMethodMember") {
          const method = member as ClassMethodMember;
          for (const parameter of method.parameters) {
            for (const binding of bindingIdentifiers(parameter.name)) {
              if (matchesBinding(binding)) {
                return true;
              }
            }
          }
        }
      }
      continue;
    }

    if (statement.kind === "InterfaceStatement") {
      const interfaceStatement = statement as InterfaceStatement;
      if (matchesBinding(interfaceStatement.name)) {
        return true;
      }
      for (const member of interfaceStatement.members) {
        if (matchesBinding(member.name)) {
          return true;
        }
        if (member.kind === "InterfaceMethodMember") {
          const method = member as InterfaceMethodMember;
          for (const parameter of method.parameters) {
            for (const binding of bindingIdentifiers(parameter.name)) {
              if (matchesBinding(binding)) {
                return true;
              }
            }
          }
        }
      }
      continue;
    }

    if (statement.kind === "NamespaceStatement") {
      const namespaceStatement = statement as NamespaceStatement;
      if ((namespaceStatement.names ?? []).some((name) => matchesBinding(name))) {
        return true;
      }
    }
  }

  return false;
}

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

  const visibleSymbols = resolvedAnalysis.getVisibleSymbolsAt(line, character);
  const expectedTypeName = await inferExpectedTypeForPosition(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );

  const rankedSymbols = visibleSymbols
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

  const items: CompletionItem[] = [];
  const seenLabels = new Set<string>();
  const suppressExistingSymbolCompletions =
    isDeclarationNamePosition(ast, line, character) ||
    isTextualDeclarationNamePosition(options.text, line, character);

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
    for (let index = 0; index < rankedSymbols.length; index += 1) {
      const entry = rankedSymbols[index]!;
      const symbol = entry.symbol;
      seenLabels.add(symbol.name);
      const documentation =
        symbol.node.kind === "Identifier"
          ? readDocumentationFromProgramDeclaration(ast, symbol.node as Identifier)
          : undefined;
      items.push({
        label: symbol.name,
        kind: symbolKindToCompletionKind(symbol),
        detail: symbolDetail(symbol),
        ...(documentation ? { documentation } : {}),
        sortText: `1-${entry.typeRelevance}-${String(entry.scopeDistance).padStart(4, "0")}-${String(index).padStart(4, "0")}-${symbol.name}`
      });
    }
  }

  if (!suppressExistingSymbolCompletions) {
    items.push(...buildAutoImportCompletionItems(resolvedAutoImportSuggestions, seenLabels));
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
