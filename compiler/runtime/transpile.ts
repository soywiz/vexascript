import {
  compileSource,
  formatParseIssue,
  formatSemanticIssue
} from "compiler/pipeline/compile";
import { basename } from "node:path";
import { emitProgram } from "./emitter";
import { lowerProgram } from "./lowering";

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

function createLineStartMappings(generatedLineCount: number, sourceLineCount: number): string {
  if (generatedLineCount <= 0) {
    return "";
  }

  const safeSourceLineCount = Math.max(1, sourceLineCount);
  let mappings = "";
  let previousSourceLine = 0;

  for (let generatedLine = 0; generatedLine < generatedLineCount; generatedLine += 1) {
    if (generatedLine > 0) {
      mappings += ";";
    }
    const sourceLine = Math.min(generatedLine, safeSourceLineCount - 1);
    const sourceLineDelta = sourceLine - previousSourceLine;
    mappings += `${encodeVlq(0)}${encodeVlq(0)}${encodeVlq(sourceLineDelta)}${encodeVlq(0)}`;
    previousSourceLine = sourceLine;
  }

  return mappings;
}

function createSourceMap(
  source: string,
  emittedCode: string,
  options: TranspileOptions
): string {
  const sourceFileName = basename(options.sourceFilePath ?? "input.my");
  const outputFileName = basename(options.outputFilePath ?? "output.js");
  const generatedLineCount = emittedCode.length === 0 ? 0 : emittedCode.split("\n").length;
  const sourceLineCount = source.length === 0 ? 0 : source.split("\n").length;

  const map: SourceMapV3 = {
    version: 3,
    file: outputFileName,
    sources: [sourceFileName],
    sourcesContent: [source],
    names: [],
    mappings: createLineStartMappings(generatedLineCount, sourceLineCount)
  };

  return JSON.stringify(map);
}

export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  const artifacts = compileSource(source);
  const errors: string[] = [];

  if (artifacts.tokenizeError) {
    errors.push(
      `${artifacts.tokenizeError.message} at ${artifacts.tokenizeError.range.start.line + 1}:${artifacts.tokenizeError.range.start.column + 1}`
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
  const emitted = emitProgram(programForEmission, artifacts.analysis.getExpressionTypes());
  const code = ensureTrailingSemicolon(emitted);
  return {
    code,
    warnings: [],
    errors: [],
    sourceMap: createSourceMap(source, code, options)
  };
}
