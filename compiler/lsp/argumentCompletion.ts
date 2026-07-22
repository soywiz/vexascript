import { CallExpression, NewExpression } from "compiler/ast/ast";
import type { Expr, Program } from "compiler/ast/ast";
/**
 * Call-argument completion strategy: argument-position detection, named
 * argument (`name:`) suggestions, and expected-type inference used to rank
 * in-scope symbols. Orchestrated by createCompletionItemsForPosition in
 * completion.ts.
 */
import { resolveCallableSignature, resolveConstructorSignature } from "./classResolver";
import { CompletionItemKind, classResolverOptionsFromCompletionOptions } from "./completionModel";
import type { CompletionRequestOptions } from "./completionModel";
import { findBestMatchAtPosition } from "./nodeSearch";
import { comparePosition, containsPosition, nodeRange, rangeSize } from "./ranges";
import { Analysis } from "compiler/analysis/Analysis";

import { walkAst } from "compiler/ast/traversal";
import type { CompletionItem } from "vscode-languageserver/node.js";

export interface ArgumentCompletionContext {
  callee: Expr;
  argumentIndex: number;
  kind: "call" | "new";
}

export function findArgumentCompletionContext(
  ast: Program,
  line: number,
  character: number
): ArgumentCompletionContext | null {
  return findBestMatchAtPosition(ast, { line, character }, (node) => {
    if (!(node instanceof CallExpression) && !(node instanceof NewExpression)) {
      return null;
    }
    const callLike = node as CallExpression | NewExpression;
    const kind = node instanceof CallExpression ? ("call" as const) : ("new" as const);
    return (callLike.args ?? []).flatMap((argument, argumentIndex) => {
      const argumentRange = nodeRange(argument);
      return argumentRange
        ? [{ range: argumentRange, build: () => ({ callee: callLike.callee, argumentIndex, kind }) }]
        : [];
    });
  });
}

export interface NamedArgumentCallContext {
  callee: Expr;
  isNew: boolean;
}

/**
 * Finds the innermost call or `new` expression whose argument list encloses the
 * cursor, so named-argument completions can offer the callee's parameter names.
 * Unlike {@link findArgumentCompletionContext}, it does not require an existing
 * argument at the cursor, so it also works for empty (`fetch(|)`) and partially
 * typed (`fetch(ur|)`) argument lists. The cursor must sit past the callee so we
 * are inside the parentheses rather than on the callee itself.
 */
export function findNamedArgumentCallContext(
  ast: Program,
  line: number,
  character: number
): NamedArgumentCallContext | null {
  const position = { line, character };
  let best: NamedArgumentCallContext | null = null;
  let bestSize: number | null = null;

  walkAst(ast, (node) => {
    if (!(node instanceof CallExpression) && !(node instanceof NewExpression)) {
      return;
    }
    const callLike = node as CallExpression | NewExpression;
    const range = nodeRange(callLike);
    if (!range || !containsPosition(range, position)) {
      return;
    }
    const calleeRange = nodeRange(callLike.callee);
    if (calleeRange && comparePosition(position, calleeRange.end) <= 0) {
      return;
    }
    const size = rangeSize(range);
    if (bestSize === null || size <= bestSize) {
      best = { callee: callLike.callee, isNew: node instanceof NewExpression };
      bestSize = size;
    }
  });

  return best;
}

export async function buildNamedArgumentCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[]> {
  const context = findNamedArgumentCallContext(ast, line, character);
  if (!context) {
    return [];
  }
  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const signature = context.isNew
    ? await resolveConstructorSignature(context.callee, analysis, ast, resolverOptions)
    : await resolveCallableSignature(context.callee, analysis, ast, resolverOptions);
  const parameters = signature?.parameters ?? [];
  const items: CompletionItem[] = [];
  for (const parameter of parameters) {
    if (parameter.rest) {
      continue;
    }
    items.push({
      label: `${parameter.name}:`,
      kind: CompletionItemKind.Field,
      detail: `Named argument: ${parameter.typeName}`,
      filterText: parameter.name,
      insertText: `${parameter.name}: `,
      sortText: `0-${parameter.name}`
    });
  }
  return items;
}

export async function inferExpectedTypeForPosition(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<string | null> {
  const context = findArgumentCompletionContext(ast, line, character);
  if (!context) {
    return null;
  }

  if (context.kind === "call") {
    const signature = await resolveCallableSignature(
      context.callee,
      analysis,
      ast,
      classResolverOptionsFromCompletionOptions(options)
    );
    return signature?.parameters[context.argumentIndex]?.typeName ?? null;
  }

  const constructorSignature = await resolveConstructorSignature(
    context.callee,
    analysis,
    ast,
    classResolverOptionsFromCompletionOptions(options)
  );
  return constructorSignature?.parameters[context.argumentIndex]?.typeName ?? null;
}
