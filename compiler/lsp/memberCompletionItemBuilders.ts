import { classPropertyParameters, resolveClassMember, resolveClassMemberNames } from "./classResolver";
import type { ClassResolverCache, ClassResolverOptions } from "./classResolver";
import { Analysis } from "compiler/analysis/Analysis";
import type { ClassMember, ClassStatement, EnumStatement, Program } from "compiler/ast/ast";
import type { CompletionItem } from "vscode-languageserver/node.js";
import { CompletionItemKind } from "./completionModel";
import type { InterfaceCompletionMember, TypeAliasCompletionMember } from "./completionModel";

export function operatorSymbolFromMemberName(name: string): string | null {
  return name.startsWith("operator") ? name.slice("operator".length) || null : null;
}

export function memberSortGroup(memberName: string, classStatement: ClassStatement, membersByName: Map<string, ClassMember>): string {
  if (classPropertyParameters(classStatement).some((parameter) => parameter.name.kind === "Identifier" && parameter.name.name === memberName)) {
    return "0";
  }
  const member = membersByName.get(memberName);
  if (member?.kind === "ClassFieldMember") {
    return "1";
  }
  return "2";
}

export async function buildClassMemberCompletionItems(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  prefix: string,
  analysis: Analysis,
  memberAccessEdit:
    | {
        line: number;
        dotCharacter: number;
        prefixEndCharacter: number;
      }
    | undefined,
  resolverContext: {
    ast: Program;
    options: ClassResolverOptions;
    cache: ClassResolverCache;
  }
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();
  const membersByName = new Map(classStatement.members.map((member) => [member.name.name, member]));

  const pushItem = (item: CompletionItem): void => {
    if (normalizedPrefix.length > 0 && !item.label.startsWith(normalizedPrefix)) {
      return;
    }
    if (seen.has(item.label)) {
      return;
    }
    seen.add(item.label);
    items.push(item);
  };

  const memberNames = await resolveClassMemberNames(classStatement, objectTypeName, {
    ast: resolverContext.ast,
    options: resolverContext.options,
    cache: resolverContext.cache
  });
  for (const memberName of memberNames) {
    const resolved = await resolveClassMember(classStatement, memberName, objectTypeName, {
      ast: resolverContext.ast,
      options: resolverContext.options,
      analysis,
      cache: resolverContext.cache
    });
    if (!resolved) {
      continue;
    }
    if (resolved.kind === "field") {
      pushItem({
        label: memberName,
        kind: CompletionItemKind.Field,
        detail: `Class property: ${resolved.typeName}`,
        sortText: `${memberSortGroup(memberName, classStatement, membersByName)}-${memberName}`
      });
      continue;
    }

    const operatorSymbol = operatorSymbolFromMemberName(memberName);
    pushItem({
      label: memberName,
      kind: CompletionItemKind.Method,
      ...(operatorSymbol ? { filterText: memberName } : {}),
      detail: resolved.signature
        ? `Class method: (${resolved.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${resolved.signature.returnTypeName}`
        : "Class method",
      ...(operatorSymbol && memberAccessEdit
        ? {
            textEdit: {
              range: {
                start: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter + 1 },
                end: { line: memberAccessEdit.line, character: memberAccessEdit.prefixEndCharacter }
              },
              newText: ` ${operatorSymbol} `
            },
            additionalTextEdits: [
              {
                range: {
                  start: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter },
                  end: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter + 1 }
                },
                newText: ""
              }
            ]
          }
        : {}),
      sortText: `${memberSortGroup(memberName, classStatement, membersByName)}-${memberName}`
    });
  }

  return items;
}

export function buildInterfaceMemberCompletionItems(
  prefix: string,
  resolvedMembers: Array<InterfaceCompletionMember | TypeAliasCompletionMember>
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();
  for (const member of resolvedMembers) {
    if (normalizedPrefix.length > 0 && !member.name.startsWith(normalizedPrefix)) {
      continue;
    }
    if (seen.has(member.name)) {
      continue;
    }
    seen.add(member.name);
    items.push({
      label: member.name,
      kind: member.kind,
      detail: member.detail,
      sortText: `2-${member.name}`
    });
  }
  return items;
}

export function buildEnumMemberCompletionItems(
  enumStatement: EnumStatement,
  prefix: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const normalizedPrefix = prefix.trim();
  for (const member of enumStatement.members) {
    const label = member.name.name;
    if (normalizedPrefix.length > 0 && !label.startsWith(normalizedPrefix)) {
      continue;
    }
    items.push({
      label,
      kind: CompletionItemKind.EnumMember,
      detail: `Enum member: ${enumStatement.name.name}`,
      sortText: `2-${label}`
    });
  }
  return items;
}
