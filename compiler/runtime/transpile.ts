import {
  compileSource,
  type CompilationArtifacts,
  formatParseIssue,
  formatSemanticIssue
} from "compiler/pipeline/compile";
import type { ParserOptions } from "compiler/parser/parser";
import { basename, extname } from "node:path";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";
import {
  createEmitProgramRuntimeSeed,
  createEmitProgramRuntimeContext,
  emitProgramStatementPairs,
  type EmitOptions
} from "./emitter";
import { lowerProgram } from "./lowering";
import { getEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations";
import type { Program, Statement } from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";
import type { SourceRange } from "compiler/parser/tokenizer";
import {
  VEXA_DIAGNOSTIC_CODES,
  classifySemanticDiagnosticMessage,
  mapAnalysisIssueCodeToDiagnosticCode
} from "compiler/lsp/diagnosticCodes";

export interface TranspileDiagnostic {
  file: string;
  line: number;
  column: number;
  endColumn: number;
  code: string;
  message: string;
  sourceLine: string;
}

export interface TranspileResult {
  code: string;
  warnings: string[];
  errors: string[];
  diagnostics: TranspileDiagnostic[];
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
  /** Precomputed parse+analysis artifacts to reuse instead of recompiling the source. */
  compilationArtifacts?: CompilationArtifacts;
  sourceFilePath?: string;
  /** Parser mode. Defaults to TypeScript for `.ts`/`.tsx` paths and VexaScript otherwise. */
  parserOptions?: ParserOptions;
  outputFilePath?: string;
  target?: TranspileTarget;
  preserveSourceLineOffsets?: boolean;
  /**
   * Whether to generate a source map. Defaults to true so direct transpile
   * callers keep the current behavior, while internal hot paths can opt out.
   */
  emitSourceMap?: boolean;
  /**
   * Top-level declarations imported from other files (classes, interfaces,
   * enums, type aliases, extension methods/operators/properties and functions).
   * They are fed to the analyzer for cross-file name/member/operator resolution
   * and to the emitter as additional context so calls, operators and extension
   * properties referencing imported declarations lower correctly.
   */
  externalDeclarations?: Statement[];
  /**
   * Ambient declarations requested by project configuration, such as DOM host
   * globals. They affect type checking only and are not emitted.
   */
  ambientDeclarations?: Statement[];
  /**
   * Resolved types for imported values, keyed by their local name. Lets
   * cross-file functions (including those whose return type is inferred from
   * their body) participate in type resolution and pervasive auto-await.
   */
  importedSymbolTypes?: ReadonlyMap<string, AnalysisType>;
  /**
   * Callee used to lower embedded XML/JSX elements. Defaults to
   * `React.createElement`; set to `h` (Preact) or a custom factory as needed.
   */
  jsxFactory?: string;
  /**
   * Expression used for JSX fragments (`<>...</>`). Defaults to
   * `React.Fragment`.
   */
  jsxFragmentFactory?: string;
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
let cachedEcmaScriptRuntimeEmitSeed: ReturnType<typeof createEmitProgramRuntimeSeed> | null = null;

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

function emitProgramStatementSegments(
  program: Program,
  expressionTypes: ReadonlyMap<Node, AnalysisType>,
  implicitReceiverIdentifiers: ReadonlySet<Node>,
  autoAwaitExpressions: ReadonlySet<Node>,
  contextProgram: Program = program,
  emitOptions: EmitOptions = {},
  staticImplicitReceiverIdentifiers: ReadonlyMap<Node, string> = new Map(),
  baseRuntimeSeed?: ReturnType<typeof createEmitProgramRuntimeSeed>
): { statement: Statement; emitted: string }[] {
  const runtimeContext = createEmitProgramRuntimeContext(contextProgram, expressionTypes, emitOptions, baseRuntimeSeed);
  return emitProgramStatementPairs(
    program,
    expressionTypes,
    contextProgram,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    runtimeContext,
    staticImplicitReceiverIdentifiers
  ).filter(({ emitted }) => emitted.trim().length > 0);
}

function emitSegmentsWithSourceLineOffsets(segments: { statement: Statement; emitted: string }[]): string {
  const lines: string[] = [];
  let generatedLine = 0;

  for (const { statement, emitted } of segments) {
    const sourceStartLine = statement.firstToken?.range.start.line ?? generatedLine;
    while (generatedLine < sourceStartLine) {
      lines.push("");
      generatedLine += 1;
    }

    const emittedLines = emitted.split("\n");
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
  const sourceFileName = basename(options.sourceFilePath ?? "input.vx");
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

function parserOptionsForTranspile(options: TranspileOptions): ParserOptions {
  if (options.parserOptions) {
    return options.parserOptions;
  }
  const extension = options.sourceFilePath ? extname(options.sourceFilePath).toLowerCase() : "";
  if (extension === ".ts") {
    return { language: "typescript" };
  }
  if (extension === ".tsx") {
    return { language: "typescript", jsx: true };
  }
  return {};
}

export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  const externalDeclarations = options.externalDeclarations ?? [];
  const importedSymbolTypes = options.importedSymbolTypes ?? new Map();
  const ambientDeclarations = options.ambientDeclarations ?? [];
  const artifacts = options.compilationArtifacts ?? compileSource(
    source,
    parserOptionsForTranspile(options),
    { externalDeclarations, ambientDeclarations, importedSymbolTypes }
  );
  const errors: string[] = [];
  const diagnostics: TranspileDiagnostic[] = [];
  const file = options.sourceFilePath ?? "<unknown>";
  const emitSourceMap = options.emitSourceMap ?? true;
  let sourceLines: string[] | null = null;

  function getSourceLines(): string[] {
    sourceLines ??= source.split("\n");
    return sourceLines;
  }

  function makeDiagnostic(message: string, range: SourceRange | null | undefined, code: string): TranspileDiagnostic {
    const line = (range?.start.line ?? 0) + 1;
    const column = (range?.start.column ?? 0) + 1;
    const endColumn = range?.end ? range.end.column + 1 : column + 1;
    const sourceLine = getSourceLines()[line - 1] ?? "";
    return { file, line, column, endColumn, code, message, sourceLine };
  }

  if (artifacts.tokenizeError) {
    errors.push(
      formatMessageAtSourceRange(artifacts.tokenizeError.message, artifacts.tokenizeError.range)
    );
    diagnostics.push(makeDiagnostic(artifacts.tokenizeError.message, artifacts.tokenizeError.range, VEXA_DIAGNOSTIC_CODES.TOKENIZE_ERROR));
  }
  if (artifacts.fatalError) {
    errors.push(artifacts.fatalError);
    diagnostics.push(makeDiagnostic(artifacts.fatalError, null, VEXA_DIAGNOSTIC_CODES.FATAL_ERROR));
  }
  for (const issue of artifacts.parserIssues) {
    errors.push(formatParseIssue(issue));
    diagnostics.push(makeDiagnostic(issue.message, issue.token?.range, VEXA_DIAGNOSTIC_CODES.PARSER_ERROR));
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics };
  }

  for (const issue of artifacts.semanticIssues) {
    errors.push(formatSemanticIssue(issue));
    const range = issue.range
      ? {
          start: {
            offset: 0,
            line: issue.range.start.line,
            column: issue.range.start.character
          },
          end: {
            offset: 0,
            line: issue.range.end.line,
            column: issue.range.end.character
          }
        }
      : issue.node.firstToken?.range;
    const code =
      mapAnalysisIssueCodeToDiagnosticCode(issue.code) ??
      classifySemanticDiagnosticMessage(issue.message) ??
      VEXA_DIAGNOSTIC_CODES.SEMANTIC_ERROR;
    diagnostics.push(makeDiagnostic(issue.message, range, code));
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics };
  }

  if (!artifacts.ast || !artifacts.analysis) {
    return {
      code: "",
      warnings: [],
      errors: ["Internal error: compilation artifacts are incomplete"],
      diagnostics: [makeDiagnostic("Internal error: compilation artifacts are incomplete", null, VEXA_DIAGNOSTIC_CODES.FATAL_ERROR)]
    };
  }

  const target = options.target ?? "optimized";
  const programForEmission = target === "conservative" ? artifacts.ast : lowerProgram(artifacts.ast);
  // Emission collects classes, constructor-only runtime globals, operator
  // overloads and extension properties from a context program. Including the
  // built-in, ambient, and imported declarations lets the emitter lower calls
  // (`Point(...)` / `Uint8Array(...)` -> `new ...(...)`), operators and
  // extension properties that resolve outside the source file.
  const runtimeProgram = getEcmaScriptRuntimeProgram();
  cachedEcmaScriptRuntimeEmitSeed ??= createEmitProgramRuntimeSeed(runtimeProgram);
  const contextProgram: Program = {
    ...programForEmission,
    body: [
      ...ambientDeclarations,
      ...externalDeclarations,
      ...programForEmission.body
    ]
  };
  const expressionTypes = artifacts.analysis.getExpressionTypes();
  const implicitReceiverIdentifiers = artifacts.analysis.getImplicitReceiverIdentifiers();
  const staticImplicitReceiverIdentifiers = artifacts.analysis.getStaticImplicitReceiverIdentifiers();
  const autoAwaitExpressions = artifacts.analysis.getAutoAwaitExpressions();
  const emittedSegments = emitProgramStatementSegments(
    programForEmission,
    expressionTypes,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    contextProgram,
    {
      ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
      ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {})
    },
    staticImplicitReceiverIdentifiers,
    cachedEcmaScriptRuntimeEmitSeed
  );
  const emittedWithOffsets = options.preserveSourceLineOffsets
    ? emitSegmentsWithSourceLineOffsets(emittedSegments)
    : emittedSegments.map(({ emitted }) => emitted).join("\n");
  const code = options.preserveSourceLineOffsets
    ? ensureTrailingSemicolonPreservingLines(emittedWithOffsets)
    : ensureTrailingSemicolon(emittedWithOffsets);
  return {
    code,
    warnings: [],
    errors: [],
    diagnostics: [],
    ...(emitSourceMap
      ? {
          sourceMap: createSourceMap(
            source,
            code,
            emittedSegments.flatMap(({ statement, emitted }) => sourceLinesForEmittedStatement(statement, emitted)),
            options
          )
        }
      : {})
  };
}
