import { AnalysisTypeKind } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
import type { Identifier, MemberExpression, Statement } from "compiler/ast/ast";
import { typeToString } from "compiler/analysis/types";
import { nodeRange } from "./ranges";
import { pathToUri } from "./importFixes";
import {
  ambientDeclarationLocationForSymbol,
  collectAmbientFunctionStatements,
  findAmbientNamespaceLocation,
  findAmbientNamespaceMemberRange,
  findAmbientModuleReceiverCandidates,
  findAmbientNamedExportRange,
  findImportForSymbolNode,
  type ResolveContext
} from "./crossFileContext";
import { buildFunctionTypeFromStatement } from "./importedDeclarations";
import { nodeBuiltinSpecifierCandidates } from "compiler/moduleResolution";
import type { Location } from "vscode-languageserver/node.js";

export function findAmbientImportedOverloadRange(
  context: ResolveContext,
  declarations: readonly Statement[],
  importedName: string
) {
  const selectedResolution = context.session.analysis?.getSelectedCallResolutionAt(context.line, context.character);
  if (!selectedResolution) {
    return null;
  }
  const overloadDeclarations = collectAmbientFunctionStatements(declarations, importedName);
  const indexedDeclaration = overloadDeclarations[selectedResolution.overloadIndex];
  if (indexedDeclaration) {
    return nodeRange(indexedDeclaration.name);
  }
  const selectedSignature = typeToString(selectedResolution.overload);
  for (const declaration of overloadDeclarations) {
    const declarationType = buildFunctionTypeFromStatement(declaration);
    if (declarationType.kind !== AnalysisTypeKind.Function) {
      continue;
    }
    if (typeToString(declarationType) === selectedSignature) {
      return nodeRange(declaration.name);
    }
  }
  return null;
}

export function resolveAmbientReceiverDeclarationFilePath(
  context: ResolveContext,
  symbolNode: unknown,
  symbolName: string
): string | null {
  return ambientDeclarationLocationForSymbol(context.session, symbolNode, symbolName)?.filePath ?? null;
}

export async function resolveAmbientImportedSymbolDefinition(
  context: ResolveContext
): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const symbolAt =
    context.session.analysis.getSymbolAt(context.line, context.character) ??
    context.session.analysis.getOperatorSymbolAt(context.line, context.character);
  if (!symbolAt) {
    return null;
  }

  const importBinding = findImportForSymbolNode(context.session.ast, symbolAt.symbol.node);
  if (!importBinding) {
    return null;
  }

  for (const moduleName of nodeBuiltinSpecifierCandidates(importBinding.from)) {
    const declarations = context.session.ambientModuleDeclarations?.get(moduleName);
    const location = context.session.ambientModuleLocations?.get(moduleName);
    if (!declarations || !location) {
      continue;
    }

    const overloadRange = findAmbientImportedOverloadRange(context, declarations, importBinding.name);
    if (overloadRange) {
      return {
        uri: pathToUri(location.filePath),
        range: overloadRange
      };
    }

    const range = findAmbientNamedExportRange(declarations, importBinding.name);
    if (!range) {
      continue;
    }

    return {
      uri: pathToUri(location.filePath),
      range
    };
  }

  return null;
}

export async function resolveAmbientModuleObjectMemberDefinition(
  context: ResolveContext,
  memberExpression: MemberExpression,
  memberName: string
): Promise<Location | null> {
  if (memberExpression.object.kind !== NodeKind.Identifier || !context.session.ast) {
    return null;
  }

  const receiverName = (memberExpression.object as Identifier).name;
  const moduleCandidates = findAmbientModuleReceiverCandidates(context.session.ast, receiverName);
  if (!moduleCandidates) {
    const receiverLocation = findAmbientNamespaceLocation(context.session, receiverName);
    const declarations = receiverLocation?.filePath
      ? (context.session.ambientDeclarations ?? []).filter((statement) =>
          context.session.ambientDeclarationLocations?.get(statement)?.filePath === receiverLocation.filePath
        )
      : (context.session.ambientDeclarations ?? []);
    const range = findAmbientNamespaceMemberRange(declarations, receiverName, memberName);
    if (!range) {
      return null;
    }
    return {
      uri: pathToUri(receiverLocation?.filePath ?? ""),
      range
    };
  }

  for (const moduleName of moduleCandidates) {
    const declarations = context.session.ambientModuleDeclarations?.get(moduleName);
    const location = context.session.ambientModuleLocations?.get(moduleName);
    if (!declarations || !location) {
      continue;
    }

    const overloadRange = findAmbientImportedOverloadRange(context, declarations, memberName);
    if (overloadRange) {
      return {
        uri: pathToUri(location.filePath),
        range: overloadRange
      };
    }

    const range = findAmbientNamedExportRange(declarations, memberName);
    if (!range) {
      continue;
    }

    return {
      uri: pathToUri(location.filePath),
      range
    };
  }

  return null;
}
