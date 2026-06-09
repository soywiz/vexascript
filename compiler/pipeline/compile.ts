import { Analysis, type AnalysisIssue, type AnalysisOptions } from "compiler/analysis/Analysis";
import type { ParseIssue, ParserOptions } from "compiler/parser/parser";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";
import type { SourceRange } from "compiler/parser/tokenizer";
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
    const analysis = new Analysis(parsed.ast, analysisOptions);
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
  return compileParsedSource(parseSource(source, options), analysisOptions);
}

export function formatParseIssue(issue: ParseIssue): string {
  if (!issue.token) {
    return issue.message;
  }
  return formatMessageAtSourceRange(issue.message, issue.token.range);
}

export function formatSemanticIssue(issue: AnalysisIssue): string {
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
  if (!range) {
    return issue.message;
  }
  return formatMessageAtSourceRange(issue.message, range);
}
