import type { Analysis, AnalysisIssue } from "compiler/analysis/Analysis";
import type { Program, Statement } from "compiler/ast/ast";
import type { AnalysisType } from "compiler/analysis/types";
import type { ParseIssue } from "compiler/parser/parser";
import type { TokenizeError } from "compiler/parser/tokenizer";
import { compileSource } from "compiler/pipeline/compile";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { AmbientModuleLocation } from "./ambientTypesLoader";

export interface AnalysisSession {
  ast: Program | null;
  parserErrors: ParseIssue[];
  semanticIssues: AnalysisIssue[];
  analysis: Analysis | null;
  tokenizeError: TokenizeError | null;
  fatalError: string | null;
  externalDeclarations: Statement[];
  importedSymbolTypes: ReadonlyMap<string, AnalysisType>;
  importedSymbolDisplayTypes: ReadonlyMap<string, string>;
  invalidImportedBindings: ReadonlySet<string>;
  ambientDeclarations: Statement[];
  ambientDeclarationLocations: ReadonlyMap<Statement, AmbientModuleLocation>;
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>;
  ambientModuleLocations: ReadonlyMap<string, AmbientModuleLocation>;
}

export function createAnalysisSession(
  source: string,
  externalDeclarations: Statement[] = [],
  importedSymbolTypes: ReadonlyMap<string, AnalysisType> = new Map(),
  ambientDeclarations: Statement[] = [],
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]> = new Map(),
  ambientModuleLocations: ReadonlyMap<string, AmbientModuleLocation> = new Map(),
  importedSymbolDisplayTypes: ReadonlyMap<string, string> = new Map(),
  invalidImportedBindings: ReadonlySet<string> = new Set(),
  ambientDeclarationLocations: ReadonlyMap<Statement, AmbientModuleLocation> = new Map()
): AnalysisSession {
  const artifacts = compileSource(source, {}, {
    externalDeclarations,
    importedSymbolTypes,
    importedSymbolDisplayTypes,
    ambientDeclarations,
    invalidImportedBindings
  });
  return {
    ast: artifacts.ast,
    parserErrors: artifacts.parserIssues,
    semanticIssues: artifacts.semanticIssues,
    analysis: artifacts.analysis,
    tokenizeError: artifacts.tokenizeError,
    fatalError: artifacts.fatalError,
    externalDeclarations: [...externalDeclarations],
    importedSymbolTypes,
    importedSymbolDisplayTypes,
    invalidImportedBindings,
    ambientDeclarations: [...ambientDeclarations],
    ambientDeclarationLocations,
    ambientModuleDeclarations,
    ambientModuleLocations
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
  importedSymbolDisplayTypes?: ReadonlyMap<string, string>;
  invalidImportedBindings?: ReadonlySet<string>;
  ambientDeclarations?: Statement[];
  ambientDeclarationLocations?: ReadonlyMap<Statement, AmbientModuleLocation>;
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
  ambientModuleLocations?: ReadonlyMap<string, AmbientModuleLocation>;
}

export type ExternalDeclarationsResolver = (
  document: TextDocument,
  session: AnalysisSession
) => ResolvedExternals | Promise<ResolvedExternals>;

function buildSessionFromResolved(
  docText: string,
  baseSession: AnalysisSession,
  resolved: ResolvedExternals
): AnalysisSession {
  const externalDeclarations = resolved.externalDeclarations ?? [];
  const importedSymbolTypes = resolved.importedSymbolTypes ?? new Map();
  const importedSymbolDisplayTypes = resolved.importedSymbolDisplayTypes ?? new Map();
  const ambientDeclarations = resolved.ambientDeclarations ?? [];
  const ambientDeclarationLocations = resolved.ambientDeclarationLocations ?? new Map();
  const ambientModuleDeclarations = resolved.ambientModuleDeclarations ?? new Map();
  const ambientModuleLocations = resolved.ambientModuleLocations ?? new Map();
  const invalidImportedBindings = resolved.invalidImportedBindings ?? new Set();
  if (
    externalDeclarations.length === 0 &&
    importedSymbolTypes.size === 0 &&
    importedSymbolDisplayTypes.size === 0 &&
    invalidImportedBindings.size === 0 &&
    ambientDeclarations.length === 0 &&
    ambientDeclarationLocations.size === 0 &&
    ambientModuleDeclarations.size === 0
  ) {
    return baseSession;
  }
  return createAnalysisSession(
    docText,
    externalDeclarations,
    importedSymbolTypes,
    ambientDeclarations,
    ambientModuleDeclarations,
    ambientModuleLocations,
    importedSymbolDisplayTypes,
    invalidImportedBindings,
    ambientDeclarationLocations
  );
}

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; session: AnalysisSession }>();
  // Pending stores version alongside the promise so getForDocumentAsync can
  // safely reuse an in-flight resolution only when it is for the same version.
  private readonly pending = new Map<string, { version: number; promise: Promise<AnalysisSession> }>();

  constructor(
    private readonly resolveExternalDeclarations?: ExternalDeclarationsResolver,
    private readonly onSessionUpdated?: () => void
  ) {}

  private startAsyncResolution(
    document: TextDocument,
    baseSession: AnalysisSession
  ): Promise<AnalysisSession> {
    const docText = document.getText();
    const docVersion = document.version;
    const docUri = document.uri;
    const resolveExternalDeclarations = this.resolveExternalDeclarations;
    if (!resolveExternalDeclarations) {
      this.cache.set(docUri, { version: docVersion, session: baseSession });
      return Promise.resolve(baseSession);
    }
    let pendingPromise: Promise<AnalysisSession> | undefined;
    pendingPromise = (async () => {
      try {
        const resolved = await resolveExternalDeclarations(document, baseSession);
        const session = buildSessionFromResolved(docText, baseSession, resolved);
        const still = this.cache.get(docUri);
        if (!still || still.version <= docVersion) {
          this.cache.set(docUri, { version: docVersion, session });
          this.onSessionUpdated?.();
        }
        return session;
      } catch {
        return baseSession;
      } finally {
        const pending = this.pending.get(docUri);
        if (pendingPromise && pending?.version === docVersion && pending.promise === pendingPromise) {
          this.pending.delete(docUri);
        }
      }
    })();
    this.pending.set(docUri, { version: docVersion, promise: pendingPromise });
    return pendingPromise;
  }

  getForDocument(document: TextDocument): AnalysisSession {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    const docText = document.getText();
    const docVersion = document.version;
    const docUri = document.uri;
    const baseSession = createAnalysisSession(docText);

    if (!this.resolveExternalDeclarations) {
      this.cache.set(docUri, { version: docVersion, session: baseSession });
      return baseSession;
    }

    // Kick off async resolution if not already in progress for this version
    const pending = this.pending.get(docUri);
    if (!pending || pending.version !== docVersion) {
      this.startAsyncResolution(document, baseSession);
    }

    // Return stale or base session until async resolution completes
    return cached?.session ?? baseSession;
  }

  async getForDocumentAsync(document: TextDocument): Promise<AnalysisSession> {
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      return cached.session;
    }

    // Reuse an in-flight resolution only when it is for the same document version
    const pending = this.pending.get(document.uri);
    if (pending && pending.version === document.version) {
      return pending.promise;
    }

    const docText = document.getText();
    const baseSession = createAnalysisSession(docText);
    return this.startAsyncResolution(document, baseSession);
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
