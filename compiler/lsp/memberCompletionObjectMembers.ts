import { CompletionItemKind } from "./completionModel";
import type { TypeAliasCompletionMember } from "./completionModel";
import { findMatchingTypeDelimiter, findTopLevelTypeCharacter, parseTypeNameShape, splitTopLevelDelimitedTypeText, splitTopLevelTypeText, stripEnclosingTypeParens, substituteTypeNameText } from "compiler/analysis/typeNames";
import type { TypeAliasStatement } from "compiler/ast/ast";

export function typeAliasSubstitutions(
  typeAlias: TypeAliasStatement,
  objectTypeName: string
): Map<string, string> {
  const substitutions = new Map<string, string>();
  const parsedObjectType = parseTypeNameShape(objectTypeName);
  const declaredTypeParameters = typeAlias.typeParameters ?? [];
  for (let i = 0; i < declaredTypeParameters.length; i += 1) {
    const parameterName = declaredTypeParameters[i]?.name.name;
    if (!parameterName) {
      continue;
    }
    substitutions.set(parameterName, parsedObjectType.typeArguments[i] ?? parameterName);
  }
  return substitutions;
}

function isCallableTypeText(typeText: string): boolean {
  return splitTopLevelTypeText(typeText, "|").some((part) => {
    const trimmedPart = stripEnclosingTypeParens(part.trim());
    const parameterStart = findTopLevelTypeCharacter(trimmedPart, "(");
    if (parameterStart !== 0) {
      return false;
    }
    const parameterEnd = findMatchingTypeDelimiter(trimmedPart, parameterStart, "(", ")");
    if (parameterEnd < 0) {
      return false;
    }
    return trimmedPart.indexOf("=>", parameterEnd) >= 0;
  });
}

export function parseObjectTypeTextMembers(
  objectTypeText: string,
  substitutions: Map<string, string> = new Map()
): TypeAliasCompletionMember[] {
  const targetTypeText = objectTypeText.trim();
  if (!targetTypeText.startsWith("{") || !targetTypeText.endsWith("}")) {
    return [];
  }

  const body = targetTypeText.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }

  const members: TypeAliasCompletionMember[] = [];

  for (const entry of splitTopLevelDelimitedTypeText(body, new Set([",", ";"]))) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry.length === 0) {
      continue;
    }

    const methodOpenParen = findTopLevelTypeCharacter(trimmedEntry, "(");
    const propertyColon = findTopLevelTypeCharacter(trimmedEntry, ":");
    if (methodOpenParen >= 0 && (propertyColon < 0 || methodOpenParen < propertyColon)) {
      const closeParen = findMatchingTypeDelimiter(trimmedEntry, methodOpenParen, "(", ")");
      const arrowIndex = closeParen >= 0 ? trimmedEntry.indexOf("=>", closeParen) : -1;
      if (closeParen < 0 || arrowIndex < 0) {
        continue;
      }
      const name = trimmedEntry.slice(0, methodOpenParen).trim().replace(/\?$/, "");
      if (!name) {
        continue;
      }
      members.push({
        name,
        kind: CompletionItemKind.Method,
        detail: `Type alias method: ${substituteTypeNameText(trimmedEntry.slice(methodOpenParen).trim(), substitutions)}`
      });
      continue;
    }

    if (propertyColon < 0) {
      continue;
    }
    const name = trimmedEntry.slice(0, propertyColon).trim().replace(/\?$/, "");
    if (!name) {
      continue;
    }
    const propertyTypeText = substituteTypeNameText(trimmedEntry.slice(propertyColon + 1).trim(), substitutions);
    members.push({
      name,
      kind: isCallableTypeText(propertyTypeText) ? CompletionItemKind.Method : CompletionItemKind.Field,
      detail: `${isCallableTypeText(propertyTypeText) ? "Type alias method" : "Type alias property"}: ${propertyTypeText}`
    });
  }

  return members;
}

export function parseTypeAliasObjectMembers(
  typeAlias: TypeAliasStatement,
  objectTypeName: string
): TypeAliasCompletionMember[] {
  return parseObjectTypeTextMembers(
    typeAlias.targetType.name,
    typeAliasSubstitutions(typeAlias, objectTypeName)
  );
}
