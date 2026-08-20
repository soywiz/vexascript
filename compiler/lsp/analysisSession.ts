import type { Analysis, AnalysisIssue, AnalysisProfileEvent } from "compiler/analysis/Analysis";
import { ExportStatement, ImportStatement, type Program, type Statement } from "compiler/ast/ast";
import type { ParseIssue } from "compiler/parser/parser";
import type { TokenizeError } from "compiler/parser/tokenizer";
import { compileSource } from "compiler/pipeline/compile";
import { parseSource } from "compiler/pipeline/parse";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { AmbientModuleLocation } from "./ambientTypesLoader";
import {
  normalizeImportedSymbolSources,
  type ImportedSymbolResolution
} from "compiler/importedSymbols";
import { monotonicNow } from "compiler/utils/time";

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
  profile?: (event: AnalysisProfileEvent) => void;
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
    projectOwnedExternalDeclarations: options.projectOwnedExternalDeclarations === true,
    ...(options.profile ? { profile: options.profile } : {})
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

export interface AnalysisSessionBuildProfileEvent extends AnalysisProfileEvent {
  uri: string;
  version: number;
  build: "base" | "resolved";
}

export interface AnalysisSessionBuildTotalProfileEvent {
  uri: string;
  version: number;
  build: "base" | "resolved";
  phase: "total";
  elapsedMs: number;
}

export type AnalysisSessionCacheProfileEvent =
  | AnalysisSessionBuildProfileEvent
  | AnalysisSessionBuildTotalProfileEvent;

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

function externalResolutionKeyFromProgram(source: string, program: Program | null): string | null {
  if (!program) {
    return null;
  }
  return program.body
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

function externalResolutionKey(source: string, session: AnalysisSession): string | null {
  return externalResolutionKeyFromProgram(source, session.ast);
}

function externalResolutionKeyFromSource(source: string): string | null {
  return externalResolutionKeyFromProgram(source, parseSource(source).ast);
}

function createSessionFromResolved(
  docText: string,
  resolved: ResolvedExternals,
  profile?: (event: AnalysisProfileEvent) => void
): AnalysisSession {
  return createAnalysisSession(docText, {
    externalDeclarations: resolved.externalDeclarations ?? [],
    externalDeclarationLocations: resolved.externalDeclarationLocations ?? new Map(),
    ambientDeclarations: resolved.ambientDeclarations ?? [],
    ambientModuleDeclarations: resolved.ambientModuleDeclarations ?? new Map(),
    ambientModuleLocations: resolved.ambientModuleLocations ?? new Map(),
    invalidImportedBindings: resolved.invalidImportedBindings ?? new Set(),
    ambientDeclarationLocations: resolved.ambientDeclarationLocations ?? new Map(),
    importedSymbols: resolved.importedSymbols ?? new Map(),
    ...(profile ? { profile } : {})
  });
}

function buildSessionFromResolved(
  docText: string,
  baseSession: AnalysisSession,
  resolved: ResolvedExternals,
  profile?: (event: AnalysisProfileEvent) => void
): AnalysisSession {
  const externalDeclarations = resolved.externalDeclarations ?? [];
  const externalDeclarationLocations = resolved.externalDeclarationLocations ?? new Map();
  const importedSymbols = resolved.importedSymbols ?? new Map();
  const ambientDeclarations = resolved.ambientDeclarations ?? [];
  const ambientDeclarationLocations = resolved.ambientDeclarationLocations ?? new Map();
  const ambientModuleDeclarations = resolved.ambientModuleDeclarations ?? new Map();
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
  return createSessionFromResolved(docText, resolved, profile);
}

export class AnalysisSessionCache {
  private readonly cache = new Map<string, { version: number; source: string; session: AnalysisSession }>();
  // Pending stores both version and source so no-op version changes can reuse
  // the exact same in-flight semantic work.
  private readonly pending = new Map<string, {
    version: number;
    source: string;
    promise: Promise<AnalysisSession>;
  }>();
  private readonly resolvedExternals = new Map<string, { key: string; resolved: ResolvedExternals }>();
  private readonly pendingExternals = new Map<string, { key: string; promise: Promise<ResolvedExternals> }>();
  private metrics = emptyAnalysisSessionCacheMetrics();
  private profileObserver: ((event: AnalysisSessionCacheProfileEvent) => void) | undefined;
  private sessionUpdatedObserver: ((document: TextDocument) => void) | undefined;

  constructor(
    private readonly resolveExternalDeclarations?: ExternalDeclarationsResolver
  ) {}

  getMetrics(): Readonly<AnalysisSessionCacheMetrics> {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = emptyAnalysisSessionCacheMetrics();
  }

  setProfileObserver(observer: ((event: AnalysisSessionCacheProfileEvent) => void) | undefined): void {
    this.profileObserver = observer;
  }

  setSessionUpdatedObserver(observer: ((document: TextDocument) => void) | undefined): void {
    this.sessionUpdatedObserver = observer;
  }

  peekForDocument(document: TextDocument): AnalysisSession | undefined {
    return this.cachedSessionForDocument(document);
  }

  peekPendingForDocument(document: TextDocument): Promise<AnalysisSession> | undefined {
    const pending = this.pending.get(document.uri);
    if (!pending) {
      return undefined;
    }
    return pending.version === document.version || pending.source === document.getText()
      ? pending.promise
      : undefined;
  }

  private createTrackedSession(
    document: TextDocument,
    source: string,
    build: "base" | "resolved",
    resolved?: ResolvedExternals
  ): AnalysisSession {
    const observer = this.profileObserver;
    const profile = observer
      ? (event: AnalysisProfileEvent) => observer({
          ...event,
          uri: document.uri,
          version: document.version,
          build
        })
      : undefined;
    const startedAt = monotonicNow();
    const session = resolved
      ? createSessionFromResolved(source, resolved, profile)
      : createAnalysisSession(source, profile ? { profile } : {});
    observer?.({
      uri: document.uri,
      version: document.version,
      build,
      phase: "total",
      elapsedMs: monotonicNow() - startedAt
    });
    return session;
  }

  private cachedExternalsForSource(document: TextDocument, source: string): ResolvedExternals | undefined {
    const key = externalResolutionKeyFromSource(source);
    const cached = this.resolvedExternals.get(document.uri);
    if (key === null || cached?.key !== key) {
      return undefined;
    }
    this.metrics.externalCacheHits += 1;
    return cached.resolved;
  }

  private cachedSessionForDocument(document: TextDocument): AnalysisSession | undefined {
    const cached = this.cache.get(document.uri);
    if (!cached) {
      return undefined;
    }
    if (cached.version !== document.version && cached.source !== document.getText()) {
      return undefined;
    }
    if (cached.version !== document.version) {
      this.cache.set(document.uri, { ...cached, version: document.version });
    }
    return cached.session;
  }

  private cacheResolvedSession(document: TextDocument, source: string, session: AnalysisSession): void {
    const current = this.cache.get(document.uri);
    if (!current || current.version <= document.version) {
      this.cache.set(document.uri, { version: document.version, source, session });
      this.sessionUpdatedObserver?.(document);
    }
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
      this.cacheResolvedSession(document, docText, baseSession);
      return Promise.resolve(baseSession);
    }
    let pendingPromise: Promise<AnalysisSession> | undefined;
    pendingPromise = (async () => {
      try {
        const resolved = await this.resolveExternals(document, baseSession, resolveExternalDeclarations);
        const buildStartedAt = monotonicNow();
        const session = buildSessionFromResolved(
          docText,
          baseSession,
          resolved,
          (event) => this.profileObserver?.({
            ...event,
            uri: document.uri,
            version: document.version,
            build: "resolved"
          })
        );
        this.profileObserver?.({
          uri: document.uri,
          version: document.version,
          build: "resolved",
          phase: "total",
          elapsedMs: monotonicNow() - buildStartedAt
        });
        this.metrics.resolvedSessionBuilds += 1;
        this.cacheResolvedSession(document, docText, session);
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
    this.pending.set(docUri, { version: docVersion, source: docText, promise: pendingPromise });
    return pendingPromise;
  }

  getForDocument(document: TextDocument): AnalysisSession {
    this.metrics.synchronousRequests += 1;
    const cached = this.cache.get(document.uri);
    const cachedSession = this.cachedSessionForDocument(document);
    if (cachedSession) {
      this.metrics.sessionCacheHits += 1;
      return cachedSession;
    }

    this.metrics.sessionCacheMisses += 1;

    const docText = document.getText();
    const docVersion = document.version;
    const docUri = document.uri;
    const cachedExternals = this.resolveExternalDeclarations
      ? this.cachedExternalsForSource(document, docText)
      : undefined;
    if (cachedExternals) {
      const session = this.createTrackedSession(document, docText, "resolved", cachedExternals);
      this.metrics.resolvedSessionBuilds += 1;
      this.cacheResolvedSession(document, docText, session);
      return session;
    }
    const baseSession = this.createTrackedSession(document, docText, "base");
    this.metrics.baseSessionBuilds += 1;

    if (!this.resolveExternalDeclarations) {
      this.cacheResolvedSession(document, docText, baseSession);
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
    const cachedSession = this.cachedSessionForDocument(document);
    if (cachedSession) {
      this.metrics.sessionCacheHits += 1;
      return cachedSession;
    }

    // A no-op version bump represents the same semantic input and can share
    // the exact in-flight resolution.
    const pending = this.pending.get(document.uri);
    if (
      pending
      && (pending.version === document.version || pending.source === document.getText())
    ) {
      this.metrics.pendingSessionReuses += 1;
      return pending.promise;
    }

    this.metrics.sessionCacheMisses += 1;

    const docText = document.getText();
    const cachedExternals = this.resolveExternalDeclarations
      ? this.cachedExternalsForSource(document, docText)
      : undefined;
    if (cachedExternals) {
      const session = this.createTrackedSession(document, docText, "resolved", cachedExternals);
      this.metrics.resolvedSessionBuilds += 1;
      this.cacheResolvedSession(document, docText, session);
      return session;
    }
    const baseSession = this.createTrackedSession(document, docText, "base");
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
