import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { fileExists } from "compiler/utils/fs";
import { loadCachedProgram, storeCachedProgram } from "./programCache";

export const TYPESCRIPT_DOM_DECLARATION_FILE_NAME = "dom.d.ts";
const DOM_CACHE_SALT = "dom-runtime-v1";

interface CachedDomProgram {
  filePath: string;
  mtimeMs: number;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedDomProgram: CachedDomProgram | null = null;
const domDeclarationFilePath = await resolveDomDeclarationFilePath();

function currentDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

async function resolveDomDeclarationFilePath(): Promise<string> {
  const bundledPath = resolve(currentDirectory(), TYPESCRIPT_DOM_DECLARATION_FILE_NAME);
  if (await fileExists(bundledPath)) {
    return bundledPath;
  }

  return resolve(process.cwd(), "compiler", "runtime", TYPESCRIPT_DOM_DECLARATION_FILE_NAME);
}

export function getDomDeclarationFilePath(): string {
  return domDeclarationFilePath;
}

function normalizeDomSourceForParser(source: string): string {
  return source.replace(/`[^`]*`/g, "string");
}

function parseDomProgram(source: string): Program {
  const parsed = parseSource(normalizeDomSourceForParser(source), { language: "typescript" });
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : [])
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(
      `Embedded DOM declarations must parse without errors: ${errors.join("; ")}`
    );
  }
  return parsed.ast;
}

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => nodes.add(node));
  return nodes;
}

async function loadDomProgram(): Promise<CachedDomProgram> {
  const { mtimeMs } = await stat(domDeclarationFilePath);
  const cachedProgram = await loadCachedProgram(domDeclarationFilePath, mtimeMs, DOM_CACHE_SALT);
  if (cachedProgram) {
    return {
      filePath: domDeclarationFilePath,
      mtimeMs,
      program: cachedProgram,
      nodes: collectNodes(cachedProgram)
    };
  }

  const source = await readFile(domDeclarationFilePath, "utf8");
  const program = parseDomProgram(source);
  await storeCachedProgram(domDeclarationFilePath, mtimeMs, DOM_CACHE_SALT, program);

  return {
    filePath: domDeclarationFilePath,
    mtimeMs,
    program,
    nodes: collectNodes(program)
  };
}

export async function ensureDomProgram(): Promise<Program> {
  if (!cachedDomProgram) {
    cachedDomProgram = await loadDomProgram();
  }

  return cachedDomProgram.program;
}

export function isDomRuntimeNode(node: Node): boolean {
  return cachedDomProgram?.nodes.has(node) === true;
}
