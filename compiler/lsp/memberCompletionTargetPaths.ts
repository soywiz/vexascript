import { EnumStatement } from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";

import { fileURLToPath } from "compiler/utils/path";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import type { CompletionRequestOptions, MemberAccessTarget } from "./completionModel";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import {
  buildNamespaceMemberCompletionItems,
  findNamespaceByPath,
  findNodeModuleNamespaceForTypeName
} from "./memberCompletionNamespaces";
import { resolveTypeNameFromPath } from "./memberCompletionPathTypes";
import type { CompletionItem } from "vscode-languageserver/node.js";

export interface TargetPathCompletionResult {
  items: CompletionItem[];
  shouldRecoverOnEmpty: boolean;
}

export async function buildTargetPathMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  target: MemberAccessTarget,
  line: number,
  character: number,
  options: CompletionRequestOptions,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache,
  resolveExtensionMemberTypeName: (
    ast: Program,
    objectTypeName: string,
    memberName: string,
    options: ClassResolverOptions,
    analysis?: Analysis | null
  ) => Promise<string | null>,
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
): Promise<TargetPathCompletionResult | null> {
  const pathSegments = target.objectPath.split(".");

  if (pathSegments.length > 1 && pathSegments[0]) {
    const firstSegmentEnum = (await resolveTopLevelDeclarationAcrossFiles({
      ast,
      name: pathSegments[0],
      currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
      predicate: (statement): statement is EnumStatement => statement instanceof EnumStatement,
      includeRuntime: true,
      sourceRoots: resolverOptions.sourceRoots ?? [],
      ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
      ...(resolverOptions.getSessionForFilePath
        ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
        : {})
    }))?.declaration;
    if (firstSegmentEnum) {
      return {
        items: [],
        shouldRecoverOnEmpty: false
      };
    }
  }

  const importerFilePath = options.uri ? fileURLToPath(options.uri) : null;
  const namespaceStatement =
    findNamespaceByPath(ast, pathSegments) ??
    (importerFilePath && pathSegments.length === 1 && pathSegments[0]
      ? await findNodeModuleNamespaceForTypeName(ast, pathSegments[0], importerFilePath, options)
      : null);
  if (namespaceStatement) {
    return {
      items: buildNamespaceMemberCompletionItems(namespaceStatement, target.prefix),
      shouldRecoverOnEmpty: false
    };
  }

  const className = await resolveTypeNameFromPath(
    ast,
    analysis,
    pathSegments,
    line,
    target.objectStartCharacter,
    resolverOptions,
    resolverCache,
    resolveExtensionMemberTypeName
  );
  if (!className) {
    return null;
  }

  return {
    items: await buildMemberCompletionItemsForType(
      ast,
      analysis,
      className,
      target.prefix,
      line,
      target.memberAccessStartCharacter,
      character,
      options,
      resolverOptions,
      resolverCache
    ),
    shouldRecoverOnEmpty: true
  };
}
