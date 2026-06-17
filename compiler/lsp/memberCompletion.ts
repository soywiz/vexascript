/**
 * Member-access completion strategy: receiver detection and receiver-type
 * recovery around the cursor, cross-file class/interface/enum/type-alias
 * member item builders, extension-member completion, and namespace member
 * completion. Orchestrated by createCompletionItemsForPosition in
 * completion.ts.
 */
import { createClassResolverCache, resolveClassStatementAcrossFiles } from "./classResolver";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import { classResolverOptionsFromCompletionOptions } from "./completionModel";
import type { CompletionRequestOptions } from "./completionModel";
import { Analysis } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import type { Program } from "compiler/ast/ast";
import type { CompletionItem } from "vscode-languageserver/node.js";
export {
  buildExtensionMemberCompletionItems,
  collectAvailableExtensionMembers,
  resolveExtensionMemberTypeName
} from "./memberCompletionExtensionMembers";
export {
  buildClassMemberCompletionItems,
  buildEnumMemberCompletionItems,
  buildInterfaceMemberCompletionItems,
  memberSortGroup,
  operatorSymbolFromMemberName
} from "./memberCompletionItemBuilders";
export {
  buildRecoveredMemberAccessCompletions,
  collectAmbientInterfaceCompletionMembers,
  recoverSourceForMemberAccessCompletion
} from "./memberCompletionRecovery";
export {
  buildNonClassMemberCompletionItems,
  resolveInterfaceCompletionMembers
} from "./memberCompletionTypeMembers";
import { parseMemberAccessTarget } from "./memberCompletionParsing";
import { buildClassMemberCompletionItems } from "./memberCompletionItemBuilders";
import { buildRecoveredMemberAccessCompletions } from "./memberCompletionRecovery";
import { buildNonClassMemberCompletionItems } from "./memberCompletionTypeMembers";
import {
  arrayTypeNameToArrayAlias,
  boxedCompletionTypeName
} from "./memberCompletionTypeNames";
import { buildExtensionMemberCompletionItems, resolveExtensionMemberTypeName } from "./memberCompletionExtensionMembers";
import { buildTargetPathMemberAccessCompletions } from "./memberCompletionTargetPaths";
import { buildAnalyzedReceiverMemberAccessCompletions } from "./memberCompletionAnalyzedReceiver";

export async function buildMemberCompletionItemsForType(
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
): Promise<CompletionItem[]> {
  // Array types (`T[]`) resolve their members from the declared `class Array<T>`.
  const narrowedClassName = boxedCompletionTypeName(className);
  const resolvedClassName = arrayTypeNameToArrayAlias(narrowedClassName) ?? narrowedClassName;
  const classStatement = (await resolveClassStatementAcrossFiles(
    ast,
    baseTypeName(resolvedClassName),
    resolverOptions,
    resolverCache
  ))?.classStatement;
  return [
    ...await buildExtensionMemberCompletionItems(ast, className, prefix, options, analysis),
    ...(classStatement
        ? await buildClassMemberCompletionItems(
        classStatement,
        resolvedClassName,
        prefix,
        analysis,
        {
          line,
          dotCharacter,
            prefixEndCharacter
          },
          {
            ast,
            options: resolverOptions,
            cache: resolverCache
          }
        )
      : await buildNonClassMemberCompletionItems(
        ast,
        resolvedClassName,
        prefix,
        options,
        resolverOptions,
        resolverCache
      ))
  ];
}

export async function buildMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions,
  allowRecovery = true
): Promise<CompletionItem[] | null> {
  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const resolverCache = createClassResolverCache();

  const target = parseMemberAccessTarget(options.text, line, character);
  if (target) {
    const targetResult = await buildTargetPathMemberAccessCompletions(
      ast,
      analysis,
      target,
      line,
      character,
      options,
      resolverOptions,
      resolverCache,
      resolveExtensionMemberTypeName,
      buildMemberCompletionItemsForType
    );
    if (targetResult) {
      if (targetResult.items.length > 0 || !allowRecovery || !targetResult.shouldRecoverOnEmpty) {
        return targetResult.items;
      }
      return buildRecoveredMemberAccessCompletions(
        line,
        character,
        options,
        async ({
          ast,
          analysis,
          className,
          prefix,
          line,
          dotCharacter,
          character,
          options,
          resolverOptions,
          resolverCache
        }) => buildMemberCompletionItemsForType(
          ast,
          analysis,
          className,
          prefix,
          line,
          dotCharacter,
          character,
          options,
          resolverOptions,
          resolverCache
        ),
        buildMemberAccessCompletions
      );
    } 
  }

  // The receiver is a complex expression (such as a call like `fetch(...)`) or
  // identifier-based resolution failed. Resolve its type from the analyzed
  // expression types, which already reflect sync-function auto-await
  // (`Promise<T>` is observed as `T`).
  const analyzedReceiverResult = await buildAnalyzedReceiverMemberAccessCompletions(
    ast,
    analysis,
    line,
    character,
    options,
    resolverOptions,
    resolverCache,
    buildMemberCompletionItemsForType
  );
  if (analyzedReceiverResult.items.length > 0) {
    return analyzedReceiverResult.items;
  }

  if (!target && !analyzedReceiverResult.foundDot) {
    return null;
  }
  return allowRecovery
    ? buildRecoveredMemberAccessCompletions(
      line,
      character,
      options,
      async ({
        ast,
        analysis,
        className,
        prefix,
        line,
        dotCharacter,
        character,
        options,
        resolverOptions,
        resolverCache
      }) => buildMemberCompletionItemsForType(
        ast,
        analysis,
        className,
        prefix,
        line,
        dotCharacter,
        character,
        options,
        resolverOptions,
        resolverCache
      ),
      buildMemberAccessCompletions
    )
    : null;
}
