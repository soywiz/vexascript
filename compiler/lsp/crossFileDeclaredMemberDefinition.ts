import { NodeKind } from "compiler/ast/ast";
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
import { findNodeModuleMemberLocation } from "./nodeModulesTypings";

function pushReceiverTypeName(names: string[], seen: Set<string>, name: string) {
  if (seen.has(name)) {
    return;
  }
  seen.add(name);
  names.push(name);
}

function receiverTypeNamesForObjectType(objectType: AnalysisType): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (type: AnalysisType) => {
    if (type.kind === "array") {
      pushReceiverTypeName(names, seen, "Array");
      return;
    }
    if ((type.kind === "named" || type.kind === "builtin") && type.name === "int") {
      pushReceiverTypeName(names, seen, "int");
      pushReceiverTypeName(names, seen, "number");
      return;
    }
    if (type.kind === "named" || type.kind === "builtin") {
      pushReceiverTypeName(names, seen, type.name);
      return;
    }
    if (type.kind === "union" || type.kind === "intersection") {
      for (const memberType of type.types) {
        visit(memberType);
      }
    }
  };

  visit(objectType);
  return names;
}

async function resolveImportedNodeModuleMemberDefinition(
  context: ResolveContext,
  typeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  for (const statement of context.session.ast.body) {
    if (statement.kind !== NodeKind.ImportStatement) {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const from = importStatement.from.value;
    if (from.startsWith(".") || from.startsWith("/")) {
      continue;
    }
    const location = await findNodeModuleMemberLocation(
      currentFilePath,
      from,
      typeName,
      memberName,
      context.vfs ? { vfs: context.vfs } : {}
    );
    if (location) {
      return {
        uri: pathToUri(location.typingsPath),
        range: location.range
      };
    }
  }

  return null;
}

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
      const nodeModuleLocation = await resolveImportedNodeModuleMemberDefinition(
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
    const fallbackClassResolution = primaryResolution.declaration.kind === NodeKind.ClassStatement
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
    const fallbackInterfaceResolution = primaryResolution.declaration.kind === NodeKind.InterfaceStatement
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
    const classMemberDeclaration = primaryResolution.declaration.kind === NodeKind.ClassStatement
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
      ) ?? (classMemberDeclaration.declaration.kind === NodeKind.InterfaceStatement
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

    const interfaceMemberDeclaration = primaryResolution.declaration.kind === NodeKind.InterfaceStatement
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
  const receiverTypeNames = receiverTypeNamesForObjectType(objectType);
  const objectTypeName = objectType.kind === "array"
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
      if (statement.kind !== NodeKind.ImportStatement) {
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
        if (!declaration || declaration.kind !== NodeKind.TypeAliasStatement) {
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
