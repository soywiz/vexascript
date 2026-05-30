import type {
  Hover,
  Location,
  PrepareRenameResult,
  WorkspaceEdit
} from "vscode-languageserver/node.js";
import type { Analysis } from "compiler/analysis/Analysis";

export function createDefinitionLocation(
  analysis: Analysis,
  uri: string,
  line: number,
  character: number
): Location | null {
  const definition = analysis.getDefinitionAt(line, character);
  if (!definition) {
    return null;
  }

  return {
    uri,
    range: definition.range
  };
}

export function createHover(
  analysis: Analysis,
  line: number,
  character: number
): Hover | null {
  const hover = analysis.getHoverAt(line, character);
  if (!hover) {
    return null;
  }

  return {
    contents: {
      kind: "plaintext",
      value: hover.contents
    },
    range: hover.range
  };
}

export function createPrepareRename(
  analysis: Analysis,
  line: number,
  character: number
): PrepareRenameResult | null {
  const symbolAt = analysis.getSymbolAt(line, character);
  if (!symbolAt) {
    return null;
  }
  if (symbolAt.symbol.declaredOffset < 0) {
    return null;
  }

  return {
    range: symbolAt.range,
    placeholder: symbolAt.symbol.name
  };
}

export function createRenameWorkspaceEdit(
  analysis: Analysis,
  uri: string,
  line: number,
  character: number,
  newName: string
): WorkspaceEdit | null {
  const ranges = analysis.getRenameRangesAt(line, character);
  if (ranges.length === 0) {
    return null;
  }

  return {
    changes: {
      [uri]: ranges.map((range) => ({
        range,
        newText: newName
      }))
    }
  };
}

export function createReferences(
  analysis: Analysis,
  uri: string,
  line: number,
  character: number,
  includeDeclaration: boolean
): Location[] {
  const ranges = analysis.getReferenceRangesAt(line, character, includeDeclaration);
  return ranges.map((range) => ({
    uri,
    range
  }));
}
