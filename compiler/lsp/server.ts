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
import { loadGlobalSymbolDeclarationFiles } from "compiler/runtime/moduleGraph";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadProject } from "compiler/project";
import { loadAmbientTypesForProject } from "./ambientTypesLoader";
import { getProjectIndex, type ProjectIndex } from "./projectAnalysis";
import { uriToFilePath } from "./importFixes";
import { startLspServer } from "./serverCore";
import { resolve as resolvePath } from "compiler/utils/path";
import { setVfs, Vfs, type VfsDirEntry, type VfsStat } from "compiler/vfs";

interface NodeDirentLike {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

interface NodeFsPromisesLike {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string, options: { withFileTypes: true }): Promise<NodeDirentLike[]>;
  stat(path: string): Promise<{ mtimeMs: number; isFile(): boolean; isDirectory(): boolean }>;
  writeFile(path: string, content: string | NodeJS.ArrayBufferView): Promise<void>;
  unlink(path: string): Promise<void>;
}

class NodeServerVfs extends Vfs {
  private readonly fsPromises: NodeFsPromisesLike;

  constructor() {
    super();
    const builtinLoader = process.getBuiltinModule;
    if (typeof builtinLoader !== "function") {
      throw new Error("Node builtins are unavailable in this runtime");
    }

    const builtin = builtinLoader("node:fs/promises");
    if (!builtin || typeof builtin !== "object") {
      throw new Error("node:fs/promises is unavailable in this runtime");
    }

    this.fsPromises = builtin as NodeFsPromisesLike;
  }

  override async readFile(path: string): Promise<string> {
    return await this.fsPromises.readFile(path, "utf8");
  }

  override async writeFile(path: string, content: string | ArrayBufferView): Promise<void> {
    await this.fsPromises.writeFile(path, content as string | NodeJS.ArrayBufferView);
  }

  override async unlink(path: string): Promise<void> {
    await this.fsPromises.unlink(path);
  }

  override async stat(path: string): Promise<VfsStat> {
    try {
      const stats = await this.fsPromises.stat(path);
      return {
        mtimeMs: stats.mtimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory()
      };
    } catch {
      throw new Error(`File '${path}' doesn't exists`);
    }
  }

  override async readDir(path: string): Promise<VfsDirEntry[]> {
    try {
      const entries = await this.fsPromises.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory()
      }));
    } catch {
      throw new Error(`File '${path} doesn't exists`);
    }
  }
}

setVfs(new NodeServerVfs());

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(LspTextDocument);
let sourceRoots: string[] = [];
let importMappings: Readonly<Record<string, string>> = {};
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
      importedSymbols: new Map(),
      ambientDeclarations: [],
      ambientModuleDeclarations: new Map()
    };
  }
  const filePath = uriToFilePath(document.uri);

  // Load ambient types from tsconfig compilerOptions.types (e.g. @types/node)
  const project = filePath ? await loadProject(filePath) : null;
  if (project) {
    importMappings = project.importMappings ?? {};
    projectIndex = getProjectIndex(sourceRoots, undefined, importMappings);
  }
  const ambientTypes = await loadAmbientTypesForProject(filePath, project?.types ?? []);

  // Load DOM declarations if tsconfig lib includes "dom"
  const domDeclarations = (project?.libs ?? []).some((lib) => lib.toLowerCase() === "dom")
    ? (await ensureDomProgram()).body
    : [];
  const globalDeclarationFiles = project?.globalSymbols ? await loadGlobalSymbolDeclarationFiles(project.globalSymbols.paths) : [];
  const globalDeclarations = globalDeclarationFiles.flatMap((file) => file.declarations);
  const globalDeclarationLocations = new Map(globalDeclarationFiles.flatMap((file) =>
    file.declarations.map((statement) => [
      statement,
      {
        filePath: file.filePath,
        line: statement.firstToken?.range.start.line ?? 0,
        character: statement.firstToken?.range.start.column ?? 0
      }
    ] as const)
  ));
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
    importMappings,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    ambientModuleDeclarations: ambientTypes.moduleDeclarations,
    ambientGlobalDeclarations: ambientTypes.globalDeclarations
  };
  const {
    externalDeclarations,
    importedSymbols,
    invalidImportedBindings
  } =
    await collectAllImportedDeclarations(baseSession.ast, context);

  return {
    externalDeclarations,
    importedSymbols,
    invalidImportedBindings,
    ambientDeclarations: [...globalDeclarations, ...ambientTypes.globalDeclarations, ...domDeclarations],
    ambientDeclarationLocations: new Map([
      ...globalDeclarationLocations,
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
    loadProject(filePath).then((project) => {
      if (project) {
        importMappings = project.importMappings ?? {};
        projectIndex = getProjectIndex(sourceRoots, undefined, importMappings);
      }
    }).catch(() => undefined);
    projectIndex.upsertOpenDocument(filePath, document.getText()).catch(() => undefined);
  }
}

startLspServer({
  connection,
  documents,
  analysisSessions,
  environment: {
    getSourceRoots: () => sourceRoots,
    getImportMappings: () => importMappings,
    getSessionForFilePath: getSessionForFilePathFromOpenDocuments,
    onInitialize: (params) => {
      sourceRoots = resolveSourceRoots(params);
      projectIndex = getProjectIndex(sourceRoots, undefined, importMappings);
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
