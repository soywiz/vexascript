import type { FunctionParameter } from "compiler/ast/ast";
import type { Range } from "vscode-languageserver/node.js";
import { offsetToPosition } from "./ranges";

function rangeAtOffset(text: string, offset: number): Range {
  const position = offsetToPosition(text, offset);
  return { start: position, end: position };
}

export function typeInsertionOffsetForParameter(parameter: FunctionParameter, text: string): number | null {
  const nameEnd = parameter.name.lastToken?.range.end.offset;
  if (nameEnd === undefined) {
    return null;
  }
  if (parameter.optional && text[nameEnd] === "?") {
    return nameEnd + 1;
  }
  return nameEnd;
}

export function buildParameterTypeEdit(
  parameter: FunctionParameter,
  text: string,
  typeName: string
): { range: Range; newText: string } | null {
  if (parameter.typeAnnotation?.firstToken && parameter.typeAnnotation.lastToken) {
    return {
      range: {
        start: {
          line: parameter.typeAnnotation.firstToken.range.start.line,
          character: parameter.typeAnnotation.firstToken.range.start.column
        },
        end: {
          line: parameter.typeAnnotation.lastToken.range.end.line,
          character: parameter.typeAnnotation.lastToken.range.end.column
        }
      },
      newText: typeName
    };
  }

  const insertionOffset = typeInsertionOffsetForParameter(parameter, text);
  if (insertionOffset === null) {
    return null;
  }
  return {
    range: rangeAtOffset(text, insertionOffset),
    newText: `: ${typeName}`
  };
}
