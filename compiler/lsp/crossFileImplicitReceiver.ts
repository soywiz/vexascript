import { NodeKind } from "compiler/ast/ast";
import { boxedPrimitiveTypeName } from "compiler/analysis/typeNames";
import type {
  ExportStatement,
  FunctionStatement,
  Program,
  VarStatement
} from "compiler/ast/ast";
import type { Location } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveInterfaceMemberDeclaration
} from "./classResolver";
import {
  preferVirtualRuntimeDeclarationFilePath,
  type ResolveContext
} from "./crossFileContext";
import {
  classMemberDeclarationRangeByName,
  fallbackInterfaceMemberRangeInFile,
  resolveTypeDefinitionAcrossFiles
} from "./crossFileTypeResolution";
import { pathToUri } from "./importFixes";
import { nodeRange } from "./ranges";

export function findEnclosingReceiverTypeName(
  ast: Program,
  line: number,
  character: number
): string | null {
  for (const statement of ast.body) {
    let candidate: (FunctionStatement | VarStatement) | null = null;
    if (statement.kind === NodeKind.FunctionStatement || statement.kind === NodeKind.VarStatement) {
      candidate = statement as FunctionStatement | VarStatement;
    } else if (statement.kind === NodeKind.ExportStatement) {
      const decl = (statement as ExportStatement).declaration;
      if (decl && (decl.kind === NodeKind.FunctionStatement || decl.kind === NodeKind.VarStatement)) {
        candidate = decl as FunctionStatement | VarStatement;
      }
    }
    if (!candidate?.receiverType) {
      continue;
    }
    const range = nodeRange(candidate);
    if (!range) {
      continue;
    }
    const { start, end } = range;
    const afterStart =
      line > start.line || (line === start.line && character >= start.character);
    const beforeEnd =
      line < end.line || (line === end.line && character <= end.character);
    if (afterStart && beforeEnd) {
      return candidate.receiverType.name;
    }
  }
  return null;
}

export async function resolveImplicitReceiverMemberDefinition(
  context: ResolveContext
): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const symbolAt = context.session.analysis.getSymbolAt(context.line, context.character);
  if (!symbolAt || symbolAt.symbol.implicitReceiver !== true || symbolAt.symbol.implicitReceiverClassName) {
    return null;
  }

  const receiverTypeName = findEnclosingReceiverTypeName(
    context.session.ast,
    context.line,
    context.character
  );
  if (!receiverTypeName) {
    return null;
  }

  const memberName = symbolAt.symbol.name;
  const resolvedReceiverTypeName = boxedPrimitiveTypeName(receiverTypeName);
  const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedReceiverTypeName);
  if (!classResolution) {
    return null;
  }

  const resolverContext = {
    ast: context.session.ast,
    options: {
      uri: context.uri,
      sourceRoots: context.sourceRoots,
      ...(context.getSessionForFilePath ? { getSessionForFilePath: context.getSessionForFilePath } : {})
    },
    analysis: context.session.analysis,
    cache: createClassResolverCache()
  };

  const interfaceMemberDeclaration = classResolution.declaration.kind === NodeKind.InterfaceStatement
    ? await resolveInterfaceMemberDeclaration(
      { interfaceStatement: classResolution.declaration, filePath: classResolution.filePath },
      memberName,
      resolvedReceiverTypeName,
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
      memberOwner.kind === NodeKind.InterfaceStatement
        ? await fallbackInterfaceMemberRangeInFile(context, memberFilePath, memberOwner.name.name, memberName)
        : null
    );

  if (range) {
    return { uri: pathToUri(memberFilePath), range };
  }
  return null;
}
