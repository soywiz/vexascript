import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString, type AnalysisType } from "compiler/analysis/types";
import type {
  ImportStatement,
  TypeAliasStatement
} from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { Location } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveInterfaceMemberDeclaration
} from "./classResolver";
import type { ResolveContext } from "./crossFileContext";
import {
  getSessionForFilePath,
  preferVirtualRuntimeDeclarationFilePath,
  resolveImportTargetInContext
} from "./crossFileContext";
import {
  classMemberDeclarationRangeByName,
  fallbackInterfaceMemberRangeInFile,
  fallbackTypeAliasMemberRangeInFile,
  parseObjectTypeMemberInfo,
  resolveTypeAliasDefinitionAcrossFiles,
  resolveTypeDefinitionAcrossFiles
} from "./crossFileTypeResolution";
import { pathToUri, uriToFilePath } from "./importFixes";

function receiverTypeNamesForObjectType(objectType: AnalysisType): string[] {
  if (objectType.kind === "array") {
    return ["Array"];
  }
  if ((objectType.kind === "named" || objectType.kind === "builtin") && objectType.name === "int") {
    return ["int", "number"];
  }
  if (objectType.kind === "named" || objectType.kind === "builtin") {
    return [objectType.name];
  }
  return [];
}

export async function resolveDeclaredMemberDefinitionAcrossFiles(
  context: ResolveContext,
  objectType: AnalysisType,
  memberName: string,
  preferredAmbientReceiverFilePath?: string | null
): Promise<Location | null> {
  const structuralMember = parseObjectTypeMemberInfo(typeToString(objectType), memberName);
  const receiverTypeNames = receiverTypeNamesForObjectType(objectType);

  if (objectType.kind === "named" || objectType.kind === "array" || objectType.kind === "builtin") {
    const resolvedReceiverTypeName = objectType.kind === "array"
      ? receiverTypeNames[0]!
      : boxedPrimitiveTypeName(receiverTypeNames[0]!);
    const classResolution = await resolveTypeDefinitionAcrossFiles(
      context,
      resolvedReceiverTypeName,
      preferredAmbientReceiverFilePath ?? undefined
    );
    if (classResolution) {
      const resolverContext = {
        ast: context.session.ast!,
        options: {
          uri: context.uri,
          sourceRoots: context.sourceRoots,
          ...(context.getSessionForFilePath
            ? { getSessionForFilePath: context.getSessionForFilePath }
            : {})
        },
        analysis: context.session.analysis!,
        cache: createClassResolverCache()
      };
      const interfaceMemberDeclaration = classResolution.declaration.kind === "InterfaceStatement"
        ? await resolveInterfaceMemberDeclaration(
          { interfaceStatement: classResolution.declaration, filePath: classResolution.filePath },
          memberName,
          objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
          resolverContext
        )
        : null;
      const memberOwner = interfaceMemberDeclaration?.declaration ?? classResolution.declaration;
      const memberFilePath = await preferVirtualRuntimeDeclarationFilePath(
        interfaceMemberDeclaration?.filePath ?? classResolution.filePath,
        context
      );
      const range = classMemberDeclarationRangeByName(memberOwner, memberName)
        ?? (
          memberOwner.kind === "InterfaceStatement"
            ? await fallbackInterfaceMemberRangeInFile(context, memberFilePath, memberOwner.name.name, memberName)
            : null
        );
      if (range) {
        return {
          uri: pathToUri(memberFilePath),
          range
        };
      }
    }

    const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, receiverTypeNames[0]!);
    if (typeAliasResolution) {
      const range = await fallbackTypeAliasMemberRangeInFile(
        context,
        typeAliasResolution.filePath,
        typeAliasResolution.declaration.name.name,
        memberName
      );
      if (range) {
        return {
          uri: pathToUri(typeAliasResolution.filePath),
          range
        };
      }
    }
  }

  if (structuralMember && objectType.kind === "named") {
    const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, objectType.name);
    if (typeAliasResolution) {
      const range = await fallbackTypeAliasMemberRangeInFile(
        context,
        typeAliasResolution.filePath,
        typeAliasResolution.declaration.name.name,
        memberName
      );
      if (range) {
        return {
          uri: pathToUri(typeAliasResolution.filePath),
          range
        };
      }
    }
  }

  if (structuralMember && context.session.ast) {
    for (const statement of context.session.ast.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      const targetFilePath = await resolveImportTargetInContext(
        uriToFilePath(context.uri)!,
        importStatement.from.value,
        context
      );
      if (!targetFilePath) {
        continue;
      }
      const targetSession = await getSessionForFilePath(targetFilePath, context);
      if (!targetSession?.ast) {
        continue;
      }
      for (const targetStatement of targetSession.ast.body) {
        const declaration = unwrapExportedDeclaration(targetStatement);
        if (!declaration || declaration.kind !== "TypeAliasStatement") {
          continue;
        }
        const candidateRange = await fallbackTypeAliasMemberRangeInFile(
          context,
          targetFilePath,
          (declaration as TypeAliasStatement).name.name,
          memberName
        );
        if (candidateRange) {
          return {
            uri: pathToUri(targetFilePath),
            range: candidateRange
          };
        }
      }
    }
  }

  return null;
}
