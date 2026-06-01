import { Analysis, type AnalysisIssue } from "compiler/analysis/Analysis";
import type { Program } from "compiler/ast/ast";
import { Parser, type ParseIssue } from "compiler/parser/parser";
import { TokenizeError, tokenize } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";
import { formatMessageAtSourceRange } from "compiler/sourceLocations";

export interface CompilationArtifacts {
  ast: Program | null;
  parserIssues: ParseIssue[];
  analysis: Analysis | null;
  semanticIssues: AnalysisIssue[];
  tokenizeError: TokenizeError | null;
  fatalError: string | null;
}

export function compileSource(source: string): CompilationArtifacts {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(new ListReader(tokens));
    const ast = parser.parseFile();
    const parserIssues = [...parser.errors];

    try {
      const analysis = new Analysis(ast);
      return {
        ast,
        parserIssues,
        analysis,
        semanticIssues: analysis.getIssues(),
        tokenizeError: null,
        fatalError: null
      };
    } catch (error) {
      return {
        ast,
        parserIssues,
        analysis: null,
        semanticIssues: [],
        tokenizeError: null,
        fatalError: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    if (error instanceof TokenizeError) {
      return {
        ast: null,
        parserIssues: [],
        analysis: null,
        semanticIssues: [],
        tokenizeError: error,
        fatalError: null
      };
    }

    return {
      ast: null,
      parserIssues: [],
      analysis: null,
      semanticIssues: [],
      tokenizeError: null,
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
