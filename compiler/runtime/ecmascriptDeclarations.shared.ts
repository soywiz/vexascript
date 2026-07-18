import type { Node, Program } from "compiler/ast/ast";
import {
  collectProgramNodes,
  parseDeclarationProgram,
  type CachedDeclarationProgram
} from "./declarationProgramCache";
import { ECMA_SCRIPT_RUNTIME_DECLARATIONS } from "./embeddedRuntimeSources";

export const TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME: string = "es2025.d.ts";
const EXTRA_RUNTIME_DECLARATIONS: string = [
  "declare var globalThis: typeof globalThis;"
].join("\n");

interface CachedRuntimeProgram extends CachedDeclarationProgram {
  filePath: string;
}

let runtimeDeclarationFilePath = TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME;
let runtimeProgramCache: CachedRuntimeProgram | null = null;

export function setEcmaScriptRuntimeDeclarationFilePath(filePath: string): void {
  runtimeDeclarationFilePath = filePath;
}

function loadEcmaScriptRuntimeProgram(): CachedRuntimeProgram {
  const program = parseDeclarationProgram(
    `${ECMA_SCRIPT_RUNTIME_DECLARATIONS}\n${EXTRA_RUNTIME_DECLARATIONS}`,
    "Embedded TypeScript runtime declarations"
  );

  return {
    filePath: runtimeDeclarationFilePath,
    program,
    nodes: collectProgramNodes(program)
  };
}

function getCachedEcmaScriptRuntimeProgram(): CachedRuntimeProgram {
  runtimeProgramCache ??= loadEcmaScriptRuntimeProgram();
  return runtimeProgramCache;
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  return getCachedEcmaScriptRuntimeProgram().filePath;
}

export function getEcmaScriptRuntimeProgram(): Program {
  return getCachedEcmaScriptRuntimeProgram().program;
}

export async function ensureEcmaScriptRuntimeProgram(): Promise<Program> {
  return getEcmaScriptRuntimeProgram();
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  return runtimeProgramCache?.nodes.has(node) === true;
}
