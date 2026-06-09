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
  importedSymbolTypes: ReadonlyMap<string, AnalysisType> = new Map(),
  ambientDeclarations: Statement[] = []
): AnalysisSession {
  const artifacts = compileSource(source, {}, { externalDeclarations, importedSymbolTypes, ambientDeclarations });
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
  ambientDeclarations?: Statement[];
}

export type ExternalDeclarationsResolver = (
  document: TextDocument,
  session: AnalysisSession
) => ResolvedExternals | Promise<ResolvedExternals>;

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; session: AnalysisSession }>();
  private readonly pending = new Map<string, Promise<AnalysisSession>>();

  constructor(
    private readonly resolveExternalDeclarations?: ExternalDeclarationsResolver,
    private readonly onSessionUpdated?: () => void
  ) {}

  getForDocument(document: TextDocument): AnalysisSession {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    const baseSession = createAnalysisSession(document.getText());
    if (!this.resolveExternalDeclarations) {
      this.cache.set(document.uri, { version: document.version, session: baseSession });
      return baseSession;
    }

    // Kick off async resolution if not already in progress for this version
    const existingPending = this.pending.get(document.uri);
    if (!existingPending) {
      const docVersion = document.version;
      const docText = document.getText();
      const docUri = document.uri;
      const resolvePromise = Promise.resolve(this.resolveExternalDeclarations(document, baseSession)).then((resolved) => {
        const externalDeclarations = resolved?.externalDeclarations ?? [];
        const importedSymbolTypes = resolved?.importedSymbolTypes ?? new Map();
        const ambientDeclarations = resolved?.ambientDeclarations ?? [];
        const session = externalDeclarations.length > 0 || importedSymbolTypes.size > 0 || ambientDeclarations.length > 0
          ? createAnalysisSession(docText, externalDeclarations, importedSymbolTypes, ambientDeclarations)
          : baseSession;
        // Only update if version still matches
        const still = this.cache.get(docUri);
        if (!still || still.version <= docVersion) {
          this.cache.set(docUri, { version: docVersion, session });
          this.onSessionUpdated?.();
        }
        this.pending.delete(docUri);
        return session;
      }).catch(() => {
        this.pending.delete(docUri);
        return baseSession;
      });
      this.pending.set(docUri, resolvePromise);
    }

    // Return stale or base session until async resolution completes
    return cached?.session ?? baseSession;
  }

  async getForDocumentAsync(document: TextDocument): Promise<AnalysisSession> {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    const baseSession = createAnalysisSession(document.getText());
    if (!this.resolveExternalDeclarations) {
      this.cache.set(document.uri, { version: document.version, session: baseSession });
      return baseSession;
    }

    const resolved = await this.resolveExternalDeclarations(document, baseSession);
    const externalDeclarations = resolved?.externalDeclarations ?? [];
    const importedSymbolTypes = resolved?.importedSymbolTypes ?? new Map();
    const ambientDeclarations = resolved?.ambientDeclarations ?? [];
    const session = externalDeclarations.length > 0 || importedSymbolTypes.size > 0 || ambientDeclarations.length > 0
      ? createAnalysisSession(document.getText(), externalDeclarations, importedSymbolTypes, ambientDeclarations)
      : baseSession;
    this.cache.set(document.uri, { version: document.version, session });
    return session;
  }

  delete(uri: string): void {
    this.cache.delete(uri);
    this.pending.delete(uri);
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}
