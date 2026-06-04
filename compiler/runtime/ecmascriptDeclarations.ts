import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";

export const ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME = "ecmascript.d.my";

interface CachedRuntimeProgram {
  filePath: string;
  mtimeMs: number;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedRuntimeProgram: CachedRuntimeProgram | null = null;

function currentDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  const bundledPath = resolve(currentDirectory(), ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME);
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return resolve(process.cwd(), "compiler", "runtime", ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME);
}

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => nodes.add(node));
  return nodes;
}

function parseRuntimeProgram(filePath: string): Program {
  const source = readFileSync(filePath, "utf8");
  const parsed = parseSource(source);
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : [])
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(
      `Embedded ECMAScript runtime declarations must parse without errors: ${errors.join("; ")}`
    );
  }
  return parsed.ast;
}

export function getEcmaScriptRuntimeProgram(): Program {
  const filePath = getEcmaScriptRuntimeDeclarationFilePath();
  const mtimeMs = statSync(filePath).mtimeMs;
  if (
    cachedRuntimeProgram &&
    cachedRuntimeProgram.filePath === filePath &&
    cachedRuntimeProgram.mtimeMs === mtimeMs
  ) {
    return cachedRuntimeProgram.program;
  }

  const program = parseRuntimeProgram(filePath);
  cachedRuntimeProgram = {
    filePath,
    mtimeMs,
    program,
    nodes: collectNodes(program)
  };
  return program;
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  const program = getEcmaScriptRuntimeProgram();
  return cachedRuntimeProgram?.program === program && cachedRuntimeProgram.nodes.has(node) === true;
}
