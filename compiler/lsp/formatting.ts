import { format as formatSource } from "compiler/runtime/tooling";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

function getDocumentEndPosition(text: string): LspPosition {
  if (text.length === 0) {
    return { line: 0, character: 0 };
  }

  const lines = text.split("\n");
  const lastLineIndex = lines.length - 1;
  return {
    line: lastLineIndex,
    character: lines[lastLineIndex].length
  };
}

export function createFullDocumentFormatEdit(source: string): LspTextEdit {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: getDocumentEndPosition(source)
    },
    newText: formatSource(source)
  };
}
