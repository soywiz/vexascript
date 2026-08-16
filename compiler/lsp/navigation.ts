import { Identifier } from "compiler/ast/ast";
import type { AnnotationStatement, FunctionParameter, Program, TypeAliasStatement } from "compiler/ast/ast";
import type {
  Hover,
  Location,
  MarkupContent,
  PrepareRenameResult,
  WorkspaceEdit
} from "vscode-languageserver/node.js";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type { Analysis, AnalysisRange } from "compiler/analysis/Analysis";
import { declarationIndexForStatements } from "compiler/analysis/declarationIndex";
import { programAnnotationApplications } from "compiler/ast/annotations";
import {
  findDocumentationParameterReference,
  findDocumentationReferenceRangesForIdentifier,
  readDocumentationForSymbol
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
    contents: createAnalysisHoverContents(
      parameterHoverValue(reference.parameter, reference.referenceName)
    ),
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
  for (const annotation of programAnnotationApplications(program)) {
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
  return null;
}

function annotationHoverValue(annotation: AnnotationStatement): string {
  const parameters = annotation.parameters.map((parameter) => {
    const prefix =
      parameter.accessModifier === "public" && parameter.isReadonly === true
        ? "const "
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
  if (!program || !symbolAt || symbolAt.symbol.kind !== "parameter" || !(symbolAt.symbol.node instanceof Identifier)) {
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
  const target = resolveCursorTarget(analysis, line, character, program);
  if (!target) {
    return [];
  }
  const parameterIdentifier = parameterIdentifierFromCursor(analysis, program, target.line, target.character);
  if (!parameterIdentifier) {
    return analysis.getReferenceRangesAt(target.line, target.character, includeDeclaration);
  }

  const baseRanges = analysis.getReferenceRangesAt(
    parameterIdentifier.firstToken?.range.start.line ?? target.line,
    parameterIdentifier.firstToken?.range.start.column ?? target.character,
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

export type CursorTarget =
  | { kind: "documentationParameter"; line: number; character: number; reference: NonNullable<ReturnType<typeof findDocumentationParameterReference>> }
  | { kind: "annotation"; line: number; character: number; reference: NonNullable<ReturnType<typeof annotationReferenceAt>> }
  | { kind: "analysis"; line: number; character: number; symbolAt: ReturnType<Analysis["getSymbolAt"]>; definition: ReturnType<Analysis["getDefinitionAt"]>; hover: ReturnType<Analysis["getHoverAt"]> };

export function candidateCharacters(character: number): number[] {
  const candidates = [character];
  if (character > 0) {
    candidates.push(character - 1);
  }
  candidates.push(character + 1);
  return candidates;
}

export function resolveCursorTarget(
  analysis: Analysis,
  line: number,
  character: number,
  program?: Program
): CursorTarget | null {
  for (const candidate of candidateCharacters(character)) {
    const documentationReference = program
      ? findDocumentationParameterReference(program, line, candidate)
      : null;
    if (documentationReference) {
      return { kind: "documentationParameter", line, character: candidate, reference: documentationReference };
    }

    const annotationReference = annotationReferenceAt(program, line, candidate);
    if (annotationReference) {
      return { kind: "annotation", line, character: candidate, reference: annotationReference };
    }

    const symbolAt = analysis.getSymbolAt(line, candidate);
    const definition = analysis.getDefinitionAt(line, candidate);
    const hover = analysis.getHoverAt(line, candidate);
    if (symbolAt || definition || hover) {
      return {
        kind: "analysis",
        line,
        character: candidate,
        symbolAt,
        definition,
        hover
      };
    }
  }
  return null;
}

export function createDefinitionLocation(
  analysis: Analysis,
  uri: string,
  line: number,
  character: number,
  program?: Program
): Location | null {
  const target = resolveCursorTarget(analysis, line, character, program);
  if (!target) {
    return null;
  }
  if (target.kind === "documentationParameter") {
    return definitionFromDocumentationReference(uri, program, target.line, target.character);
  }
  if (target.kind === "annotation") {
    return {
      uri,
      range: target.reference.declarationRange
    };
  }
  if (!target.definition) {
    return null;
  }

  return {
    uri,
    range: target.definition.range
  };
}

function objectPropertySeparatorIndex(text: string): number {
  let quote: string | null = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  let angles = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "<") angles += 1;
    else if (character === ">") angles = Math.max(0, angles - 1);
    else if (character === ":" && parentheses === 0 && brackets === 0 && angles === 0) return index;
  }
  return -1;
}

function formatTypeTextForHover(typeText: string): string {
  const lines: string[] = [];
  let line = "";
  let indent = 0;
  const delimiters: string[] = [];
  let quote: string | null = null;
  let escaped = false;

  const trimLineEnd = (): void => {
    line = line.replace(/\s+$/, "");
  };
  const writeIndent = (): void => {
    if (line.length === 0) line = "  ".repeat(indent);
  };
  const nextLine = (): void => {
    trimLineEnd();
    lines.push(line);
    line = "";
  };

  for (let index = 0; index < typeText.length; index += 1) {
    const character = typeText[index]!;
    if (quote) {
      line += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      writeIndent();
      line += character;
      quote = character;
      continue;
    }
    if (character === "{") {
      writeIndent();
      trimLineEnd();
      const previousCharacter = line.at(-1);
      line += line.trim().length === 0 || previousCharacter === "<" || previousCharacter === "(" || previousCharacter === "["
        ? "{"
        : " {";
      delimiters.push(character);
      indent += 1;
      nextLine();
      continue;
    }
    if (character === "}") {
      trimLineEnd();
      if (line.trim().length > 0) {
        if (!line.endsWith(";")) line += ";";
        nextLine();
      }
      indent = Math.max(0, indent - 1);
      line = `${"  ".repeat(indent)}}`;
      if (delimiters.at(-1) === "{") delimiters.pop();
      continue;
    }
    if (character === "(" || character === "[" || character === "<") {
      writeIndent();
      line += character;
      delimiters.push(character);
      continue;
    }
    if (character === ")" || character === "]" || character === ">") {
      writeIndent();
      line += character;
      const expectedOpening = character === ")" ? "(" : character === "]" ? "[" : "<";
      if (delimiters.at(-1) === expectedOpening) delimiters.pop();
      continue;
    }
    if ((character === "," || character === ";") && delimiters.at(-1) === "{") {
      trimLineEnd();
      if (!line.endsWith(";")) line += ";";
      nextLine();
      continue;
    }
    if (character === ",") {
      trimLineEnd();
      line += ", ";
      while (/\s/.test(typeText[index + 1] ?? "")) index += 1;
      continue;
    }
    if (character === "?") {
      const remaining = typeText.slice(index + 1);
      const nextNonWhitespace = remaining.match(/\S/)?.[0];
      if (nextNonWhitespace && [",", ";", "}", ")", "]", ">"].includes(nextNonWhitespace)) {
        if (delimiters.at(-1) === "{") {
          const separatorIndex = objectPropertySeparatorIndex(line);
          const propertyName = separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : "";
          if (propertyName && !propertyName.startsWith("[")) {
            line = `${line.slice(0, separatorIndex)}?:${line.slice(separatorIndex + 1)}`;
            continue;
          }
        }
        line += " | undefined";
        continue;
      }
    }
    if (/\s/.test(character)) {
      if (line.length > 0 && !line.endsWith(" ")) line += " ";
      continue;
    }
    writeIndent();
    line += character;
  }

  trimLineEnd();
  if (line.length > 0) lines.push(line);
  return lines.join("\n").replace(/\[(string|number|symbol)\]:/g, "[key: $1]:");
}

export function createTypescriptHoverContents(declaration: string, documentation?: string): MarkupContent {
  const code = `\`\`\`typescript\n${declaration}\n\`\`\``;
  return {
    kind: "markdown",
    value: documentation ? `${code}\n\n${documentation}` : code
  };
}

export function createTypedHoverContents(
  label: string,
  typeLabel: string,
  documentation?: string
): MarkupContent {
  return createTypescriptHoverContents(
    `${label}: ${formatTypeTextForHover(typeLabel)}`,
    documentation
  );
}

function createAnalysisHoverContents(hoverText: string, documentation?: string): MarkupContent {
  const separatorIndex = hoverText.indexOf(": ");
  if (separatorIndex < 0) {
    return createTypescriptHoverContents(hoverText, documentation);
  }
  return createTypedHoverContents(
    hoverText.slice(0, separatorIndex),
    hoverText.slice(separatorIndex + 2),
    documentation
  );
}

export function createTypeAliasHoverContentsFromDeclaration(
  typeAlias: TypeAliasStatement,
  name: string,
  typeLabel: string,
  documentation?: string
): MarkupContent {
  const typeParameters = typeAlias.typeParameters?.length
    ? `<${typeAlias.typeParameters.map((parameter) => parameter.name.name).join(", ")}>`
    : "";
  const declaration = `type ${name}${typeParameters} = ${formatTypeTextForHover(typeLabel)}`;
  return createTypescriptHoverContents(declaration, documentation);
}

export function createTypeAliasHoverContents(
  program: Program | undefined,
  name: string,
  typeLabel: string,
  documentation?: string
): MarkupContent | null {
  const typeAlias = program
    ? declarationIndexForStatements(program.body).typeAliases.find((candidate) => candidate.name.name === name)
    : undefined;
  return typeAlias
    ? createTypeAliasHoverContentsFromDeclaration(typeAlias, name, typeLabel, documentation)
    : null;
}

export function createHover(
  analysis: Analysis,
  line: number,
  character: number,
  program?: Program,
  options: {
    externalDeclarations?: readonly import("compiler/ast/ast").Statement[] | undefined;
    ambientModuleDeclarations?: ReadonlyMap<string, import("compiler/ast/ast").Statement[]> | undefined;
    importedSymbols?: ReadonlyMap<string, import("compiler/importedSymbols").ImportedSymbolResolution> | undefined;
  } = {}
): Hover | null {
  const target = resolveCursorTarget(analysis, line, character, program);
  if (!target) {
    return null;
  }
  if (target.kind === "documentationParameter") {
    return hoverFromDocumentationReference(program, target.line, target.character);
  }
  if (target.kind === "annotation") {
    return {
      contents: createTypescriptHoverContents(annotationHoverValue(target.reference.declaration)),
      range: target.reference.referenceRange
    };
  }
  if (!target.hover) {
    return null;
  }

  const hoverTypeText = target.hover.contents;
  const symbolNode = target.symbolAt?.symbol.node;
  const documentation =
    program && symbolNode instanceof Identifier
      ? readDocumentationForSymbol(program, symbolNode as Identifier, options)
      : undefined;
  const typeAliasContents = target.symbolAt
    ? createTypeAliasHoverContents(
        program,
        target.symbolAt.symbol.name,
        target.symbolAt.symbol.valueType,
        documentation
      )
    : null;
  if (typeAliasContents) {
    return {
      contents: typeAliasContents,
      range: target.hover.range
    };
  }
  if (target.symbolAt?.symbol.kind === "variable") {
    const importedResolution = options.importedSymbols?.get(target.symbolAt.symbol.name);
    const isReadonly = importedResolution !== undefined || target.symbolAt.symbol.isReadonly === true;
    const declarationKeyword = isReadonly ? "const" : "let";
    return {
      contents: createTypescriptHoverContents(
        `${declarationKeyword} ${target.symbolAt.symbol.name}: ${formatTypeTextForHover(target.symbolAt.symbol.valueType)}`,
        documentation
      ),
      range: target.hover.range
    };
  }
  return {
    contents: createAnalysisHoverContents(hoverTypeText, documentation),
    range: target.hover.range
  };
}

export function createPrepareRename(
  analysis: Analysis,
  line: number,
  character: number,
  program?: Program
): PrepareRenameResult | null {
  const target = resolveCursorTarget(analysis, line, character, program);
  if (!target) {
    return null;
  }
  if (target.kind === "documentationParameter") {
    const documentationReference = hoverFromDocumentationReference(program, target.line, target.character);
    const parameterIdentifier = parameterIdentifierFromCursor(analysis, program, target.line, target.character);
    if (!documentationReference || !parameterIdentifier) {
      return null;
    }
    return {
      range: documentationReference.range,
      placeholder: parameterIdentifier.name
    };
  }
  if (target.kind === "annotation" || !target.symbolAt) {
    return null;
  }

  const symbolAt = target.symbolAt;
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
