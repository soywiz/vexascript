import { format as formatSource } from "compiler/runtime/tooling";
import { comparePosition } from "./ranges";

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
    character: (lines[lastLineIndex] ?? "").length
  };
}

function getLineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionToOffset(text: string, position: LspPosition): number {
  const lineStarts = getLineStartOffsets(text);
  const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
  const lineStart = lineStarts[line] ?? 0;
  const nextLineStart = (
    line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length + 1
  ) ?? text.length + 1;
  const lineEnd = Math.max(lineStart, nextLineStart - 1);
  return Math.max(lineStart, Math.min(lineStart + position.character, lineEnd));
}

function normalizeRange(range: LspRange): LspRange {
  if (comparePosition(range.start, range.end) <= 0) {
    return range;
  }
  return {
    start: range.end,
    end: range.start
  };
}

function getCommonIndent(text: string): string {
  const indents = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/)?.[0] ?? "");

  if (indents.length === 0) {
    return "";
  }

  return indents.reduce((common, indent) => {
    let index = 0;
    while (index < common.length && index < indent.length && common[index] === indent[index]) {
      index += 1;
    }
    return common.slice(0, index);
  });
}

function removeIndent(text: string, indent: string): string {
  if (indent.length === 0) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => line.startsWith(indent) ? line.slice(indent.length) : line)
    .join("\n");
}

function addIndent(text: string, indent: string): string {
  if (indent.length === 0 || text.length === 0) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => line.length > 0 ? `${indent}${line}` : line)
    .join("\n");
}

function ensureTrailingNewline(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) {
    return text;
  }
  return `${text}\n`;
}

export function createFullDocumentFormatEdit(source: string): LspTextEdit {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: getDocumentEndPosition(source)
    },
    newText: ensureTrailingNewline(formatSource(source))
  };
}

export function createRangeFormatEdit(source: string, range: LspRange): LspTextEdit {
  const normalizedRange = normalizeRange(range);
  const startOffset = positionToOffset(source, normalizedRange.start);
  const endOffset = positionToOffset(source, normalizedRange.end);
  const selectedText = source.slice(startOffset, endOffset);
  const commonIndent = getCommonIndent(selectedText);
  const selectedTextWithoutBaseIndent = removeIndent(selectedText, commonIndent);
  const shouldPreserveTrailingNewline = selectedText.endsWith("\n");
  const formattedSelection = addIndent(formatSource(selectedTextWithoutBaseIndent), commonIndent);
  const newText = shouldPreserveTrailingNewline
    ? `${formattedSelection}\n`
    : formattedSelection;

  return {
    range: normalizedRange,
    newText
  };
}
