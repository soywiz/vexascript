import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { fileExists } from "compiler/utils/fs";
export const TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME = "es2025.d.ts";
const EXTRA_RUNTIME_DECLARATIONS = "declare var globalThis: typeof globalThis;\n";

interface CachedRuntimeProgram {
  filePath: string;
  mtimeMs: number;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedRuntimeProgram: CachedRuntimeProgram | null = null;
const runtimeDeclarationFilePath = await resolveRuntimeDeclarationFilePath();

function currentDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

async function resolveRuntimeDeclarationFilePath(): Promise<string> {
  const bundledPath = resolve(currentDirectory(), TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME);
  if (await fileExists(bundledPath)) {
    return bundledPath;
  }

  return resolve(process.cwd(), "compiler", "runtime", TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME);
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  return runtimeDeclarationFilePath;
}

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
  const source = `${await readFile(runtimeDeclarationFilePath, "utf8")}\n${EXTRA_RUNTIME_DECLARATIONS}`;
  const { mtimeMs } = await stat(runtimeDeclarationFilePath);
  const program = parseRuntimeProgram(source);

  return {
    filePath: runtimeDeclarationFilePath,
    mtimeMs,
    program,
    nodes: collectNodes(program)
  };
}

cachedRuntimeProgram = await loadRuntimeProgram();

export function getEcmaScriptRuntimeProgram(): Program {
  if (cachedRuntimeProgram) {
    return cachedRuntimeProgram.program;
  }

  throw new Error("ECMAScript runtime declarations have not been loaded");
}

/**
 * Loads and caches the runtime program. Safe to call multiple times — resolves
 * immediately after the first successful load.
 */
export async function ensureEcmaScriptRuntimeProgram(): Promise<Program> {
  if (!cachedRuntimeProgram) {
    cachedRuntimeProgram = await loadRuntimeProgram();
  }

  return cachedRuntimeProgram.program;
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  const program = getEcmaScriptRuntimeProgram();
  return cachedRuntimeProgram?.program === program && cachedRuntimeProgram.nodes.has(node) === true;
}
