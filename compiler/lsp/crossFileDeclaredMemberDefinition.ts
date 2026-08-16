import { ArrayType, NamedType } from "../analysis/types";
import { ClassStatement, ImportStatement, InterfaceStatement, NodeKind, TypeAliasStatement } from "compiler/ast/ast";
import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import { typeToString, type AnalysisType } from "compiler/analysis/types";

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
  receiverTypeNamesForMember,
  resolveAmbientTypeDefinitionOfKind,
  resolveTypeAliasDefinitionAcrossFiles,
  resolveTypeDefinitionAcrossFiles
} from "./crossFileTypeResolution";
import { pathToUri, uriToFilePath } from "./importFixes";
import { resolveNodeModulesMemberDefinition } from "./crossFileMemberDefinitionSources";

async function resolveDeclaredMemberDefinitionForReceiverType(
  context: ResolveContext,
  objectTypeName: string,
  memberName: string,
  receiverTypeName: string,
  preferredAmbientReceiverFilePath?: string
): Promise<Location | null> {
  const resolvedReceiverTypeName = receiverTypeName === "Array"
    ? receiverTypeName
    : boxedPrimitiveTypeName(receiverTypeName);
  const primaryResolution = await resolveTypeDefinitionAcrossFiles(
    context,
    resolvedReceiverTypeName,
    preferredAmbientReceiverFilePath
  );
  if (primaryResolution) {
    if (primaryResolution.filePath.includes("/node_modules/")) {
      const nodeModuleLocation = await resolveNodeModulesMemberDefinition(
        context,
        receiverTypeName,
        memberName
      );
      if (nodeModuleLocation) {
        return nodeModuleLocation;
      }
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
      ast: context.session.ast!,
      options: resolverOptions,
      analysis: context.session.analysis!,
      cache: resolverCache
    };
    const fallbackClassResolution = primaryResolution.declaration instanceof ClassStatement
      ? null
      : await resolveClassStatementAcrossFiles(
        context.session.ast!,
        resolvedReceiverTypeName,
        resolverOptions,
        resolverCache
      ) ?? await resolveAmbientTypeDefinitionOfKind(
        context,
        resolvedReceiverTypeName,
        NodeKind.ClassStatement,
        primaryResolution.filePath
      ).then((resolved) => resolved
        ? { classStatement: resolved.declaration as ClassStatement, filePath: resolved.filePath }
        : null);
    const fallbackInterfaceResolution = primaryResolution.declaration instanceof InterfaceStatement
      ? null
      : await resolveInterfaceStatementAcrossFiles(
        context.session.ast!,
        resolvedReceiverTypeName,
        resolverOptions,
        resolverCache
      ) ?? await resolveAmbientTypeDefinitionOfKind(
        context,
        resolvedReceiverTypeName,
        NodeKind.InterfaceStatement,
        primaryResolution.filePath
      ).then((resolved) => resolved
        ? { interfaceStatement: resolved.declaration as InterfaceStatement, filePath: resolved.filePath }
        : null);
    const classMemberDeclaration = primaryResolution.declaration instanceof ClassStatement
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
        classMemberDeclaration.declaration,
        memberName
      ) ?? (classMemberDeclaration.declaration instanceof InterfaceStatement
        ? await fallbackInterfaceMemberRangeInFile(
          context,
          memberFilePath,
          classMemberDeclaration.declaration.name.name,
          memberName
        )
        : null);
      if (range) {
        return {
          uri: pathToUri(memberFilePath),
          range
        };
      }
    }

    const interfaceMemberDeclaration = primaryResolution.declaration instanceof InterfaceStatement
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

  const typeAliasResolution = await resolveTypeAliasDefinitionAcrossFiles(context, receiverTypeName);
  if (!typeAliasResolution) {
    return null;
  }
  const range = await fallbackTypeAliasMemberRangeInFile(
    context,
    typeAliasResolution.filePath,
    typeAliasResolution.declaration.name.name,
    memberName
  );
  if (!range) {
    return null;
  }
  return {
    uri: pathToUri(typeAliasResolution.filePath),
    range
  };
}

export async function resolveDeclaredMemberDefinitionAcrossFiles(
  context: ResolveContext,
  objectType: AnalysisType,
  memberName: string,
  _preferredAmbientReceiverFilePath?: string | null
): Promise<Location | null> {
  const structuralMember = parseObjectTypeMemberInfo(typeToString(objectType), memberName);
  const receiverTypeNames = receiverTypeNamesForMember(objectType, memberName);
  const objectTypeName = objectType instanceof ArrayType
    ? `Array<${typeToString(objectType.elementType)}>`
    : typeToString(objectType);

  for (const receiverTypeName of receiverTypeNames) {
    const location = await resolveDeclaredMemberDefinitionForReceiverType(
      context,
      objectTypeName,
      memberName,
      receiverTypeName,
      _preferredAmbientReceiverFilePath ?? undefined
    );
    if (location) {
      return location;
    }
  }

  if (structuralMember && objectType instanceof NamedType) {
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
      if (!(statement instanceof ImportStatement)) {
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
        if (!declaration || !(declaration instanceof TypeAliasStatement)) {
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
