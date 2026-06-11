import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { WorkspaceEdit } from "vscode-languageserver/node.js";
import { createAnalysisSession, type AnalysisSession } from "./lsp/analysisSession";
import { collectAllImportedDeclarations } from "./lsp/importedDeclarations";
import { createDefinitionLocation, createHover } from "./lsp/navigation";
import { pathToUri, uriToFilePath } from "./lsp/importFixes";
import { resolveDefinitionAcrossFiles, resolveReferencesAcrossFiles, resolveRenameAcrossFiles } from "./lsp/crossFileNavigation";
import { createSignatureHelp } from "./lsp/signatureHelp";
import { createDocumentSymbols, createWorkspaceSymbols } from "./lsp/symbols";
import { COMPILER_VERSION } from "./compilerVersion";
import { dirname, resolve } from "./utils/path";
import { vfs } from "./vfs";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type ToolArguments = Record<string, unknown>;

const POSITION_PROPERTIES = {
  file: { type: "string", description: "VexaScript source file path." },
  line: { type: "number", description: "Zero-based line number." },
  character: { type: "number", description: "Zero-based UTF-16 character offset." },
  root: { type: "string", description: "Optional workspace root. Defaults to the current working directory." }
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "vexa_workspace_symbols",
    description: "Search top-level symbols and class members across a VexaScript codebase.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive symbol-name filter. Empty string returns all symbols." },
        root: { type: "string", description: "Workspace root to scan. Defaults to the current working directory." }
      }
    }
  },
  {
    name: "vexa_document_symbols",
    description: "List document symbols for a single VexaScript file.",
    inputSchema: {
      type: "object",
      properties: { file: POSITION_PROPERTIES.file },
      required: ["file"]
    }
  },
  {
    name: "vexa_hover",
    description: "Return hover/type information at a source position.",
    inputSchema: {
      type: "object",
      properties: POSITION_PROPERTIES,
      required: ["file", "line", "character"]
    }
  },
  {
    name: "vexa_definition",
    description: "Navigate to the definition at a source position, including imported symbols and cross-file members.",
    inputSchema: {
      type: "object",
      properties: POSITION_PROPERTIES,
      required: ["file", "line", "character"]
    }
  },
  {
    name: "vexa_references",
    description: "Find references for the symbol at a source position across the codebase.",
    inputSchema: {
      type: "object",
      properties: {
        ...POSITION_PROPERTIES,
        includeDeclaration: { type: "boolean", description: "Whether to include the declaration location. Defaults to true." }
      },
      required: ["file", "line", "character"]
    }
  },
  {
    name: "vexa_signature_help",
    description: "Return call signature help for the invocation around a source position.",
    inputSchema: {
      type: "object",
      properties: POSITION_PROPERTIES,
      required: ["file", "line", "character"]
    }
  },
  {
    name: "vexa_rename",
    description: "Build or apply a cross-file rename for the symbol at a source position.",
    inputSchema: {
      type: "object",
      properties: {
        ...POSITION_PROPERTIES,
        newName: { type: "string", description: "Replacement symbol name." },
        apply: { type: "boolean", description: "When true, writes the rename to disk. Defaults to false and only returns the workspace edit." }
      },
      required: ["file", "line", "character", "newName"]
    }
  }
];

function asObject(value: unknown): ToolArguments {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as ToolArguments : {};
}

function requiredString(args: ToolArguments, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string argument "${name}"`);
  }
  return value;
}

function optionalString(args: ToolArguments, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumber(args: ToolArguments, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer argument "${name}"`);
  }
  return value;
}

function optionalBoolean(args: ToolArguments, name: string, fallback: boolean): boolean {
  const value = args[name];
  return typeof value === "boolean" ? value : fallback;
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function rootFromArgs(args: ToolArguments, cwd: string): string {
  return resolve(cwd, optionalString(args, "root") ?? ".");
}

function fileFromArgs(args: ToolArguments, cwd: string): string {
  return resolve(cwd, requiredString(args, "file"));
}

function editStartOffset(source: string, line: number, character: number): number {
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line) {
    const next = source.indexOf("\n", offset);
    if (next < 0) {
      return source.length;
    }
    offset = next + 1;
    currentLine += 1;
  }
  return Math.min(source.length, offset + character);
}

async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<string[]> {
  const changedFiles: string[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const filePath = uriToFilePath(uri);
    if (!filePath || edits.length === 0) {
      continue;
    }
    const source = await vfs().readFile(filePath);
    const ordered = [...edits].sort((a, b) => {
      const lineDelta = b.range.start.line - a.range.start.line;
      return lineDelta !== 0 ? lineDelta : b.range.start.character - a.range.start.character;
    });
    let updated = source;
    for (const editItem of ordered) {
      const start = editStartOffset(updated, editItem.range.start.line, editItem.range.start.character);
      const end = editStartOffset(updated, editItem.range.end.line, editItem.range.end.character);
      updated = `${updated.slice(0, start)}${editItem.newText}${updated.slice(end)}`;
    }
    await vfs().writeFile(filePath, updated);
    changedFiles.push(filePath);
  }
  return changedFiles;
}

export class VexaMcpCodebaseServer {
  private readonly sessionCache = new Map<string, Promise<AnalysisSession>>();

  constructor(private readonly cwd: string = process.cwd()) {}

  tools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  private async sessionForFile(filePath: string, sourceRoots: string[]): Promise<AnalysisSession> {
    const resolvedPath = resolve(filePath);
    const cached = this.sessionCache.get(resolvedPath);
    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const source = await vfs().readFile(resolvedPath);
      const baseSession = createAnalysisSession(source);
      if (!baseSession.ast) {
        return baseSession;
      }
      const uri = pathToUri(resolvedPath);
      const context = {
        uri,
        sourceRoots,
        getSessionForFilePath: async (nextPath: string) => this.sessionForFile(nextPath, sourceRoots)
      };
      const { externalDeclarations, importedSymbolTypes } = await collectAllImportedDeclarations(baseSession.ast, context);
      return externalDeclarations.length > 0 || importedSymbolTypes.size > 0
        ? createAnalysisSession(source, externalDeclarations, importedSymbolTypes)
        : baseSession;
    })();
    this.sessionCache.set(resolvedPath, promise);
    return promise;
  }

  private async navigationContext(args: ToolArguments) {
    const filePath = fileFromArgs(args, this.cwd);
    const root = rootFromArgs(args, this.cwd);
    const sourceRoots = [root];
    const session = await this.sessionForFile(filePath, sourceRoots);
    return {
      uri: pathToUri(filePath),
      line: requiredNumber(args, "line"),
      character: requiredNumber(args, "character"),
      session,
      sourceRoots,
      getSessionForFilePath: async (nextPath: string) => this.sessionForFile(nextPath, sourceRoots)
    };
  }

  async callTool(name: string, rawArguments: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const args = asObject(rawArguments);
    switch (name) {
      case "vexa_workspace_symbols":
        return textResult(await createWorkspaceSymbols({
          sourceRoots: [rootFromArgs(args, this.cwd)],
          query: optionalString(args, "query") ?? ""
        }));
      case "vexa_document_symbols": {
        const session = await this.sessionForFile(fileFromArgs(args, this.cwd), [dirname(fileFromArgs(args, this.cwd))]);
        return textResult(session.ast ? createDocumentSymbols(session.ast) : []);
      }
      case "vexa_hover": {
        const context = await this.navigationContext(args);
        const localHover = context.session.analysis ? createHover(context.session.analysis, context.line, context.character) : null;
        return textResult(localHover);
      }
      case "vexa_definition": {
        const context = await this.navigationContext(args);
        const crossFile = await resolveDefinitionAcrossFiles(context);
        const local = !crossFile && context.session.analysis
          ? createDefinitionLocation(context.session.analysis, context.uri, context.line, context.character)
          : null;
        return textResult(crossFile ?? local);
      }
      case "vexa_references": {
        const context = await this.navigationContext(args);
        return textResult(await resolveReferencesAcrossFiles(context, optionalBoolean(args, "includeDeclaration", true)));
      }
      case "vexa_signature_help": {
        const context = await this.navigationContext(args);
        const help = context.session.ast && context.session.analysis
          ? await createSignatureHelp(context.session.ast, context.session.analysis, context.line, context.character, context)
          : null;
        return textResult(help);
      }
      case "vexa_rename": {
        const context = await this.navigationContext(args);
        const edit = await resolveRenameAcrossFiles(context, requiredString(args, "newName"));
        if (!edit || !optionalBoolean(args, "apply", false)) {
          return textResult({ edit });
        }
        const changedFiles = await applyWorkspaceEdit(edit);
        return textResult({ edit, changedFiles });
      }
      default:
        throw new Error(`Unknown MCP tool "${name}"`);
    }
  }

  async handleRequest(request: JsonRpcRequest): Promise<unknown | undefined> {
    if (request.id === undefined || request.id === null) {
      return undefined;
    }
    try {
      if (request.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "vexa", version: COMPILER_VERSION }
          }
        };
      }
      if (request.method === "tools/list") {
        return { jsonrpc: "2.0", id: request.id, result: { tools: this.tools() } };
      }
      if (request.method === "tools/call") {
        const params = asObject(request.params);
        const name = requiredString(params, "name");
        const result = await this.callTool(name, params["arguments"]);
        return { jsonrpc: "2.0", id: request.id, result };
      }
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method ?? "<missing>"}` } };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

export async function runMcpServer(options: { input?: Readable; output?: Writable; cwd?: string } = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const server = new VexaMcpCodebaseServer(options.cwd ?? process.cwd());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const request = JSON.parse(trimmed) as JsonRpcRequest;
    const response = await server.handleRequest(request);
    if (response !== undefined) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
