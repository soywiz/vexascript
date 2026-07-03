// @ts-nocheck
import { collectTopLevelDeclarationsFromAst } from "compiler/analysis/projectIndex";
import type { Statement } from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import {
  ensureEcmaScriptRuntimeProgram,
  ensureVexaScriptRuntimeProgram,
} from "compiler/runtime/ecmascriptDeclarations";
import { createAnalysisSession } from "compiler/lsp/analysisSession";
import { createAutoAwaitDecorations } from "compiler/lsp/autoAwaitDecorations";
import { collectCodeActions } from "compiler/lsp/codeActionsAggregate";
import {
  createCompletionItemsForPosition,
  createKeywordOnlyCompletionItems,
} from "compiler/lsp/completion";
import { createClassResolverCache } from "compiler/lsp/classResolver";
import { collectDeprecatedSemanticTokenModifiers } from "compiler/lsp/deprecatedSemanticTokens";
import {
  createDocumentHighlights,
  createFoldingRanges,
  createSelectionRanges,
} from "compiler/lsp/documentFeatures";
import { collectAllImportedDeclarations } from "compiler/lsp/importedDeclarations";
import { createInlayHints } from "compiler/lsp/inlayHints";
import {
  createPrepareRename,
  createHover,
} from "compiler/lsp/navigation";
import {
  resolveDefinitionWithLocalFallback,
  resolveReferencesAcrossFiles,
  resolveMemberHoverAcrossFiles,
  resolveRenameAcrossFiles,
} from "compiler/lsp/crossFileNavigation";
import { createSignatureHelp } from "compiler/lsp/signatureHelp";
import { createDocumentSymbols } from "compiler/lsp/symbols";
import { createSemanticTokens } from "compiler/lsp/semanticTokens";
import { setVfs } from "compiler/vfs";
import type { AmbientModuleLocation } from "compiler/lsp/ambientTypesLoader";
import type { SymbolExport } from "compiler/lsp/importFixes";
import {
  bundledDomRuntimeUrl,
  bundledRuntimeUrl,
  bundledVexaRuntimeUrl,
} from "../../generated/embed-asset-manifest";
import { WorkspaceVfs } from "./workspaceVfs";
import { createCachedWorkspaceSessionResolver } from "./workspaceSessions";
import { collectWorkspaceDiagnostics } from "./workspaceDiagnostics";
import {
  createFileEntry,
  createFolderEntry,
  pathToUri,
  updateFileContent,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "./workspace";
import {
  normalizeWorkspacePath as normalizePath,
  workspacePathBasename as basename,
  workspacePathDirname as dirname,
} from "./workspacePaths";

type WorkerRequest = {
  id: number;
  feature: string;
  snapshot: WorkerSnapshot;
  params?: Record<string, unknown>;
};

type WorkerSnapshot = {
  uri: string;
  path: string;
  source: string;
  entries: WorkspaceEntry[];
  importMappings?: Record<string, string>;
  globalSymbols?: { paths: string[]; emit?: "globalThis" | "assume" };
};

const RUNTIME_LOADING_PLACEHOLDER = "// Loading runtime declarations...\n";

let cachedDomAmbientDeclarations: Statement[] | null = null;
let bundledRuntimeContent: string | null = null;
let bundledVexaRuntimeContent: string | null = null;
let bundledDomRuntimeContent: string | null = null;
let bundledRuntimeLoadPromise: Promise<{ runtime: string; vexa: string; dom: string }> | null = null;
let embeddedRuntimeReadyPromise: Promise<void> | null = null;

function normalizeDomSourceForParser(source: string): string {
  return source.replace(/`[^`]*`/g, "string");
}

async function loadTextAsset(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load asset: ${url}`);
  }
  return response.text();
}

function ensureBundledRuntimeContents(): Promise<{ runtime: string; vexa: string; dom: string }> {
  if (bundledRuntimeContent !== null && bundledVexaRuntimeContent !== null && bundledDomRuntimeContent !== null) {
    return Promise.resolve({
      runtime: bundledRuntimeContent,
      vexa: bundledVexaRuntimeContent,
      dom: bundledDomRuntimeContent,
    });
  }
  if (!bundledRuntimeLoadPromise) {
    bundledRuntimeLoadPromise = Promise.all([
      loadTextAsset(bundledRuntimeUrl),
      loadTextAsset(bundledVexaRuntimeUrl),
      loadTextAsset(bundledDomRuntimeUrl),
    ]).then(([runtime, vexa, dom]) => {
      bundledRuntimeContent = runtime;
      bundledVexaRuntimeContent = vexa;
      bundledDomRuntimeContent = dom;
      return { runtime, vexa, dom };
    });
  }
  return bundledRuntimeLoadPromise;
}

function ensureEmbeddedRuntimeReady(): Promise<void> {
  if (!embeddedRuntimeReadyPromise) {
    embeddedRuntimeReadyPromise = Promise.all([
      ensureBundledRuntimeContents(),
      ensureEcmaScriptRuntimeProgram(),
      ensureVexaScriptRuntimeProgram(),
      getDomAmbientDeclarations(),
    ]).then(() => undefined);
  }
  return embeddedRuntimeReadyPromise;
}

function createBundledRuntimeEntries(): WorkspaceEntry[] {
  return [
    createFolderEntry("/runtime", true),
    createFileEntry("/runtime/es2025.d.ts", bundledRuntimeContent ?? RUNTIME_LOADING_PLACEHOLDER, {
      language: "vexa",
      readOnly: true,
      uri: pathToUri("/runtime/es2025.d.ts"),
    }),
    createFileEntry("/runtime/vexascript.d.vx", bundledVexaRuntimeContent ?? RUNTIME_LOADING_PLACEHOLDER, {
      language: "vexa",
      readOnly: true,
      uri: pathToUri("/runtime/vexascript.d.vx"),
    }),
    createFileEntry("/runtime/dom.d.ts", bundledDomRuntimeContent ?? RUNTIME_LOADING_PLACEHOLDER, {
      language: "vexa",
      readOnly: true,
      uri: pathToUri("/runtime/dom.d.ts"),
    }),
  ];
}

function isRuntimeDeclarationPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === "/runtime/dom.d.ts"
    || normalized === "/runtime/es2025.d.ts"
    || normalized === "/runtime/vexascript.d.vx";
}

async function getDomAmbientDeclarations(): Promise<Statement[]> {
  if (cachedDomAmbientDeclarations) {
    return cachedDomAmbientDeclarations;
  }
  const { dom } = await ensureBundledRuntimeContents();
  const parsed = parseSource(normalizeDomSourceForParser(dom), { language: "typescript" });
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : []),
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(`Embedded DOM declarations must parse without errors: ${errors.join("; ")}`);
  }
  cachedDomAmbientDeclarations = parsed.ast.body;
  return cachedDomAmbientDeclarations;
}

function offsetToPosition(source: string, offset: number): { lineNumber: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  let lineNumber = 1;
  let lineStart = 0;
  for (let index = 0; index < safeOffset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      lineNumber += 1;
      lineStart = index + 1;
    }
  }
  return { lineNumber, column: safeOffset - lineStart + 1 };
}

function ensureFoldersForEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const folderPaths = new Set<string>(["/"]);
  for (const entry of entries) {
    let current = normalizePath(entry.path);
    if (entry.kind === "file") {
      current = dirname(current);
    }
    while (current !== "/") {
      folderPaths.add(current);
      current = dirname(current);
    }
  }
  const existingPaths = new Set(entries.map((entry) => entry.path));
  return [
    ...entries,
    ...[...folderPaths]
      .filter((path) => !existingPaths.has(path))
      .map((path) => createFolderEntry(path)),
  ];
}

function createWorkerContext(snapshot: WorkerSnapshot) {
  const entries = ensureFoldersForEntries([
    ...snapshot.entries.filter((entry) => !isRuntimeDeclarationPath(entry.path) && entry.path !== "/runtime"),
    ...createBundledRuntimeEntries(),
  ]);
  const importMappings = Object.fromEntries(
    Object.entries(snapshot.importMappings ?? {}).map(([specifier, targetPath]) => [specifier, normalizePath(targetPath)])
  );
  const globalSymbols = snapshot.globalSymbols
    ? {
        paths: snapshot.globalSymbols.paths.map((path) => normalizePath(path)),
        emit: snapshot.globalSymbols.emit ?? "globalThis" as const,
      }
    : undefined;

  const getWorkspaceFileSource = (uri: string): string | null => {
    if (uri === snapshot.uri) {
      return snapshot.source;
    }
    const entry = entries.find((candidate) => candidate.kind === "file" && candidate.uri === uri);
    return entry?.kind === "file" ? entry.content : null;
  };

  const workspaceVfs = new WorkspaceVfs({
    getEntries: () => entries,
    readWorkspaceFile: (uri) => getWorkspaceFileSource(uri),
  });
  setVfs(workspaceVfs);

  const globalSymbolFileEntries = (): WorkspaceFile[] => {
    const paths = globalSymbols?.paths ?? [];
    if (paths.length === 0) {
      return [];
    }
    return entries.filter((entry): entry is WorkspaceFile => {
      if (entry.kind !== "file" || entry.language !== "vexa") {
        return false;
      }
      return paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`));
    });
  };

  const getWorkspaceGlobalDeclarations = async () => {
    const declarations: Statement[] = [];
    const locations = new Map<Statement, AmbientModuleLocation>();
    for (const entry of globalSymbolFileEntries()) {
      const source = getWorkspaceFileSource(entry.uri) ?? entry.content;
      for (const statement of parseSource(source).ast?.body ?? []) {
        declarations.push(statement);
        locations.set(statement, {
          filePath: entry.path,
          line: statement.firstToken?.range.start.line ?? 0,
          character: statement.firstToken?.range.start.column ?? 0
        });
      }
    }
    return { declarations, locations };
  };

  const getWorkspaceSessionForFilePath = createCachedWorkspaceSessionResolver({
    getAmbientDeclarations: getDomAmbientDeclarations,
    getGlobalDeclarations: getWorkspaceGlobalDeclarations,
    getWorkspaceFileSource,
    getWorkspaceRevision: () => 0,
    isRuntimeDeclarationPath,
    pathToUri,
  });

  const getWorkspaceExportedSymbols = async (): Promise<SymbolExport[]> => {
    const symbols: SymbolExport[] = [];
    const aliasByPath = new Map(Object.entries(importMappings).map(([specifier, targetPath]) => [targetPath, specifier]));
    for (const entry of entries) {
      if (entry.kind !== "file" || entry.language !== "vexa") {
        continue;
      }
      const session = await getWorkspaceSessionForFilePath(entry.path);
      for (const declaration of collectTopLevelDeclarationsFromAst(session?.ast ?? null)) {
        symbols.push({
          name: declaration.name,
          kind: declaration.kind,
          filePath: entry.path,
          ...(aliasByPath.get(entry.path) ? { importPath: aliasByPath.get(entry.path) } : {}),
          ...(declaration.receiverType ? { receiverType: declaration.receiverType } : {}),
          ...(declaration.memberKind ? { memberKind: declaration.memberKind } : {}),
        });
      }
    }
    return symbols;
  };

  const resolverContext = {
    uri: snapshot.uri,
    sourceRoots: [],
    vfs: workspaceVfs,
    importMappings,
    getSessionForFilePath: getWorkspaceSessionForFilePath,
    getExportedSymbols: getWorkspaceExportedSymbols,
  };

  return {
    entries,
    importMappings,
    globalSymbols,
    workspaceVfs,
    getWorkspaceFileSource,
    getWorkspaceGlobalDeclarations,
    getWorkspaceSessionForFilePath,
    getWorkspaceExportedSymbols,
    resolverContext,
  };
}

async function createSession(snapshot: WorkerSnapshot, context: ReturnType<typeof createWorkerContext>) {
  const ambientDeclarations = await getDomAmbientDeclarations();
  if (isRuntimeDeclarationPath(snapshot.path)) {
    return createAnalysisSession(snapshot.source);
  }
  const { ast } = parseSource(snapshot.source);
  if (!ast) {
    return createAnalysisSession(snapshot.source, { ambientDeclarations });
  }
  const { externalDeclarations, importedSymbols, invalidImportedBindings } =
    await collectAllImportedDeclarations(ast, context.resolverContext);
  const globalDeclarations = await context.getWorkspaceGlobalDeclarations();
  return createAnalysisSession(snapshot.source, {
    externalDeclarations,
    ambientDeclarations: [...globalDeclarations.declarations, ...ambientDeclarations],
    ambientDeclarationLocations: globalDeclarations.locations,
    invalidImportedBindings,
    importedSymbols
  });
}

function toLspRange(range: any) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

async function runFeature(request: WorkerRequest): Promise<unknown> {
  await ensureEmbeddedRuntimeReady();
  const context = createWorkerContext(request.snapshot);
  const session = await createSession(request.snapshot, context);
  const params = request.params ?? {};

  switch (request.feature) {
    case "diagnostics":
      return collectWorkspaceDiagnostics(
        {
          uri: { toString: () => request.snapshot.uri },
          getValue: () => request.snapshot.source,
          getPositionAt: (offset: number) => offsetToPosition(request.snapshot.source, offset),
        },
        session,
        context
      );

    case "autoAwaitDecorations":
      return !session.ast || !session.analysis ? [] : createAutoAwaitDecorations(session.ast, session.analysis);

    case "completion": {
      if (!session.ast || !session.analysis) {
        return { keywordOnly: true, items: createKeywordOnlyCompletionItems() };
      }
      const items = await createCompletionItemsForPosition(
        session.ast,
        (params.lineNumber as number) - 1,
        (params.column as number) - 1,
        session.analysis,
        [],
        {
          text: request.snapshot.source,
          ...context.resolverContext,
          ambientDeclarations: session.ambientDeclarations,
          recoverAnalysisSession: (source: string) => createAnalysisSession(source, {
            externalDeclarations: session.externalDeclarations,
            ambientDeclarations: session.ambientDeclarations,
            ambientModuleDeclarations: session.ambientModuleDeclarations,
            ambientModuleLocations: session.ambientModuleLocations,
            invalidImportedBindings: session.invalidImportedBindings,
            ambientDeclarationLocations: session.ambientDeclarationLocations,
            importedSymbols: session.importedSymbols
          }),
          classResolverCache: createClassResolverCache(),
        }
      );
      return { keywordOnly: false, items };
    }

    case "hover": {
      if (!session.analysis || !session.ast) return null;
      return await resolveMemberHoverAcrossFiles({
        line: (params.lineNumber as number) - 1,
        character: (params.column as number) - 1,
        session,
        ...context.resolverContext,
      }) ?? createHover(session.analysis, (params.lineNumber as number) - 1, (params.column as number) - 1, session.ast ?? undefined);
    }

    case "signatureHelp":
      if (!session.ast || !session.analysis) return null;
      return createSignatureHelp(
        session.ast,
        session.analysis,
        (params.lineNumber as number) - 1,
        (params.column as number) - 1,
        {
          ...context.resolverContext,
          ambientDeclarations: session.ambientDeclarations,
          ambientModuleDeclarations: session.ambientModuleDeclarations,
          externalDeclarations: session.externalDeclarations,
        }
      );

    case "definition": {
      if (!session.analysis || !session.ast) return [];
      const location = await resolveDefinitionWithLocalFallback({
        line: (params.lineNumber as number) - 1,
        character: (params.column as number) - 1,
        session,
        ...context.resolverContext,
      });
      return location ? [location] : [];
    }

    case "references":
      if (!session.analysis || !session.ast) return [];
      return resolveReferencesAcrossFiles(
        {
          line: (params.lineNumber as number) - 1,
          character: (params.column as number) - 1,
          session,
          ...context.resolverContext,
        },
        Boolean(params.includeDeclaration)
      );

    case "renameLocation": {
      if (!session.analysis) return null;
      return createPrepareRename(
        session.analysis,
        (params.lineNumber as number) - 1,
        (params.column as number) - 1,
        session.ast ?? undefined
      );
    }

    case "renameEdits":
      if (!session.analysis || !session.ast) return { changes: {} };
      return await resolveRenameAcrossFiles({
        line: (params.lineNumber as number) - 1,
        character: (params.column as number) - 1,
        session,
        ...context.resolverContext,
      }, params.newName as string) ?? { changes: {} };

    case "codeActions":
      if (!session.ast) return [];
      return collectCodeActions({
        text: request.snapshot.source,
        ast: session.ast,
        analysis: session.analysis,
        range: params.range,
        diagnostics: params.diagnostics ?? [],
        ...context.resolverContext,
      });

    case "documentHighlights":
      if (!session.analysis) return [];
      return createDocumentHighlights(session.analysis, (params.lineNumber as number) - 1, (params.column as number) - 1);

    case "linkedEditingRanges": {
      if (!session.analysis) return null;
      const ranges = session.analysis.getRenameRangesAt((params.lineNumber as number) - 1, (params.column as number) - 1);
      return ranges.length <= 1 ? null : ranges;
    }

    case "documentSymbols":
      return session.ast ? createDocumentSymbols(session.ast) : [];

    case "foldingRanges":
      return session.ast ? createFoldingRanges(session.ast) : [];

    case "selectionRanges":
      return session.ast
        ? createSelectionRanges(session.ast, (params.positions as Array<{ lineNumber: number; column: number }>).map((position) => ({
            line: position.lineNumber - 1,
            character: position.column - 1,
          })))
        : [];

    case "inlayHints":
      return !session.ast || !session.analysis
        ? []
        : createInlayHints(session.ast, session.analysis, toLspRange(params.range), context.resolverContext);

    case "semanticTokens": {
      const tokenModifiersByRangeKey = await collectDeprecatedSemanticTokenModifiers({
        ...context.resolverContext,
        session,
      });
      return createSemanticTokens({
        text: request.snapshot.source,
        ast: session.ast,
        analysis: session.analysis,
        ...(params.range ? { range: toLspRange(params.range) } : {}),
        tokenModifiersByRangeKey,
      })?.data ?? [];
    }

    default:
      throw new Error(`Unknown VexaScript language worker feature: ${request.feature}`);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void runFeature(request)
    .then((result) => {
      self.postMessage({ id: request.id, result });
    })
    .catch((error) => {
      self.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
