import {
  compileSource,
  formatParseIssue,
  formatSemanticIssue
} from "compiler/pipeline/compile";
import { emitProgram } from "./emitter";

export interface TranspileResult {
  code: string;
  warnings: string[];
  errors: string[];
}

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

export function transpile(source: string): TranspileResult {
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

  const emitted = emitProgram(artifacts.ast, artifacts.analysis.getExpressionTypes());
  return {
    code: ensureTrailingSemicolon(emitted),
    warnings: [],
    errors: []
  };
}
