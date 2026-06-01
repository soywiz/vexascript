import type { Analysis, AnalysisIssue } from "compiler/analysis/Analysis";
import type { Program } from "compiler/ast/ast";
import type { ParseIssue } from "compiler/parser/parser";
import type { TokenizeError } from "compiler/parser/tokenizer";
import { compileSource } from "compiler/pipeline/compile";
import type { TextDocument } from "vscode-languageserver-textdocument";

export interface AnalysisSession {
  ast: Program | null;
  parserErrors: ParseIssue[];
  semanticIssues: AnalysisIssue[];
  analysis: Analysis | null;
  tokenizeError: TokenizeError | null;
  fatalError: string | null;
}

export function createAnalysisSession(source: string): AnalysisSession {
  const artifacts = compileSource(source);
  return {
    ast: artifacts.ast,
    parserErrors: artifacts.parserIssues,
    semanticIssues: artifacts.semanticIssues,
    analysis: artifacts.analysis,
    tokenizeError: artifacts.tokenizeError,
    fatalError: artifacts.fatalError
  };
}

export function buildAnalysisForSource(source: string): Analysis | null {
  return createAnalysisSession(source).analysis;
}

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; session: AnalysisSession }>();

  getForDocument(document: TextDocument): AnalysisSession {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    const session = createAnalysisSession(document.getText());
    this.cache.set(document.uri, { version: document.version, session });
    return session;
  }

  delete(uri: string): void {
    this.cache.delete(uri);
  }

  clear(): void {
    this.cache.clear();
  }
}
