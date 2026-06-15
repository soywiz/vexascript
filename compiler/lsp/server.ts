/**
 * Node.js (stdio) LSP server entry point.
 *
 * All request handlers live in the shared `serverCore.ts`; this module only
 * wires the stdio transport and the workspace-aware environment: source roots
 * from the initialize params, the project index that mirrors open documents,
 * DOM ambient declarations from the project configuration, and watched-file
 * invalidation.
 */
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  type InitializeParams
} from "vscode-languageserver/node.js";
import { TextDocument as LspTextDocument } from "vscode-languageserver-textdocument";
import { AnalysisSessionCache } from "./analysisSession";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { ensureEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadProject } from "compiler/project";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { getProjectIndex, type ProjectIndex } from "./projectAnalysis";
import { uriToFilePath } from "./importFixes";
import { startLspServer } from "./serverCore";
import { resolve as resolvePath } from "compiler/utils/path";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(LspTextDocument);
let sourceRoots: string[] = [];
let projectIndex: ProjectIndex = getProjectIndex([]);
const REFRESH_DIAGNOSTICS_COMMAND = "vexa.refreshDiagnostics";

function resolveSourceRoots(params: InitializeParams): string[] {
  const roots: string[] = [];
  for (const folder of params.workspaceFolders ?? []) {
    const path = uriToFilePath(folder.uri);
    if (path) {
      roots.push(path);
    }
  }

  if (roots.length === 0) {
    const rootUri = params.rootUri ?? undefined;
    const rootPath = rootUri ? uriToFilePath(rootUri) : params.rootPath ?? undefined;
    if (rootPath) {
      roots.push(rootPath);
    }
  }

  return roots;
}

async function getSessionForFilePathFromOpenDocuments(filePath: string) {
  return projectIndex.getSessionForFilePath(resolvePath(filePath));
}

const analysisSessions = new AnalysisSessionCache(async (document, baseSession) => {
  if (!baseSession.ast) {
    return {
      externalDeclarations: [],
      importedSymbolTypes: new Map(),
      importedSymbolDisplayTypes: new Map(),
      ambientDeclarations: [],
      ambientModuleDeclarations: new Map()
    };
  }
  const filePath = uriToFilePath(document.uri);

  // Load ambient types from tsconfig compilerOptions.types (e.g. @types/node)
  const project = filePath ? await loadProject(filePath) : null;
  const ambientTypes = await loadAmbientTypesForProject(filePath, project?.types ?? []);

  // Load DOM declarations if tsconfig lib includes "dom"
  const domDeclarations = (project?.libs ?? []).some((lib) => lib.toLowerCase() === "dom")
    ? (await ensureDomProgram()).body
    : [];
  const domDeclarationLocations = domDeclarations.length === 0
    ? new Map()
    : new Map(domDeclarations.map((statement) => [
      statement,
      {
        filePath: getDomDeclarationFilePath(),
        line: statement.firstToken?.range.start.line ?? 0,
        character: statement.firstToken?.range.start.column ?? 0
      }
    ]));

  const context = {
    uri: document.uri,
    sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    ambientModuleDeclarations: ambientTypes.moduleDeclarations,
    ambientGlobalDeclarations: ambientTypes.globalDeclarations
  };
  const { externalDeclarations, importedSymbolTypes, importedSymbolDisplayTypes, invalidImportedBindings } =
    await collectAllImportedDeclarations(baseSession.ast, context);

  return {
    externalDeclarations,
    importedSymbolTypes,
    importedSymbolDisplayTypes,
    invalidImportedBindings,
    ambientDeclarations: [...domDeclarations, ...ambientTypes.globalDeclarations],
    ambientDeclarationLocations: new Map([
      ...domDeclarationLocations,
      ...ambientTypes.globalDeclarationLocations
    ]),
    ambientModuleDeclarations: ambientTypes.moduleDeclarations,
    ambientModuleLocations: ambientTypes.moduleDeclarationLocations
  };
}, () => connection.languages.diagnostics.refresh());

// Ensure runtime is loaded on server start (non-blocking background load)
ensureEcmaScriptRuntimeProgram().catch(() => undefined);

function syncOpenDocumentWithProjectIndex(document: LspTextDocument): void {
  const filePath = uriToFilePath(document.uri);
  if (filePath) {
    projectIndex.upsertOpenDocument(filePath, document.getText()).catch(() => undefined);
  }
}

startLspServer({
  connection,
  documents,
  analysisSessions,
  environment: {
    getSourceRoots: () => sourceRoots,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    onInitialize: (params) => {
      sourceRoots = resolveSourceRoots(params);
      projectIndex = getProjectIndex(sourceRoots);
    },
    onDocumentOpenedOrChanged: syncOpenDocumentWithProjectIndex,
    onDocumentClosed: (document) => {
      const filePath = uriToFilePath(document.uri);
      if (filePath) {
        projectIndex.clearOpenDocument(filePath);
        projectIndex.invalidateFile(filePath);
      }
    },
    workspace: {
      refreshDiagnosticsCommand: REFRESH_DIAGNOSTICS_COMMAND,
      onWatchedFileChanged: (filePath) => projectIndex.invalidateFile(filePath)
    }
  }
});
