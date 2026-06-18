import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { ClassStatement, Identifier, InterfaceStatement } from "compiler/ast/ast";
import type { Hover } from "vscode-languageserver/node.js";
import { readDocumentationFromNamedNode } from "./documentation";
import {
  createClassResolverCache,
  resolveClassStatementAcrossFiles,
  resolveClassMember,
  resolveInterfaceStatementAcrossFiles,
  resolveInterfaceMember
} from "./classResolver";
import type { ResolveContext } from "./crossFileContext";
import {
  classMemberInfoByName,
  findClassMemberDeclarationAtPosition,
  findMemberExpressionAtPosition,
  parseObjectTypeMemberInfo,
  resolveAmbientTypeDefinitionOfKind,
  resolveTypeDefinitionAcrossFiles,
  type ClassMemberInfo
} from "./crossFileTypeResolution";
import { uriToFilePath } from "./importFixes";
import { resolveExtensionMemberDeclarationAcrossFiles } from "./crossFileMemberDefinitionSources";
import { inferExtensionReturnTypeName } from "./memberCompletionExtensions";
import { nodeRange } from "./ranges";

export function createMemberHoverContents(
  member: ClassMemberInfo
): string {
  return `${member.memberName}: ${member.typeLabel}`;
}

function extensionDocumentationValue(extensionMember: Awaited<ReturnType<typeof resolveExtensionMemberDeclarationAcrossFiles>>): string | undefined {
  if (!extensionMember) {
    return undefined;
  }
  if (extensionMember.declaration.kind === "VarStatement") {
    return extensionMember.declaration.name.kind === "Identifier"
      ? readDocumentationFromNamedNode({
        firstToken: extensionMember.declaration.firstToken,
        name: extensionMember.declaration.name
      })
      : readDocumentationFromNamedNode({
        firstToken: extensionMember.declaration.firstToken
      });
  }
  return readDocumentationFromNamedNode(extensionMember.declaration);
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
  const extensionMember = await resolveExtensionMemberDeclarationAcrossFiles(
    context,
    objectType,
    memberName
  );
  const currentFilePath = uriToFilePath(context.uri);
  const extensionMemberAnalysis = extensionMember && context.getSessionForFilePath && extensionMember.filePath !== currentFilePath
    ? (await context.getSessionForFilePath(extensionMember.filePath))?.analysis ?? null
    : context.session.analysis;
  const extensionTypeLabel = extensionMember
    ? inferExtensionReturnTypeName(extensionMember.declaration, extensionMemberAnalysis)
    : null;
  const extensionDocumentation = extensionDocumentationValue(extensionMember);
  const resolvedClassName = objectType.kind === "array"
    ? "Array"
    : objectType.kind === "named" || objectType.kind === "builtin"
      ? boxedPrimitiveTypeName(objectType.name)
      : null;
  const objectTypeName = objectType.kind === "array"
    ? `Array<${typeToString(objectType.elementType)}>`
    : typeToString(objectType);
  const primaryResolution = resolvedClassName
    ? await resolveTypeDefinitionAcrossFiles(context, resolvedClassName)
    : null;
  if (!primaryResolution) {
    const inferredMemberType = context.session.analysis.getExpressionTypes().get(memberExpression);
    const inferredMemberTypeLabel = inferredMemberType ? typeToString(inferredMemberType) : null;
    if (
      !structuralMember &&
      !extensionTypeLabel &&
      (!inferredMemberTypeLabel || inferredMemberTypeLabel === "unknown")
    ) {
      return null;
    }
    const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
    const typeLabel = structuralMember?.typeLabel ?? extensionTypeLabel ?? inferredMemberTypeLabel;
    const hoverValue = extensionDocumentation
      ? `${memberName}: ${typeLabel}\n\n${extensionDocumentation}`
      : `${memberName}: ${typeLabel}`;
    return {
      contents: {
        kind: "plaintext",
        value: hoverValue
      },
      ...(memberRange ? { range: memberRange } : {})
    };
  }

  const resolverCache = createClassResolverCache();
  const resolverOptions = {
    uri: context.uri,
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  };
  const resolverContext = {
    ast: context.session.ast,
    options: resolverOptions,
    analysis: context.session.analysis,
    cache: resolverCache
  };
  const fallbackClassResolution = primaryResolution.declaration.kind === "ClassStatement" || !resolvedClassName
    ? null
    : await resolveClassStatementAcrossFiles(
      context.session.ast,
      resolvedClassName,
      resolverOptions,
      resolverCache
    ) ?? await resolveAmbientTypeDefinitionOfKind(
      context,
      resolvedClassName,
      "ClassStatement",
      primaryResolution.filePath
    ).then((resolved) => resolved
      ? { classStatement: resolved.declaration as ClassStatement, filePath: resolved.filePath }
      : null);
  const fallbackInterfaceResolution = primaryResolution.declaration.kind === "InterfaceStatement" || !resolvedClassName
    ? null
    : await resolveInterfaceStatementAcrossFiles(
      context.session.ast,
      resolvedClassName,
      resolverOptions,
      resolverCache
    ) ?? await resolveAmbientTypeDefinitionOfKind(
      context,
      resolvedClassName,
      "InterfaceStatement",
      primaryResolution.filePath
    ).then((resolved) => resolved
      ? { interfaceStatement: resolved.declaration as InterfaceStatement, filePath: resolved.filePath }
      : null);

  const resolvedClassMember = primaryResolution.declaration.kind === "ClassStatement"
    ? await resolveClassMember(
      primaryResolution.declaration,
      memberName,
      objectTypeName,
      resolverContext
    )
    : fallbackClassResolution
      ? await resolveClassMember(
        fallbackClassResolution.classStatement,
        memberName,
        objectTypeName,
        resolverContext
      )
    : null;
  const resolvedInterfaceMember = primaryResolution.declaration.kind === "InterfaceStatement"
    ? await resolveInterfaceMember(
      primaryResolution.declaration,
      memberName,
      objectTypeName,
      resolverContext
    )
    : fallbackInterfaceResolution
      ? await resolveInterfaceMember(
        fallbackInterfaceResolution.interfaceStatement,
        memberName,
        objectTypeName,
        resolverContext
      )
    : null;
  const fallbackMember = classMemberInfoByName(primaryResolution.declaration, memberName)
    ?? (fallbackClassResolution
      ? classMemberInfoByName(fallbackClassResolution.classStatement, memberName)
      : null)
    ?? (fallbackInterfaceResolution
      ? classMemberInfoByName(fallbackInterfaceResolution.interfaceStatement, memberName)
      : null);
  const resolvedMember = resolvedClassMember ?? resolvedInterfaceMember;
  const memberRange = nodeRange(memberExpression.property) ?? nodeRange(memberExpression);
  const inferredMemberType = context.session.analysis.getExpressionTypes().get(memberExpression);
  const inferredMemberTypeLabel = inferredMemberType ? typeToString(inferredMemberType) : null;
  if (
    !resolvedMember &&
    !fallbackMember &&
    !structuralMember &&
    !extensionTypeLabel &&
    (!inferredMemberTypeLabel || inferredMemberTypeLabel === "unknown")
  ) {
    return null;
  }

  const typeLabel = resolvedMember?.typeName
    ?? fallbackMember?.typeLabel
    ?? structuralMember?.typeLabel
    ?? extensionTypeLabel
    ?? inferredMemberTypeLabel!;
  const documentation = resolvedMember?.documentation ?? extensionDocumentation;
  const hoverValue = documentation ? `${memberName}: ${typeLabel}\n\n${documentation}` : `${memberName}: ${typeLabel}`;
  return {
    contents: {
      kind: "plaintext",
      value: hoverValue
    },
    ...(memberRange ? { range: memberRange } : {})
  };
}
