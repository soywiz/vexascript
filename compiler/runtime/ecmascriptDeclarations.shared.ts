import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { getRuntimeDeclarationsHost } from "./declarationHost";

export const TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME = "es2025.d.ts";
const EXTRA_RUNTIME_DECLARATIONS = "declare var globalThis: typeof globalThis;\n";

export interface CachedRuntimeSourceMetadata {
  mtimeMs?: number;
}

interface EcmaScriptRuntimeDeclarationSource extends CachedRuntimeSourceMetadata {
  filePath: string;
  source: string;
}

interface CachedRuntimeProgram {
  filePath: string;
  mtimeMs: number | null;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedRuntimeProgram: CachedRuntimeProgram | null = null;
let runtimeProgramLoad: Promise<CachedRuntimeProgram> | null = null;

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => nodes.add(node));
  return nodes;
}

function parseRuntimeProgram(source: string): Program {
  const parsed = parseSource(source, { language: "typescript" });
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : [])
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(
      `Embedded TypeScript runtime declarations must parse without errors: ${errors.join("; ")}`
    );
  }
  return parsed.ast;
}

async function loadRuntimeProgram(): Promise<CachedRuntimeProgram> {
  const declaration = await getRuntimeDeclarationsHost()
    .loadEcmaScriptDeclarations() as EcmaScriptRuntimeDeclarationSource;
  const program = parseRuntimeProgram(`${declaration.source}\n${EXTRA_RUNTIME_DECLARATIONS}`);

  return {
    filePath: declaration.filePath,
    mtimeMs: declaration.mtimeMs ?? null,
    program,
    nodes: collectNodes(program)
  };
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  if (cachedRuntimeProgram) {
    return cachedRuntimeProgram.filePath;
  }

  return TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME;
}

export function getEcmaScriptRuntimeProgram(): Program {
  if (cachedRuntimeProgram) {
    return cachedRuntimeProgram.program;
  }

  throw new Error("ECMAScript runtime declarations have not been loaded");
}

export async function ensureEcmaScriptRuntimeProgram(): Promise<Program> {
  if (cachedRuntimeProgram) {
    return cachedRuntimeProgram.program;
  }

  // Concurrent callers share one in-flight load; a failed load is cleared so
  // a later call can retry instead of caching the rejection forever.
  if (!runtimeProgramLoad) {
    runtimeProgramLoad = loadRuntimeProgram();
  }
  try {
    cachedRuntimeProgram = await runtimeProgramLoad;
  } catch (error) {
    runtimeProgramLoad = null;
    throw error;
  }

  return cachedRuntimeProgram.program;
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  return cachedRuntimeProgram?.nodes.has(node) === true;
}
