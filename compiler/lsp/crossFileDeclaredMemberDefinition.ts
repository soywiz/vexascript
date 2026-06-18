import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString, type AnalysisType } from "compiler/analysis/types";
import type {
  ClassStatement,
  ImportStatement,
  InterfaceStatement,
  TypeAliasStatement
} from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { Location } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveClassMemberDeclaration,
  resolveClassStatementAcrossFiles,
  resolveInterfaceStatementAcrossFiles,
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
  resolveAmbientTypeDefinitionOfKind,
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
  _preferredAmbientReceiverFilePath?: string | null
): Promise<Location | null> {
  const structuralMember = parseObjectTypeMemberInfo(typeToString(objectType), memberName);
  const receiverTypeNames = receiverTypeNamesForObjectType(objectType);

  if (objectType.kind === "named" || objectType.kind === "array" || objectType.kind === "builtin") {
    const resolvedReceiverTypeName = objectType.kind === "array"
      ? receiverTypeNames[0]!
      : boxedPrimitiveTypeName(receiverTypeNames[0]!);
    const primaryResolution = await resolveTypeDefinitionAcrossFiles(
      context,
      resolvedReceiverTypeName,
      _preferredAmbientReceiverFilePath ?? undefined
    );
    if (primaryResolution) {
      const resolverCache = createClassResolverCache();
      const resolverOptions = {
        uri: context.uri,
        sourceRoots: context.sourceRoots,
        ...(context.getSessionForFilePath
          ? { getSessionForFilePath: context.getSessionForFilePath }
          : {})
      };
      const resolverContext = {
        ast: context.session.ast!,
        options: resolverOptions,
        analysis: context.session.analysis!,
        cache: resolverCache
      };
      const objectTypeName = objectType.kind === "array"
        ? `Array<${typeToString(objectType.elementType)}>`
        : typeToString(objectType);
      const fallbackClassResolution = primaryResolution.declaration.kind === "ClassStatement"
        ? null
        : await resolveClassStatementAcrossFiles(
          context.session.ast!,
          resolvedReceiverTypeName,
          resolverOptions,
          resolverCache
        ) ?? await resolveAmbientTypeDefinitionOfKind(
          context,
          resolvedReceiverTypeName,
          "ClassStatement",
          primaryResolution.filePath
        ).then((resolved) => resolved
          ? { classStatement: resolved.declaration as ClassStatement, filePath: resolved.filePath }
          : null);
      const fallbackInterfaceResolution = primaryResolution.declaration.kind === "InterfaceStatement"
        ? null
        : await resolveInterfaceStatementAcrossFiles(
          context.session.ast!,
          resolvedReceiverTypeName,
          resolverOptions,
          resolverCache
        ) ?? await resolveAmbientTypeDefinitionOfKind(
          context,
          resolvedReceiverTypeName,
          "InterfaceStatement",
          primaryResolution.filePath
        ).then((resolved) => resolved
          ? { interfaceStatement: resolved.declaration as InterfaceStatement, filePath: resolved.filePath }
          : null);
      const classMemberDeclaration = primaryResolution.declaration.kind === "ClassStatement"
        ? await resolveClassMemberDeclaration(
          {
            classStatement: primaryResolution.declaration,
            filePath: primaryResolution.filePath
          },
          memberName,
          objectTypeName,
          resolverContext
        )
        : fallbackClassResolution
          ? await resolveClassMemberDeclaration(
            fallbackClassResolution,
            memberName,
            objectTypeName,
            resolverContext
          )
          : null;
      if (classMemberDeclaration) {
        const memberFilePath = await preferVirtualRuntimeDeclarationFilePath(
          classMemberDeclaration.filePath,
          context
        );
        const range = classMemberDeclarationRangeByName(
          classMemberDeclaration.classStatement,
          memberName
        );
        if (range) {
          return {
            uri: pathToUri(memberFilePath),
            range
          };
        }
      }

      const interfaceMemberDeclaration = primaryResolution.declaration.kind === "InterfaceStatement"
        ? await resolveInterfaceMemberDeclaration(
          {
            interfaceStatement: primaryResolution.declaration,
            filePath: primaryResolution.filePath
          },
          memberName,
          objectTypeName,
          resolverContext
        )
        : fallbackInterfaceResolution
          ? await resolveInterfaceMemberDeclaration(
            fallbackInterfaceResolution,
            memberName,
            objectTypeName,
            resolverContext
          )
          : null;
      if (interfaceMemberDeclaration) {
        const memberFilePath = await preferVirtualRuntimeDeclarationFilePath(
          interfaceMemberDeclaration.filePath,
          context
        );
        const range = classMemberDeclarationRangeByName(interfaceMemberDeclaration.declaration, memberName)
          ?? await fallbackInterfaceMemberRangeInFile(
            context,
            memberFilePath,
            interfaceMemberDeclaration.declaration.name.name,
            memberName
          );
        if (range) {
          return {
            uri: pathToUri(memberFilePath),
            range
          };
        }
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
