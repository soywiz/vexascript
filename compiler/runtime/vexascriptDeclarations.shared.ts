import type { Node, Program } from "compiler/ast/ast";
import {
  collectProgramNodes,
  type CachedDeclarationProgram
} from "./declarationProgramCache";
import { parseSource } from "compiler/pipeline/parse";
import { VEXA_SCRIPT_RUNTIME_DECLARATIONS } from "./embeddedRuntimeSources";

export const VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME = "vexascript.d.vx";

interface CachedVexaRuntimeProgram extends CachedDeclarationProgram {
  filePath: string;
}

let vexaRuntimeDeclarationFilePath = VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME;
let vexaRuntimeProgramCache: CachedVexaRuntimeProgram | null = null;

export function setVexaScriptRuntimeDeclarationFilePath(filePath: string): void {
  vexaRuntimeDeclarationFilePath = filePath;
}

function loadVexaScriptRuntimeProgram(): CachedVexaRuntimeProgram {
  const parsed = parseSource(`${VEXA_SCRIPT_RUNTIME_DECLARATIONS}\ndeclare var globalThis: typeof globalThis;`);
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : [])
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(`Embedded VexaScript runtime declarations must parse without errors: ${errors.join("; ")}`);
  }
  return {
    filePath: vexaRuntimeDeclarationFilePath,
    program: parsed.ast,
    nodes: collectProgramNodes(parsed.ast)
  };
}

function getCachedVexaScriptRuntimeProgram(): CachedVexaRuntimeProgram {
  vexaRuntimeProgramCache ??= loadVexaScriptRuntimeProgram();
  return vexaRuntimeProgramCache;
}

export function getVexaScriptRuntimeDeclarationFilePath(): string {
  return getCachedVexaScriptRuntimeProgram().filePath;
}

export function getVexaScriptRuntimeProgram(): Program {
  return getCachedVexaScriptRuntimeProgram().program;
}

export async function ensureVexaScriptRuntimeProgram(): Promise<Program> {
  return getVexaScriptRuntimeProgram();
}

export function isVexaScriptRuntimeNode(node: Node): boolean {
  return vexaRuntimeProgramCache?.nodes.has(node) === true;
}
