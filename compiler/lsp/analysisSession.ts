import type { Analysis, AnalysisIssue } from "compiler/analysis/Analysis";
import type { Program, Statement } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";
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

export function createAnalysisSession(
  source: string,
  externalDeclarations: Statement[] = [],
  importedSymbolTypes: ReadonlyMap<string, AnalysisType> = new Map()
): AnalysisSession {
  const artifacts = compileSource(source, {}, { externalDeclarations, importedSymbolTypes });
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

/**
 * Resolves the imported top-level type declarations that a document depends on,
 * so the per-document analysis can resolve cross-file receivers/members. A first
 * single-file analysis is built (without externals) so the resolver can inspect
 * the document's import statements.
 */
export interface ResolvedExternals {
  externalDeclarations: Statement[];
  importedSymbolTypes: ReadonlyMap<string, AnalysisType>;
}

export type ExternalDeclarationsResolver = (
  document: TextDocument,
  session: AnalysisSession
) => ResolvedExternals;

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; session: AnalysisSession }>();

  constructor(private readonly resolveExternalDeclarations?: ExternalDeclarationsResolver) {}

  getForDocument(document: TextDocument): AnalysisSession {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    const baseSession = createAnalysisSession(document.getText());
    const resolved = this.resolveExternalDeclarations?.(document, baseSession);
    const externalDeclarations = resolved?.externalDeclarations ?? [];
    const importedSymbolTypes = resolved?.importedSymbolTypes ?? new Map();
    const session = externalDeclarations.length > 0 || importedSymbolTypes.size > 0
      ? createAnalysisSession(document.getText(), externalDeclarations, importedSymbolTypes)
      : baseSession;
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
