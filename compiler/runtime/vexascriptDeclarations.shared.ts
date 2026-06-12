import type { Node, Program } from "compiler/ast/ast";
import {
  collectProgramNodes,
  DeclarationProgramCache,
  type CachedDeclarationProgram
} from "./declarationProgramCache";
import { getRuntimeDeclarationsHost } from "./declarationHost";
import { parseSource } from "compiler/pipeline/parse";

export const VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME = "vexascript.d.vx";

interface CachedVexaRuntimeProgram extends CachedDeclarationProgram {
  filePath: string;
}

const vexaRuntimeProgramCache = new DeclarationProgramCache<CachedVexaRuntimeProgram>(async () => {
  const declaration = await getRuntimeDeclarationsHost().loadVexaScriptDeclarations();
  const parsed = parseSource(`${declaration.source}\ndeclare var globalThis: typeof globalThis;`);
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : [])
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(`Embedded VexaScript runtime declarations must parse without errors: ${errors.join("; ")}`);
  }
  return {
    filePath: declaration.filePath,
    program: parsed.ast,
    nodes: collectProgramNodes(parsed.ast)
  };
});

export function getVexaScriptRuntimeDeclarationFilePath(): string {
  return vexaRuntimeProgramCache.get()?.filePath ?? VEXASCRIPT_RUNTIME_DECLARATION_FILE_NAME;
}

export function getVexaScriptRuntimeProgram(): Program {
  const cached = vexaRuntimeProgramCache.get();
  if (cached) {
    return cached.program;
  }

  throw new Error("VexaScript runtime declarations have not been loaded");
}

export async function ensureVexaScriptRuntimeProgram(): Promise<Program> {
  return (await vexaRuntimeProgramCache.ensure()).program;
}

export function isVexaScriptRuntimeNode(node: Node): boolean {
  return vexaRuntimeProgramCache.hasNode(node);
}
