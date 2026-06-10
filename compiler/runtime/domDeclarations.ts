import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { fileExists } from "compiler/utils/fs";
import { cacheProgram } from "./programCache";

export const TYPESCRIPT_DOM_DECLARATION_FILE_NAME = "dom.d.ts";
const DOM_CACHE_SALT = "dom-runtime-v1";

interface CachedDomProgram {
  filePath: string;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedDomProgram: CachedDomProgram | null = null;
const domDeclarationUrl = new URL(`./${TYPESCRIPT_DOM_DECLARATION_FILE_NAME}`, import.meta.url);

function defaultDomDeclarationFilePath(): string {
  const localPath = fileURLToPath(domDeclarationUrl);
  if (localPath.startsWith("http://") || localPath.startsWith("https://")) {
    return TYPESCRIPT_DOM_DECLARATION_FILE_NAME;
  }
  return localPath;
}

async function loadBundledDomDeclarationSource(): Promise<{ filePath: string; source: string }> {
  const localPath = fileURLToPath(domDeclarationUrl);
  if (await fileExists(localPath)) {
    return {
      filePath: localPath,
      source: await readFile(localPath, "utf8"),
    };
  }

  const response = await fetch(domDeclarationUrl);
  if (!response.ok) {
    throw new Error(`Failed to load bundled DOM declarations from ${domDeclarationUrl.toString()}`);
  }

  return {
    filePath: TYPESCRIPT_DOM_DECLARATION_FILE_NAME,
    source: await response.text(),
  };
}

export function getDomDeclarationFilePath(): string {
  return cachedDomProgram?.filePath ?? defaultDomDeclarationFilePath();
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
  const { filePath, source } = await loadBundledDomDeclarationSource();
  const program = await cacheProgram(
    filePath,
    `${DOM_CACHE_SALT}:${source}`,
    async () => parseDomProgram(source)
  );

  return {
    filePath,
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
