import { Analysis, type AnalysisIssue } from "compiler/analysis/Analysis";
import type { ClassStatement } from "compiler/ast/ast";
import type { ParseIssue, ParserOptions } from "compiler/parser/parser";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";
import { parseSource, type ParseArtifacts } from "./parse";

export interface CompilationArtifacts extends ParseArtifacts {
  analysis: Analysis | null;
  semanticIssues: AnalysisIssue[];
}

export interface CompileOptions extends ParserOptions {
  importedClassStatements?: ReadonlyMap<string, ClassStatement>;
}

export function compileSource(source: string, options: CompileOptions = {}): CompilationArtifacts {
  const { importedClassStatements = new Map(), ...parserOptions } = options;
  const parsed = parseSource(source, parserOptions);
  if (!parsed.ast) {
    return {
      ...parsed,
      analysis: null,
      semanticIssues: []
    };
  }

  try {
    const analysis = new Analysis(parsed.ast, importedClassStatements);
    return {
      ...parsed,
      analysis,
      semanticIssues: analysis.getIssues()
    };
  } catch (error) {
    return {
      ...parsed,
      analysis: null,
      semanticIssues: [],
      fatalError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function formatParseIssue(issue: ParseIssue): string {
  if (!issue.token) {
    return issue.message;
  }
  return formatMessageAtSourceRange(issue.message, issue.token.range);
}

export function formatSemanticIssue(issue: AnalysisIssue): string {
  const token = issue.node.firstToken;
  if (!token) {
    return issue.message;
  }
  return formatMessageAtSourceRange(issue.message, token.range);
}
