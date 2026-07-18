import { NodeKind } from "compiler/ast/ast";
import { resolveInterfaceMember, resolveInterfaceMemberNames, resolveInterfaceStatementAcrossFiles } from "./classResolver";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import { CompletionItemKind, type CompletionRequestOptions, type InterfaceCompletionMember } from "./completionModel";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { baseTypeName } from "compiler/analysis/typeNames";
import type { EnumStatement, Program, TypeAliasStatement } from "compiler/ast/ast";
import { fileURLToPath } from "compiler/utils/path";
import type { CompletionItem } from "vscode-languageserver/node.js";
import {
  buildEnumMemberCompletionItems,
  buildInterfaceMemberCompletionItems
} from "./memberCompletionItemBuilders";
import {
  parseObjectTypeTextMembers,
  parseTypeAliasObjectMembers
} from "./memberCompletionObjectMembers";
import { collectAmbientInterfaceCompletionMembers } from "./memberCompletionRecovery";

export async function resolveInterfaceCompletionMembers(
  ast: Program,
  resolvedClassName: string,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): Promise<{
  interfaceMembers: InterfaceCompletionMember[];
  hasInterfaceStatement: boolean;
}> {
  const interfaceStatement = (await resolveInterfaceStatementAcrossFiles(
    ast,
    baseTypeName(resolvedClassName),
    resolverOptions,
    resolverCache
  ))?.interfaceStatement;
  const interfaceMembers: InterfaceCompletionMember[] = interfaceStatement
    ? (await Promise.all(
      (await resolveInterfaceMemberNames(
        interfaceStatement,
        resolvedClassName,
        {
          ast,
          options: resolverOptions,
          cache: resolverCache
        }
      )).map(async (memberName) => {
        const member = await resolveInterfaceMember(interfaceStatement, memberName, resolvedClassName, {
          ast,
          options: resolverOptions,
          cache: resolverCache
        });
        if (!member) {
          return null;
        }
        return {
          name: memberName,
          kind: member.kind === "field" ? CompletionItemKind.Field : CompletionItemKind.Method,
          detail: member.kind === "field"
            ? `Interface property: ${member.typeName}`
            : `Interface method: ${member.typeName}`
        };
      })
    )).filter((member): member is InterfaceCompletionMember => member !== null)
    : [];
  return {
    interfaceMembers,
    hasInterfaceStatement: interfaceStatement !== null && interfaceStatement !== undefined
  };
}

export async function buildNonClassMemberCompletionItems(
  ast: Program,
  resolvedClassName: string,
  prefix: string,
  options: CompletionRequestOptions,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): Promise<CompletionItem[]> {
  const enumStatement = (await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: baseTypeName(resolvedClassName),
    currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
    predicate: (statement): statement is EnumStatement => statement.kind === NodeKind.EnumStatement,
    includeRuntime: true,
    sourceRoots: resolverOptions.sourceRoots ?? [],
    ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
    ...(resolverOptions.getSessionForFilePath
      ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
      : {})
  }))?.declaration;
  if (enumStatement) {
    return buildEnumMemberCompletionItems(enumStatement, prefix);
  }

  const { interfaceMembers, hasInterfaceStatement } = await resolveInterfaceCompletionMembers(
    ast,
    resolvedClassName,
    resolverOptions,
    resolverCache
  );
  if (hasInterfaceStatement) {
    return buildInterfaceMemberCompletionItems(prefix, interfaceMembers);
  }

  const ambientInterfaceMembers = options.ambientDeclarations
    ? collectAmbientInterfaceCompletionMembers(options.ambientDeclarations, baseTypeName(resolvedClassName))
    : [];
  if (ambientInterfaceMembers.length > 0) {
    return buildInterfaceMemberCompletionItems(prefix, ambientInterfaceMembers);
  }

  const typeAliasStatement = (await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: baseTypeName(resolvedClassName),
    currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
    predicate: (statement): statement is TypeAliasStatement => statement.kind === NodeKind.TypeAliasStatement,
    includeRuntime: true,
    sourceRoots: resolverOptions.sourceRoots ?? [],
    ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
    ...(resolverOptions.getSessionForFilePath
      ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
      : {})
  }))?.declaration;
  const typeAliasMembers = typeAliasStatement
    ? parseTypeAliasObjectMembers(typeAliasStatement, resolvedClassName)
    : [];
  if (typeAliasMembers.length > 0) {
    return buildInterfaceMemberCompletionItems(prefix, typeAliasMembers);
  }

  const objectTypeMembers = parseObjectTypeTextMembers(resolvedClassName);
  if (objectTypeMembers.length > 0) {
    return buildInterfaceMemberCompletionItems(prefix, objectTypeMembers);
  }

  return [];
}
