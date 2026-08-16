import type { Analysis, AnalysisIssue } from "compiler/analysis/Analysis";
import { ExportStatement, ImportStatement, type Program, type Statement } from "compiler/ast/ast";
import type { ParseIssue } from "compiler/parser/parser";
import type { TokenizeError } from "compiler/parser/tokenizer";
import { compileSource } from "compiler/pipeline/compile";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { AmbientModuleLocation } from "./ambientTypesLoader";
import {
  normalizeImportedSymbolSources,
  type ImportedSymbolResolution
} from "compiler/importedSymbols";

export interface DeclarationLocation {
  filePath: string;
  line: number;
  character: number;
}

export interface AnalysisSession {
  ast: Program | null;
  parserErrors: ParseIssue[];
  semanticIssues: AnalysisIssue[];
  analysis: Analysis | null;
  tokenizeError: TokenizeError | null;
  fatalError: string | null;
  externalDeclarations: Statement[];
  externalDeclarationLocations: ReadonlyMap<Statement, DeclarationLocation>;
  importedSymbols: ReadonlyMap<string, ImportedSymbolResolution>;
  invalidImportedBindings: ReadonlySet<string>;
  ambientDeclarations: Statement[];
  ambientDeclarationLocations: ReadonlyMap<Statement, AmbientModuleLocation>;
  ambientModuleDeclarations: ReadonlyMap<string, Statement[]>;
  ambientModuleLocations: ReadonlyMap<string, AmbientModuleLocation>;
}

export interface AnalysisSessionOptions {
  externalDeclarations?: Statement[];
  externalDeclarationLocations?: ReadonlyMap<Statement, DeclarationLocation>;
  ambientDeclarations?: Statement[];
  ambientModuleDeclarations?: ReadonlyMap<string, Statement[]>;
  ambientModuleLocations?: ReadonlyMap<string, AmbientModuleLocation>;
  invalidImportedBindings?: ReadonlySet<string>;
  ambientDeclarationLocations?: ReadonlyMap<Statement, AmbientModuleLocation>;
  importedSymbols?: ReadonlyMap<string, ImportedSymbolResolution>;
  projectOwnedExternalDeclarations?: boolean;
}

export function createAnalysisSession(
  source: string,
  options: AnalysisSessionOptions = {}
): AnalysisSession {
  const externalDeclarations = options.externalDeclarations ?? [];
  const externalDeclarationLocations = options.externalDeclarationLocations ?? new Map();
  const ambientDeclarations = options.ambientDeclarations ?? [];
  const ambientDeclarationLocations = options.ambientDeclarationLocations ?? new Map();
  const ambientModuleDeclarations = options.ambientModuleDeclarations ?? new Map();
  const ambientModuleLocations = options.ambientModuleLocations ?? new Map();
  const {
    importedSymbols: normalizedImportedSymbols,
    invalidImportedBindings: normalizedInvalidImportedBindings
  } = normalizeImportedSymbolSources({
    importedSymbols: options.importedSymbols,
    invalidImportedBindings: options.invalidImportedBindings
  });
  const artifacts = compileSource(source, {}, {
    externalDeclarations,
    importedSymbols: normalizedImportedSymbols,
    ambientDeclarations,
    invalidImportedBindings: normalizedInvalidImportedBindings,
    projectOwnedExternalDeclarations: options.projectOwnedExternalDeclarations === true
  });
  return {
    ast: artifacts.ast,
    parserErrors: artifacts.parserIssues,
    semanticIssues: artifacts.semanticIssues,
    analysis: artifacts.analysis,
    tokenizeError: artifacts.tokenizeError,
    fatalError: artifacts.fatalError,
    externalDeclarations: [...externalDeclarations],
    externalDeclarationLocations,
    importedSymbols: normalizedImportedSymbols,
    invalidImportedBindings: normalizedInvalidImportedBindings,
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
  externalDeclarationLocations?: ReadonlyMap<Statement, DeclarationLocation>;
  importedSymbols?: ReadonlyMap<string, ImportedSymbolResolution>;
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

export interface AnalysisSessionCacheMetrics {
  synchronousRequests: number;
  asynchronousRequests: number;
  sessionCacheHits: number;
  sessionCacheMisses: number;
  pendingSessionReuses: number;
  externalCacheHits: number;
  externalCacheMisses: number;
  pendingExternalReuses: number;
  externalResolverRuns: number;
  baseSessionBuilds: number;
  resolvedSessionBuilds: number;
}

function emptyAnalysisSessionCacheMetrics(): AnalysisSessionCacheMetrics {
  return {
    synchronousRequests: 0,
    asynchronousRequests: 0,
    sessionCacheHits: 0,
    sessionCacheMisses: 0,
    pendingSessionReuses: 0,
    externalCacheHits: 0,
    externalCacheMisses: 0,
    pendingExternalReuses: 0,
    externalResolverRuns: 0,
    baseSessionBuilds: 0,
    resolvedSessionBuilds: 0
  };
}

function externalResolutionKey(source: string, session: AnalysisSession): string | null {
  if (!session.ast) {
    return null;
  }
  return session.ast.body
    .filter((statement) =>
      statement instanceof ImportStatement ||
      (statement instanceof ExportStatement && statement.from !== undefined)
    )
    .map((statement) => {
      const start = statement.firstToken?.range.start.offset;
      const end = statement.lastToken?.range.end.offset;
      return start !== undefined && end !== undefined
        ? source.slice(start, end)
        : "";
    })
    .join("\0");
}

function buildSessionFromResolved(
  docText: string,
  baseSession: AnalysisSession,
  resolved: ResolvedExternals
): AnalysisSession {
  const externalDeclarations = resolved.externalDeclarations ?? [];
  const externalDeclarationLocations = resolved.externalDeclarationLocations ?? new Map();
  const importedSymbols = resolved.importedSymbols ?? new Map();
  const ambientDeclarations = resolved.ambientDeclarations ?? [];
  const ambientDeclarationLocations = resolved.ambientDeclarationLocations ?? new Map();
  const ambientModuleDeclarations = resolved.ambientModuleDeclarations ?? new Map();
  const ambientModuleLocations = resolved.ambientModuleLocations ?? new Map();
  const invalidImportedBindings = resolved.invalidImportedBindings ?? new Set();
  if (
    externalDeclarations.length === 0 &&
    externalDeclarationLocations.size === 0 &&
    importedSymbols.size === 0 &&
    invalidImportedBindings.size === 0 &&
    ambientDeclarations.length === 0 &&
    ambientDeclarationLocations.size === 0 &&
    ambientModuleDeclarations.size === 0
  ) {
    return baseSession;
  }
  return createAnalysisSession(docText, {
    externalDeclarations,
    externalDeclarationLocations,
    ambientDeclarations,
    ambientModuleDeclarations,
    ambientModuleLocations,
    invalidImportedBindings,
    ambientDeclarationLocations,
    importedSymbols
  });
}

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; session: AnalysisSession }>();
  // Pending stores version alongside the promise so getForDocumentAsync can
  // safely reuse an in-flight resolution only when it is for the same version.
  private readonly pending = new Map<string, { version: number; promise: Promise<AnalysisSession> }>();
  private readonly resolvedExternals = new Map<string, { key: string; resolved: ResolvedExternals }>();
  private readonly pendingExternals = new Map<string, { key: string; promise: Promise<ResolvedExternals> }>();
  private metrics = emptyAnalysisSessionCacheMetrics();

  constructor(
    private readonly resolveExternalDeclarations?: ExternalDeclarationsResolver,
    private readonly onSessionUpdated?: () => void
  ) {}

  getMetrics(): Readonly<AnalysisSessionCacheMetrics> {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = emptyAnalysisSessionCacheMetrics();
  }

  private resolveExternals(
    document: TextDocument,
    baseSession: AnalysisSession,
    resolver: ExternalDeclarationsResolver
  ): Promise<ResolvedExternals> {
    const key = externalResolutionKey(document.getText(), baseSession);
    if (key === null) {
      this.metrics.externalCacheMisses += 1;
      this.metrics.externalResolverRuns += 1;
      return Promise.resolve(resolver(document, baseSession));
    }
    const cached = this.resolvedExternals.get(document.uri);
    if (cached?.key === key) {
      this.metrics.externalCacheHits += 1;
      return Promise.resolve(cached.resolved);
    }
    const pending = this.pendingExternals.get(document.uri);
    if (pending?.key === key) {
      this.metrics.pendingExternalReuses += 1;
      return pending.promise;
    }

    this.metrics.externalCacheMisses += 1;
    this.metrics.externalResolverRuns += 1;

    let promise: Promise<ResolvedExternals>;
    promise = Promise.resolve(resolver(document, baseSession)).then((resolved) => {
      this.resolvedExternals.set(document.uri, { key, resolved });
      return resolved;
    }).finally(() => {
      if (this.pendingExternals.get(document.uri)?.promise === promise) {
        this.pendingExternals.delete(document.uri);
      }
    });
    this.pendingExternals.set(document.uri, { key, promise });
    return promise;
  }

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
        const resolved = await this.resolveExternals(document, baseSession, resolveExternalDeclarations);
        const session = buildSessionFromResolved(docText, baseSession, resolved);
        this.metrics.resolvedSessionBuilds += 1;
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
    this.metrics.synchronousRequests += 1;
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      this.metrics.sessionCacheHits += 1;
      return cached.session;
    }

    this.metrics.sessionCacheMisses += 1;

    const docText = document.getText();
    const docVersion = document.version;
    const docUri = document.uri;
    const baseSession = createAnalysisSession(docText);
    this.metrics.baseSessionBuilds += 1;

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
    this.metrics.asynchronousRequests += 1;
    const cached = this.cache.get(document.uri);
    if (cached && cached.version === document.version) {
      this.metrics.sessionCacheHits += 1;
      return cached.session;
    }

    // Reuse an in-flight resolution only when it is for the same document version
    const pending = this.pending.get(document.uri);
    if (pending && pending.version === document.version) {
      this.metrics.pendingSessionReuses += 1;
      return pending.promise;
    }

    this.metrics.sessionCacheMisses += 1;

    const docText = document.getText();
    const baseSession = createAnalysisSession(docText);
    this.metrics.baseSessionBuilds += 1;
    return this.startAsyncResolution(document, baseSession);
  }

  delete(uri: string): void {
    this.cache.delete(uri);
    this.pending.delete(uri);
    this.resolvedExternals.delete(uri);
    this.pendingExternals.delete(uri);
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.resolvedExternals.clear();
    this.pendingExternals.clear();
  }
}
