import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { cacheProgram } from "./programCache";
import { getRuntimeDeclarationsHost } from "./declarationHost";

export const TYPESCRIPT_DOM_DECLARATION_FILE_NAME = "dom.d.ts";
const DOM_CACHE_SALT = "dom-runtime-v1";

export interface CachedDomSourceMetadata {}

interface CachedDomProgram {
  filePath: string;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedDomProgram: CachedDomProgram | null = null;

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => nodes.add(node));
  return nodes;
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

async function loadDomProgram(): Promise<CachedDomProgram> {
  const declaration = await getRuntimeDeclarationsHost().loadDomDeclarations();
  const program = await cacheProgram(
    declaration.filePath,
    `${DOM_CACHE_SALT}:${declaration.source}`,
    async () => parseDomProgram(declaration.source)
  );

  return {
    filePath: declaration.filePath,
    program,
    nodes: collectNodes(program)
  };
}

export function getDomDeclarationFilePath(): string {
  return cachedDomProgram?.filePath ?? TYPESCRIPT_DOM_DECLARATION_FILE_NAME;
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
