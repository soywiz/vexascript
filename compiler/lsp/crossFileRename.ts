import { isDomRuntimeNode } from "compiler/runtime/domDeclarations";
import { isEcmaScriptRuntimeNode, isVexaScriptRuntimeNode } from "compiler/runtime/ecmascriptDeclarations";
import type { PrepareRenameResult, WorkspaceEdit } from "vscode-languageserver/node.js";
import {
  ambientDeclarationLocationForSymbol,
  localRenameWorkspaceEdit,
  resolveCanonicalSymbol,
  VIRTUAL_DOM_DECLARATION_FILE_PATH,
  VIRTUAL_ECMA_DECLARATION_FILE_PATH,
  VIRTUAL_VEXA_DECLARATION_FILE_PATH,
  type ResolveContext
} from "./crossFileContext";
import { resolveReferencesAcrossFiles } from "./crossFileReferences";
import { createPrepareRename } from "./navigation";

function isVirtualRuntimeFilePath(filePath: string): boolean {
  return (
    filePath === VIRTUAL_DOM_DECLARATION_FILE_PATH ||
    filePath === VIRTUAL_ECMA_DECLARATION_FILE_PATH ||
    filePath === VIRTUAL_VEXA_DECLARATION_FILE_PATH
  );
}

export function isNonRenameableSymbol(context: ResolveContext, symbol: { filePath: string } | null): boolean {
  if (symbol && isVirtualRuntimeFilePath(symbol.filePath)) {
    return true;
  }

  if (!context.session.analysis) {
    return false;
  }

  const symbolAt = context.session.analysis.getSymbolAt(context.line, context.character);
  if (!symbolAt) {
    return false;
  }

  if (
    isEcmaScriptRuntimeNode(symbolAt.symbol.node) ||
    isVexaScriptRuntimeNode(symbolAt.symbol.node) ||
    isDomRuntimeNode(symbolAt.symbol.node)
  ) {
    return true;
  }

  if (context.session.ast) {
    const ambientLocation = ambientDeclarationLocationForSymbol(
      context.session,
      symbolAt.symbol.node,
      symbolAt.symbol.name
    );
    if (ambientLocation) {
      return true;
    }
  }

  return false;
}

export async function resolvePrepareRenameAcrossFiles(
  context: ResolveContext
): Promise<PrepareRenameResult | null> {
  const symbol = await resolveCanonicalSymbol(context);
  if (isNonRenameableSymbol(context, symbol)) {
    return null;
  }

  if (!context.session.analysis) {
    return null;
  }
  return createPrepareRename(
    context.session.analysis,
    context.line,
    context.character,
    context.session.ast ?? undefined
  );
}

export async function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): Promise<WorkspaceEdit | null> {
  const symbol = await resolveCanonicalSymbol(context);
  if (isNonRenameableSymbol(context, symbol)) {
    return null;
  }

  const locations = await resolveReferencesAcrossFiles(context, true);
  if (locations.length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }

  const changes: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> = {};
  for (const location of locations) {
    if (!changes[location.uri]) {
      changes[location.uri] = [];
    }
    changes[location.uri]?.push({
      range: location.range,
      newText: newName
    });
  }

  if (Object.keys(changes).length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }
  return { changes };
}
