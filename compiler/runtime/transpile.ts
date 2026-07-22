import {
  compileParsedSource,
  type CompilationArtifacts,
  formatParseIssue,
  formatSemanticIssue
} from "compiler/pipeline/compile";
import { parseSource } from "compiler/pipeline/parse";
import type { ParserOptions } from "compiler/parser/parser";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";
import { basename, extname } from "compiler/utils/path";
import { monotonicNow } from "compiler/utils/time";
import {
  createEmitProgramRuntimeSeed,
  createEmitProgramRuntimeContext,
  emitProgramStatementPairs,
  type EmitOptions,
  type EmitProgramRuntimeSeed,
  type EmittedProgramStatement
} from "./emitter";
import { lowerProgram } from "./lowering";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations.shared";
import { Program, type Node, type Statement } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";
import type { ReceiverLambdaInfo } from "compiler/analysis/model";
import type { SourceRange } from "compiler/parser/tokenizer";
import {
  VEXA_DIAGNOSTIC_CODES,
  classifySemanticDiagnosticMessage,
  mapAnalysisIssueCodeToDiagnosticCode
} from "compiler/diagnosticCodes";
import { normalizeImportedSymbolSources, type ImportedSymbolResolution } from "compiler/importedSymbols";
import { CppEmitError, emitCppProgram } from "./cppEmitter";

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
export type EmitLanguage = "javascript" | "cpp";

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
  /**
   * Whether semantic diagnostics prevent JavaScript emission. Defaults to true.
   * Set to false for TypeScript transpile-only workflows whose types were
   * already validated by TypeScript itself, such as compiler bootstrapping.
   */
  typeCheck?: boolean;
  /** Output language. Defaults to JavaScript. */
  emit?: EmitLanguage;
  /** Emit per-statement native source hooks for diagnostic C++ builds. */
  emitNativeSourceLocations?: boolean;
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
  /** Resolved imported values, keyed by their local name. */
  importedSymbols?: ReadonlyMap<string, ImportedSymbolResolution>;
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
  /** Top-level module emission format. Defaults to ESM. */
  moduleFormat?: EmitOptions["moduleFormat"];
  /** Precomputed runtime metadata for ambient and imported declarations. */
  emitRuntimeSeed?: EmitProgramRuntimeSeed;
  /**
   * When true, rewrite source-language extensions (.vx, .ts, .tsx) in
   * import/export paths to .js in the emitted output. Set for single-file
   * builds (vexa build) where sibling imports are not inlined.
   */
  rewriteImportExtensions?: boolean;
  /** Reports the major single-file compiler phases without requiring Node.js timing APIs. */
  profile?: (event: { phase: "parse" | "analysis" | "emit"; elapsedMs: number }) => void;
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
let cachedEcmaScriptRuntimeEmitSeed: ReturnType<typeof createEmitProgramRuntimeSeed> | null = null;

export function createTranspileRuntimeSeed(declarations: readonly Statement[]): EmitProgramRuntimeSeed {
  const runtimeProgram = getEcmaScriptRuntimeProgram();
  cachedEcmaScriptRuntimeEmitSeed ??= createEmitProgramRuntimeSeed(runtimeProgram);
  return createEmitProgramRuntimeSeed(
    new Program([...declarations]),
    cachedEcmaScriptRuntimeEmitSeed
  );
}

function toVlqSigned(value: number): number {
  if (value < 0) {
    return (-value * 2) + 1;
  }
  return value * 2;
}

function encodeVlq(value: number): string {
  let vlq = toVlqSigned(value);
  let encoded = "";
  do {
    let digit = vlq % 32;
    vlq = Math.floor(vlq / 32);
    if (vlq > 0) {
      digit += 32;
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

interface SourceLineRange {
  start: number;
  end: number;
}

interface EmittedStatementSegment {
  statement: Statement;
  emitted: string;
}

function sourceLineRangeForStatement(statement: Statement): SourceLineRange {
  const start = statement.firstToken?.range.start.line ?? 0;
  const end = statement.lastToken?.range.end.line ?? start;
  return { start, end: Math.max(start, end) };
}

function sourceLinesForEmittedStatement(statement: Statement, emittedStatement: string): number[] {
  const lineCount: number = emittedStatement.length === 0 ? 0 : emittedStatement.split("\n").length;
  if (lineCount <= 0) {
    return [];
  }

  const range = sourceLineRangeForStatement(statement);
  const start: number = range.start;
  const end: number = range.end;
  const span: number = end - start;
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
  baseRuntimeSeed?: ReturnType<typeof createEmitProgramRuntimeSeed>,
  implicitReceiverExtensionIdentifiers: ReadonlyMap<Node, string> = new Map(),
  asyncForStatements: ReadonlySet<Node> = new Set(),
  receiverLambdas: ReadonlyMap<Node, ReceiverLambdaInfo> = new Map()
): EmittedStatementSegment[] {
  const runtimeContext = createEmitProgramRuntimeContext(contextProgram, expressionTypes, emitOptions, baseRuntimeSeed);
  return emitProgramStatementPairs(
    program,
    expressionTypes,
    contextProgram,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    runtimeContext,
    staticImplicitReceiverIdentifiers,
    implicitReceiverExtensionIdentifiers,
    asyncForStatements,
    receiverLambdas
  ).filter((pair: EmittedProgramStatement): boolean => pair.emitted.trim() !== "");
}

function emitSegmentsWithSourceLineOffsets(segments: EmittedStatementSegment[]): string {
  const lines: string[] = [];
  let generatedLine = 0;

  for (const rawSegment of segments) {
    const segment = rawSegment as EmittedStatementSegment;
    const statement = segment.statement;
    const emitted = segment.emitted;
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
    version: 3.0,
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

function sourceLineAt(lines: readonly string[], requestedLine: number): string {
  let currentLine = 1;
  for (const line of lines) {
    if (currentLine === requestedLine) return line;
    currentLine += 1;
  }
  return "";
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
  const importedSymbols: Map<string, ImportedSymbolResolution> =
    normalizeImportedSymbolSources(options).importedSymbols;
  const ambientDeclarations = options.ambientDeclarations ?? [];
  const parserOptions = parserOptionsForTranspile(options);
  let artifacts = options.compilationArtifacts;
  if (!artifacts) {
    const parseStartedAt = monotonicNow();
    const parsed = parseSource(source, parserOptions);
    options.profile?.({ phase: "parse", elapsedMs: monotonicNow() - parseStartedAt });
    const analysisStartedAt = monotonicNow();
    artifacts = compileParsedSource(parsed, {
      externalDeclarations,
      ambientDeclarations,
      importedSymbols,
      language: parserOptions.language === "typescript" ? "typescript" : "vexascript"
    });
    options.profile?.({ phase: "analysis", elapsedMs: monotonicNow() - analysisStartedAt });
  }
  const errors: string[] = [];
  const diagnostics: TranspileDiagnostic[] = [];
  const file = options.sourceFilePath ?? "<unknown>";
  const emitSourceMap = options.emitSourceMap ?? true;
  let sourceLines: string[] | null = null;

  const getSourceLines = (): string[] => {
    sourceLines ??= source.split("\n");
    return sourceLines;
  };
  const noSourceRange: SourceRange | null = null;

  const makeDiagnostic = (message: string, range: SourceRange | null | undefined, code: string): TranspileDiagnostic => {
    const line: number = (range?.start.line ?? 0) + 1;
    const column: number = (range?.start.column ?? 0) + 1;
    const endColumn: number = range?.end ? range.end.column + 1 : column + 1;
    const sourceLine = sourceLineAt(getSourceLines(), line);
    return { file, line, column, endColumn, code, message, sourceLine };
  };

  if (artifacts.tokenizeError) {
    errors.push(
      formatMessageAtSourceRange(artifacts.tokenizeError.message, artifacts.tokenizeError.range)
    );
    diagnostics.push(makeDiagnostic(artifacts.tokenizeError.message, artifacts.tokenizeError.range, VEXA_DIAGNOSTIC_CODES.TOKENIZE_ERROR));
  }
  if (artifacts.fatalError) {
    errors.push(artifacts.fatalError);
    diagnostics.push(makeDiagnostic(artifacts.fatalError, noSourceRange, VEXA_DIAGNOSTIC_CODES.FATAL_ERROR));
  }
  for (const issue of artifacts.parserIssues) {
    errors.push(formatParseIssue(issue));
    diagnostics.push(makeDiagnostic(issue.message, issue.token?.range, VEXA_DIAGNOSTIC_CODES.PARSER_ERROR));
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics };
  }

  if (options.typeCheck ?? true) {
    for (const issue of artifacts.semanticIssues) {
      errors.push(formatSemanticIssue(issue));
      const range: SourceRange | undefined = issue.range
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
  }
  if (errors.length > 0) {
    return { code: "", warnings: [], errors, diagnostics };
  }

  if (!artifacts.ast || !artifacts.analysis) {
    const incompleteDiagnostics: TranspileDiagnostic[] = [];
    incompleteDiagnostics.push(
      makeDiagnostic("Internal error: compilation artifacts are incomplete", noSourceRange, VEXA_DIAGNOSTIC_CODES.FATAL_ERROR)
    );
    return {
      code: "",
      warnings: [],
      errors: ["Internal error: compilation artifacts are incomplete"],
      diagnostics: incompleteDiagnostics
    };
  }

  const emissionStartedAt = monotonicNow();
  const target = options.target ?? "optimized";
  const programForEmission = lowerProgram(artifacts.ast, {
    lowerRangeForLoops: target !== "conservative"
  });
  if (options.emit === "cpp") {
    try {
      const result: TranspileResult = {
        code: emitCppProgram(
          lowerProgram(artifacts.ast, { lowerRangeForLoops: true }),
          {
            ...(options.sourceFilePath ? { sourceFilePath: options.sourceFilePath } : {}),
            ...(options.emitNativeSourceLocations ? { emitSourceLocations: true } : {}),
            expressionTypes: artifacts.analysis.getExpressionTypes(),
            implicitReceiverIdentifiers: artifacts.analysis.getImplicitReceiverIdentifiers(),
            implicitReceiverExtensionIdentifiers: artifacts.analysis.getImplicitReceiverExtensionIdentifiers(),
            staticImplicitReceiverIdentifiers: artifacts.analysis.getStaticImplicitReceiverIdentifiers(),
            autoAwaitExpressions: artifacts.analysis.getAutoAwaitExpressions(),
            callableTypes: artifacts.analysis.getCallableTypes(),
            operatorResolutions: new Map(
              artifacts.analysis.getOperatorResolutions().map((resolution) => [resolution.expression, resolution.symbol])
            ),
            extensionPropertyResolutions: new Map(
              artifacts.analysis.getExtensionPropertyResolutions().map((resolution) => [resolution.expression, resolution])
            ),
            receiverLambdas: artifacts.analysis.getReceiverLambdas()
          }
        ),
        warnings: [],
        errors: [],
        diagnostics: []
      };
      options.profile?.({ phase: "emit", elapsedMs: monotonicNow() - emissionStartedAt });
      return result;
    } catch (error) {
      let message: string;
      let statement: Node | undefined;
      if (error instanceof CppEmitError) {
        message = error.message;
        statement = error.statement;
      } else {
        message = String(error);
      }
      const range: SourceRange | undefined = statement?.firstToken?.range;
      const fatalDiagnostics: TranspileDiagnostic[] = [
        makeDiagnostic(message, range, VEXA_DIAGNOSTIC_CODES.FATAL_ERROR)
      ];
      options.profile?.({ phase: "emit", elapsedMs: monotonicNow() - emissionStartedAt });
      return {
        code: "",
        warnings: [],
        errors: [message],
        diagnostics: fatalDiagnostics
      };
    }
  }
  // Emission collects classes, constructor-only runtime globals, operator
  // overloads and extension properties from a context program. Including the
  // built-in, ambient, and imported declarations lets the emitter lower calls
  // (`Point(...)` / `Uint8Array(...)` -> `new ...(...)`), operators and
  // extension properties that resolve outside the source file.
  const runtimeProgram = getEcmaScriptRuntimeProgram();
  cachedEcmaScriptRuntimeEmitSeed ??= createEmitProgramRuntimeSeed(runtimeProgram);
  const contextProgram = new Program(
    options.emitRuntimeSeed
      ? programForEmission.body
      : [
          ...ambientDeclarations,
          ...externalDeclarations,
          ...programForEmission.body
        ],
    programForEmission.__vexaRecoveryMarkers
  );
  const expressionTypes = artifacts.analysis.getExpressionTypes();
  const implicitReceiverIdentifiers = artifacts.analysis.getImplicitReceiverIdentifiers();
  const staticImplicitReceiverIdentifiers = artifacts.analysis.getStaticImplicitReceiverIdentifiers();
  const implicitReceiverExtensionIdentifiers = artifacts.analysis.getImplicitReceiverExtensionIdentifiers();
  const autoAwaitExpressions = artifacts.analysis.getAutoAwaitExpressions();
  const asyncForStatements = artifacts.analysis.getAsyncForStatements();
  const emittedSegments = emitProgramStatementSegments(
    programForEmission,
    expressionTypes,
    implicitReceiverIdentifiers,
    autoAwaitExpressions,
    contextProgram,
    {
      sourceLanguage: parserOptions.language ?? "vexa",
      ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
      ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {}),
      ...(options.moduleFormat ? { moduleFormat: options.moduleFormat } : {}),
      ...(options.rewriteImportExtensions ? { rewriteImportExtensions: true } : {})
    },
    staticImplicitReceiverIdentifiers,
    options.emitRuntimeSeed ?? cachedEcmaScriptRuntimeEmitSeed,
    implicitReceiverExtensionIdentifiers,
    asyncForStatements,
    artifacts.analysis.getReceiverLambdas()
  );
  let emittedWithOffsets: string;
  if (options.preserveSourceLineOffsets) {
    emittedWithOffsets = emitSegmentsWithSourceLineOffsets(emittedSegments);
  } else {
    emittedWithOffsets = emittedSegments.map((segment) => (segment as EmittedStatementSegment).emitted).join("\n");
  }
  const code = options.preserveSourceLineOffsets
    ? ensureTrailingSemicolonPreservingLines(emittedWithOffsets)
    : ensureTrailingSemicolon(emittedWithOffsets);
  const sourceLinesByGeneratedLine: number[] = [];
  for (const segment of emittedSegments) {
    const segmentSourceLines = sourceLinesForEmittedStatement(segment.statement, segment.emitted);
    for (const sourceLine of segmentSourceLines) sourceLinesByGeneratedLine.push(sourceLine);
  }
  const result: TranspileResult = {
    code,
    warnings: [],
    errors: [],
    diagnostics: [],
    ...(emitSourceMap
      ? {
          sourceMap: createSourceMap(
            source,
            code,
            sourceLinesByGeneratedLine,
            options
          )
        }
      : {})
  };
  options.profile?.({ phase: "emit", elapsedMs: monotonicNow() - emissionStartedAt });
  return result;
}
