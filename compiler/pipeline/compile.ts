import { Analysis, type AnalysisIssue, type AnalysisOptions } from "compiler/analysis/Analysis";
import type { ParseIssue, ParserOptions } from "compiler/parser/parser";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";
import { SourcePosition, SourceRange } from "compiler/parser/tokenizer";
import { parseSource, type ParseArtifacts } from "./parse";

export interface CompilationArtifacts extends ParseArtifacts {
  analysis: Analysis | null;
  semanticIssues: AnalysisIssue[];
}

export function compileParsedSource(
  parsed: ParseArtifacts,
  analysisOptions: AnalysisOptions = {}
): CompilationArtifacts {
  if (!parsed.ast) {
    return {
      ...parsed,
      analysis: null,
      semanticIssues: []
    };
  }

  try {
    const analysis = new Analysis(parsed.ast, {
      ...analysisOptions,
      language: analysisOptions.language ?? parsed.language
    });
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

export function compileSource(
  source: string,
  options: ParserOptions = {},
  analysisOptions: AnalysisOptions = {}
): CompilationArtifacts {
  return compileParsedSource(parseSource(source, options), {
    ...analysisOptions,
    language: analysisOptions.language ?? (options.language === "typescript" ? "typescript" : "vexascript")
  });
}

export function formatParseIssue(issue: ParseIssue): string {
  if (!issue.token) {
    return issue.message;
  }
  return formatMessageAtSourceRange(issue.message, issue.token.range);
}

export function sourceRangeForAnalysisIssue(issue: AnalysisIssue): SourceRange | undefined {
  if (!issue.range) {
    return issue.node.firstToken?.range;
  }
  return new SourceRange(
    new SourcePosition(0, issue.range.start.line, issue.range.start.character),
    new SourcePosition(0, issue.range.end.line, issue.range.end.character)
  );
}

export function formatSemanticIssue(issue: AnalysisIssue): string {
  const range = sourceRangeForAnalysisIssue(issue);
  if (!range) {
    return issue.message;
  }
  return formatMessageAtSourceRange(issue.message, range);
}
