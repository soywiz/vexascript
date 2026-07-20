import { NodeKind, type Node } from "compiler/ast/ast";
import { AnalysisTypeKind, namedType } from "compiler/analysis/types";
import type { ReceiverLambdaInfo } from "compiler/analysis/model";
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
import {
  resolveInScopeExtensionMemberDeclarationAcrossFiles,
  resolveNodeModulesMemberDefinition
} from "./crossFileMemberDefinitionSources";

export function findEnclosingReceiverTypeName(
  ast: Program,
  line: number,
  character: number,
  receiverLambdas: ReadonlyMap<Node, ReceiverLambdaInfo> = new Map()
): string | null {
  let nearestReceiver: { name: string; width: number } | null = null;
  for (const [node, info] of receiverLambdas) {
    const range = nodeRange(node);
    if (!range) continue;
    const afterStart = line > range.start.line ||
      (line === range.start.line && character >= range.start.character);
    const beforeEnd = line < range.end.line ||
      (line === range.end.line && character <= range.end.character);
    if (!afterStart || !beforeEnd) continue;
    const name = info.receiverType.kind === AnalysisTypeKind.Named ||
      info.receiverType.kind === AnalysisTypeKind.Builtin
      ? info.receiverType.name
      : info.receiverType.kind === AnalysisTypeKind.Array || info.receiverType.kind === AnalysisTypeKind.Tuple
        ? "Array"
        : null;
    if (!name) continue;
    const width = (node.lastToken?.range.end.offset ?? Number.MAX_SAFE_INTEGER) -
      (node.firstToken?.range.start.offset ?? 0);
    if (!nearestReceiver || width < nearestReceiver.width) {
      nearestReceiver = { name, width };
    }
  }
  if (nearestReceiver) return nearestReceiver.name;

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
    context.character,
    context.session.analysis.getReceiverLambdas()
  );
  if (!receiverTypeName) {
    return null;
  }

  const memberName = symbolAt.symbol.name;
  if (symbolAt.symbol.implicitReceiverExtensionReceiver) {
    const extensionDeclaration = await resolveInScopeExtensionMemberDeclarationAcrossFiles(
      context,
      namedType(symbolAt.symbol.implicitReceiverExtensionReceiver),
      memberName
    );
    if (extensionDeclaration) {
      const range = nodeRange(extensionDeclaration.declaration.name);
      if (range) {
        return { uri: pathToUri(extensionDeclaration.filePath), range };
      }
    }
  }
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
  return resolveNodeModulesMemberDefinition(
    context,
    resolvedReceiverTypeName,
    memberName
  );
}
