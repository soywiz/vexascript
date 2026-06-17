import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { Identifier } from "compiler/ast/ast";
import type { Hover } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveInterfaceMember
} from "./classResolver";
import type { ResolveContext } from "./crossFileContext";
import {
  classMemberInfoByName,
  findClassMemberDeclarationAtPosition,
  findMemberExpressionAtPosition,
  parseObjectTypeMemberInfo,
  resolveTypeDefinitionAcrossFiles,
  type ClassMemberInfo
} from "./crossFileTypeResolution";
import { nodeRange } from "./ranges";

export function createMemberHoverContents(
  member: ClassMemberInfo
): string {
  return `${member.memberName}: ${member.typeLabel}`;
}

export async function resolveMemberHoverAcrossFiles(context: ResolveContext): Promise<Hover | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const declaration = findClassMemberDeclarationAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (declaration) {
    return {
      contents: {
        kind: "plaintext",
        value: createMemberHoverContents(declaration.member)
      },
      range: declaration.member.range
    };
  }

  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const objectTypeLabel = typeToString(objectType);
  const structuralMember = parseObjectTypeMemberInfo(objectTypeLabel, memberName);
  const resolvedClassName = objectType.kind === "array"
    ? "Array"
    : objectType.kind === "named" || objectType.kind === "builtin"
      ? boxedPrimitiveTypeName(objectType.name)
      : null;
  const classResolution = resolvedClassName
    ? await resolveTypeDefinitionAcrossFiles(context, resolvedClassName)
    : null;
  if (!classResolution) {
    if (!structuralMember) {
      return null;
    }
    const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
    return {
      contents: {
        kind: "plaintext",
        value: `${memberName}: ${structuralMember.typeLabel}`
      },
      ...(memberRange ? { range: memberRange } : {})
    };
  }

  const resolvedMember = classResolution.declaration.kind === "ClassStatement"
    ? await resolveClassMember(
      classResolution.declaration,
      memberName,
      objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
      {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      }
    )
    : await resolveInterfaceMember(
      classResolution.declaration,
      memberName,
      objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
      {
        ast: context.session.ast,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis,
        cache: createClassResolverCache()
      }
    );
  const fallbackMember = classMemberInfoByName(classResolution.declaration, memberName);
  if (!resolvedMember && !fallbackMember && !structuralMember) {
    return null;
  }

  const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
  const typeLabel = resolvedMember?.typeName ?? fallbackMember?.typeLabel ?? structuralMember!.typeLabel;
  const documentation = resolvedMember?.documentation;
  const hoverValue = documentation ? `${memberName}: ${typeLabel}\n\n${documentation}` : `${memberName}: ${typeLabel}`;
  return {
    contents: {
      kind: "plaintext",
      value: hoverValue
    },
    ...(memberRange ? { range: memberRange } : {})
  };
}
