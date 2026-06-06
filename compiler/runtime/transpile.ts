import {
  compileSource,
  formatParseIssue,
  formatSemanticIssue
} from "compiler/pipeline/compile";
import { basename } from "node:path";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";
import { emitProgramStatements } from "./emitter";
import { lowerProgram } from "./lowering";
import type { Program, Statement } from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";

export interface TranspileResult {
  code: string;
  warnings: string[];
  errors: string[];
  sourceMap?: string;
}

export type TranspileTarget = "conservative" | "optimized";

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

function ensureTrailingSemicolonPreservingLines(code: string): string {
  if (code.trim().length === 0) {
    return "";
  }

  const lines = code.split("\n");
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && (lines[lastNonEmpty] ?? "").trim().length === 0) {
    lastNonEmpty -= 1;
  }
  if (lastNonEmpty < 0) {
    return "";
  }

  const lastLine = lines[lastNonEmpty] ?? "";
  const trimmedLastLine = lastLine.trimEnd();
  lines[lastNonEmpty] = /[;{}]$/.test(trimmedLastLine) ? trimmedLastLine : `${trimmedLastLine};`;
  return lines.join("\n");
}

interface SourceMapV3 {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

export interface TranspileOptions {
  sourceFilePath?: string;
  outputFilePath?: string;
  target?: TranspileTarget;
  preserveSourceLineOffsets?: boolean;
  /**
   * Top-level declarations imported from other files (classes, interfaces,
   * enums, type aliases, extension methods/operators/properties and functions).
   * They are fed to the analyzer for cross-file name/member/operator resolution
   * and to the emitter as additional context so calls, operators and extension
   * properties referencing imported declarations lower correctly.
   */
  externalDeclarations?: Statement[];
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toVlqSigned(value: number): number {
  if (value < 0) {
    return ((-value) << 1) + 1;
  }
  return value << 1;
}

function encodeVlq(value: number): string {
  let vlq = toVlqSigned(value);
  let encoded = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 32;
    }
    encoded += BASE64_DIGITS[digit] ?? "";
  } while (vlq > 0);
  return encoded;
}

function createLineStartMappingsForSourceLines(sourceLinesByGeneratedLine: number[]): string {
  if (sourceLinesByGeneratedLine.length <= 0) {
    return "";
  }

  let mappings = "";
  let previousSourceLine = 0;

  for (let generatedLine = 0; generatedLine < sourceLinesByGeneratedLine.length; generatedLine += 1) {
    if (generatedLine > 0) {
      mappings += ";";
    }
    const sourceLine = Math.max(0, sourceLinesByGeneratedLine[generatedLine] ?? 0);
    const sourceLineDelta = sourceLine - previousSourceLine;
    mappings += `${encodeVlq(0)}${encodeVlq(0)}${encodeVlq(sourceLineDelta)}${encodeVlq(0)}`;
    previousSourceLine = sourceLine;
  }

  return mappings;
}

function sourceLineRangeForStatement(statement: Statement): { start: number; end: number } {
  const start = statement.firstToken?.range.start.line ?? 0;
  const end = statement.lastToken?.range.end.line ?? start;
  return { start, end: Math.max(start, end) };
}

function sourceLinesForEmittedStatement(statement: Statement, emittedStatement: string): number[] {
  const lineCount = emittedStatement.length === 0 ? 0 : emittedStatement.split("\n").length;
  if (lineCount <= 0) {
    return [];
  }

  const { start, end } = sourceLineRangeForStatement(statement);
  const span = end - start;
  const lines: number[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(start + Math.min(i, span));
  }
  return lines;
}

function emitProgramWithLineMap(
  program: Program,
  expressionTypes: ReadonlyMap<Node, AnalysisType>,
  implicitReceiverIdentifiers: ReadonlySet<Node>,
  autoAwaitExpressions: ReadonlySet<Node>,
  contextProgram: Program = program
): { emitted: string; sourceLinesByGeneratedLine: number[] } {
  const sourceLinesByGeneratedLine: number[] = [];
  const emittedStatements = emitProgramStatements(program, expressionTypes, contextProgram, implicitReceiverIdentifiers, autoAwaitExpressions);

  let emittedIndex = 0;
  for (const statement of program.body) {
    const candidate = emittedStatements[emittedIndex];
    if (!candidate) {
      break;
    }
    const emittedRaw = emitProgramStatements({ ...program, body: [statement] }, expressionTypes, contextProgram, implicitReceiverIdentifiers, autoAwaitExpressions);
    const emittedStatement = emittedRaw.length > 0 ? emittedRaw[0]! : "";
    if (emittedStatement.trim().length <= 0) {
      continue;
    }
    sourceLinesByGeneratedLine.push(...sourceLinesForEmittedStatement(statement, emittedStatement));
    emittedIndex += 1;
  }

  const emitted = emittedStatements.join("\n");
  return { emitted, sourceLinesByGeneratedLine };
}

function emitProgramWithSourceLineOffsets(
  program: Program,
  expressionTypes: ReadonlyMap<Node, AnalysisType>,
  implicitReceiverIdentifiers: ReadonlySet<Node>,
  autoAwaitExpressions: ReadonlySet<Node>,
  contextProgram: Program = program
): string {
  const lines: string[] = [];
  let generatedLine = 0;

  for (const statement of program.body) {
    const emittedSingle = emitProgramStatements({ ...program, body: [statement] }, expressionTypes, contextProgram, implicitReceiverIdentifiers, autoAwaitExpressions);
    if (emittedSingle.length <= 0) {
      continue;
    }

    const sourceStartLine = statement.firstToken?.range.start.line ?? generatedLine;
    while (generatedLine < sourceStartLine) {
      lines.push("");
      generatedLine += 1;
    }

    const emittedStatement = emittedSingle[0] ?? "";
    const emittedLines = emittedStatement.split("\n");
    lines.push(...emittedLines);
    generatedLine += emittedLines.length;
  }

  return lines.join("\n");
}

function createSourceMap(
  source: string,
  emittedCode: string,
  sourceLinesByGeneratedLine: number[],
  options: TranspileOptions
): string {
  const sourceFileName = basename(options.sourceFilePath ?? "input.my");
  const outputFileName = basename(options.outputFilePath ?? "output.js");

  const map: SourceMapV3 = {
    version: 3,
    file: outputFileName,
    sources: [sourceFileName],
    sourcesContent: [source],
    names: [],
    mappings: createLineStartMappingsForSourceLines(
      emittedCode.length === 0 ? [] : sourceLinesByGeneratedLine
    )
  };

  return JSON.stringify(map);
}

export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  const externalDeclarations = options.externalDeclarations ?? [];
  const artifacts = compileSource(source, {}, { externalDeclarations });
  const errors: string[] = [];

  if (artifacts.tokenizeError) {
    errors.push(
      formatMessageAtSourceRange(artifacts.tokenizeError.message, artifacts.tokenizeError.range)
    );
  }
  if (artifacts.fatalError) {
    errors.push(artifacts.fatalError);
  }
  for (const issue of artifacts.parserIssues) {
    errors.push(formatParseIssue(issue));
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors };
  }

  for (const issue of artifacts.semanticIssues) {
    errors.push(formatSemanticIssue(issue));
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors };
  }

  if (!artifacts.ast || !artifacts.analysis) {
    return {
      code: "",
      warnings: [],
      errors: ["Internal error: compilation artifacts are incomplete"]
    };
  }

  const target = options.target ?? "optimized";
  const programForEmission = target === "conservative" ? artifacts.ast : lowerProgram(artifacts.ast);
  // Emission collects classes, operator overloads and extension properties from
  // a context program. Including the imported declarations lets the emitter
  // lower calls (`Point(...)` -> `new Point(...)`), operators and extension
  // properties that resolve to cross-file declarations.
  const contextProgram: Program = externalDeclarations.length > 0
    ? { ...programForEmission, body: [...externalDeclarations, ...programForEmission.body] }
    : programForEmission;
  const expressionTypes = artifacts.analysis.getExpressionTypes();
  const implicitReceiverIdentifiers = artifacts.analysis.getImplicitReceiverIdentifiers();
  const autoAwaitExpressions = artifacts.analysis.getAutoAwaitExpressions();
  const { emitted, sourceLinesByGeneratedLine } = emitProgramWithLineMap(
    programForEmission,
    expressionTypes,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    contextProgram
  );
  const emittedWithOffsets = options.preserveSourceLineOffsets
    ? emitProgramWithSourceLineOffsets(programForEmission, expressionTypes, implicitReceiverIdentifiers, autoAwaitExpressions, contextProgram)
    : emitted;
  const code = options.preserveSourceLineOffsets
    ? ensureTrailingSemicolonPreservingLines(emittedWithOffsets)
    : ensureTrailingSemicolon(emittedWithOffsets);
  return {
    code,
    warnings: [],
    errors: [],
    sourceMap: createSourceMap(source, code, sourceLinesByGeneratedLine, options)
  };
}
