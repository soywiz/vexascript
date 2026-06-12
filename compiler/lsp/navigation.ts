import type {
  Hover,
  Location,
  MarkupContent,
  PrepareRenameResult,
  WorkspaceEdit
} from "vscode-languageserver/node.js";
import type { AnnotationStatement, FunctionParameter, Identifier, Program } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type { Analysis, AnalysisRange } from "compiler/analysis/Analysis";
import { declarationIndexForStatements } from "compiler/analysis/declarationIndex";
import {
  findDocumentationParameterReference,
  findDocumentationReferenceRangesForIdentifier
} from "./documentation";
import {
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";

function parameterHoverValue(parameter: FunctionParameter, referenceName: string): string {
  const typeLabel = parameter.typeAnnotation?.name ?? "unknown";
  return `parameter ${referenceName}: ${typeLabel}`;
}

function definitionFromDocumentationReference(
  uri: string,
  program: Program | undefined,
  line: number,
  character: number
): Location | null {
  if (!program) {
    return null;
  }
  const reference = findDocumentationParameterReference(program, line, character);
  const identifier = reference
    ? bindingIdentifiers(reference.parameter.name).find((candidate) => candidate.name === reference.referenceName)
    : null;
  if (!identifier?.firstToken || !identifier.lastToken) {
    return null;
  }
  return {
    uri,
    range: {
      start: {
        line: identifier.firstToken.range.start.line,
        character: identifier.firstToken.range.start.column
      },
      end: {
        line: identifier.lastToken.range.end.line,
        character: identifier.lastToken.range.end.column
      }
    }
  };
}

function hoverFromDocumentationReference(
  program: Program | undefined,
  line: number,
  character: number
): { contents: MarkupContent; range: NonNullable<Hover["range"]> } | null {
  if (!program) {
    return null;
  }
  const reference = findDocumentationParameterReference(program, line, character);
  if (!reference) {
    return null;
  }
  return {
    contents: {
      kind: "plaintext",
      value: parameterHoverValue(reference.parameter, reference.referenceName)
    },
    range: {
      start: {
        line: reference.referenceRange.start.line,
        character: reference.referenceRange.start.column
      },
      end: {
        line: reference.referenceRange.end.line,
        character: reference.referenceRange.end.column
      }
    }
  };
}

function annotationStatementByName(program: Program | undefined, name: string): AnnotationStatement | null {
  if (program) {
    for (const statement of declarationIndexForStatements(program.body).annotations) {
      if (statement.name.name === name) {
        return statement;
      }
    }
  }
  for (const statement of declarationIndexForStatements(getVexaScriptRuntimeProgram().body).annotations) {
    if (statement.name.name === name) {
      return statement;
    }
  }
  for (const statement of declarationIndexForStatements(getEcmaScriptRuntimeProgram().body).annotations) {
    if (statement.name.name === name) {
      return statement;
    }
  }
  return null;
}

function annotationReferenceAt(
  program: Program | undefined,
  line: number,
  character: number
): {
  declaration: AnnotationStatement;
  referenceRange: NonNullable<Hover["range"]>;
  declarationRange: NonNullable<Location["range"]>;
} | null {
  if (!program) {
    return null;
  }
  for (const statement of program.body) {
    for (const annotation of statement.annotations ?? []) {
      const first = annotation.name.firstToken;
      const last = annotation.name.lastToken;
      if (!first || !last) {
        continue;
      }
      const contains =
        (line > first.range.start.line || (line === first.range.start.line && character >= first.range.start.column)) &&
        (line < last.range.end.line || (line === last.range.end.line && character <= last.range.end.column));
      if (!contains) {
        continue;
      }
      const declaration = annotationStatementByName(program, annotation.name.name);
      if (!declaration?.name.firstToken || !declaration.name.lastToken) {
        return null;
      }
      return {
        declaration,
        referenceRange: {
          start: {
            line: first.range.start.line,
            character: first.range.start.column
          },
          end: {
            line: last.range.end.line,
            character: last.range.end.column
          }
        },
        declarationRange: {
          start: {
            line: declaration.name.firstToken.range.start.line,
            character: declaration.name.firstToken.range.start.column
          },
          end: {
            line: declaration.name.lastToken.range.end.line,
            character: declaration.name.lastToken.range.end.column
          }
        }
      };
    }
  }
  return null;
}

function annotationHoverValue(annotation: AnnotationStatement): string {
  const parameters = annotation.parameters.map((parameter) => {
    const prefix =
      parameter.accessModifier === "public" && parameter.readonly === true
        ? "val "
        : parameter.accessModifier === "public"
          ? "var "
          : "";
    const binding = bindingIdentifiers(parameter.name)[0]?.name ?? "unknown";
    return `${prefix}${binding}: ${parameter.typeAnnotation?.name ?? "unknown"}`;
  });
  return `annotation ${annotation.name.name}(${parameters.join(", ")})`;
}

function toAnalysisRange(range: {
  start: { line: number; column: number };
  end: { line: number; column: number };
}): AnalysisRange {
  return {
    start: {
      line: range.start.line,
      character: range.start.column
    },
    end: {
      line: range.end.line,
      character: range.end.column
    }
  };
}

function analysisRangeKey(range: AnalysisRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function parameterIdentifierFromCursor(
  analysis: Analysis,
  program: Program | undefined,
  line: number,
  character: number
): Identifier | null {
  const documentationReference = program
    ? findDocumentationParameterReference(program, line, character)
    : null;
  if (documentationReference) {
    return bindingIdentifiers(documentationReference.parameter.name).find((identifier) =>
      identifier.name === documentationReference.referenceName
    ) ?? null;
  }

  const symbolAt = analysis.getSymbolAt(line, character);
  if (!program || !symbolAt || symbolAt.symbol.kind !== "parameter" || symbolAt.symbol.node.kind !== "Identifier") {
    return null;
  }
  return symbolAt.symbol.node as Identifier;
}

function collectReferenceRanges(
  analysis: Analysis,
  line: number,
  character: number,
  includeDeclaration: boolean,
  program?: Program
): AnalysisRange[] {
  const parameterIdentifier = parameterIdentifierFromCursor(analysis, program, line, character);
  if (!parameterIdentifier) {
    return analysis.getReferenceRangesAt(line, character, includeDeclaration);
  }

  const baseRanges = analysis.getReferenceRangesAt(
    parameterIdentifier.firstToken?.range.start.line ?? line,
    parameterIdentifier.firstToken?.range.start.column ?? character,
    includeDeclaration
  );
  const documentationRanges = program
    ? findDocumentationReferenceRangesForIdentifier(program, parameterIdentifier).map(toAnalysisRange)
    : [];
  const merged: AnalysisRange[] = [];
  const seen = new Set<string>();
  for (const range of [...baseRanges, ...documentationRanges]) {
    const key = analysisRangeKey(range);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(range);
  }
  return merged;
}

export function createDefinitionLocation(
  analysis: Analysis,
  uri: string,
  line: number,
  character: number,
  program?: Program
): Location | null {
  const documentationReference = definitionFromDocumentationReference(uri, program, line, character);
  if (documentationReference) {
    return documentationReference;
  }
  const annotationReference = annotationReferenceAt(program, line, character);
  if (annotationReference) {
    return {
      uri,
      range: annotationReference.declarationRange
    };
  }
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
  character: number,
  program?: Program
): Hover | null {
  const documentationReference = hoverFromDocumentationReference(program, line, character);
  if (documentationReference) {
    return documentationReference;
  }
  const annotationReference = annotationReferenceAt(program, line, character);
  if (annotationReference) {
    return {
      contents: {
        kind: "plaintext",
        value: annotationHoverValue(annotationReference.declaration)
      },
      range: annotationReference.referenceRange
    };
  }
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
  character: number,
  program?: Program
): PrepareRenameResult | null {
  const documentationReference = hoverFromDocumentationReference(program, line, character);
  if (documentationReference) {
    const parameterIdentifier = parameterIdentifierFromCursor(analysis, program, line, character);
    if (!parameterIdentifier) {
      return null;
    }
    return {
      range: documentationReference.range,
      placeholder: parameterIdentifier.name
    };
  }

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
  newName: string,
  program?: Program
): WorkspaceEdit | null {
  const ranges = collectReferenceRanges(analysis, line, character, true, program);
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
  includeDeclaration: boolean,
  program?: Program
): Location[] {
  const ranges = collectReferenceRanges(analysis, line, character, includeDeclaration, program);
  return ranges.map((range) => ({
    uri,
    range
  }));
}
