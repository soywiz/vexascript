import type { Node, Program } from "compiler/ast/ast";
import {
  collectProgramNodes,
  DeclarationProgramCache,
  parseDeclarationProgram,
  type CachedDeclarationProgram
} from "./declarationProgramCache";
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

interface CachedRuntimeProgram extends CachedDeclarationProgram {
  filePath: string;
  mtimeMs: number | null;
}

const runtimeProgramCache = new DeclarationProgramCache<CachedRuntimeProgram>(async () => {
  const declaration = await getRuntimeDeclarationsHost()
    .loadEcmaScriptDeclarations() as EcmaScriptRuntimeDeclarationSource;
  const program = parseDeclarationProgram(
    `${declaration.source}\n${EXTRA_RUNTIME_DECLARATIONS}`,
    "Embedded TypeScript runtime declarations"
  );

  return {
    filePath: declaration.filePath,
    mtimeMs: declaration.mtimeMs ?? null,
    program,
    nodes: collectProgramNodes(program)
  };
});

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  return runtimeProgramCache.get()?.filePath ?? TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME;
}

export function getEcmaScriptRuntimeProgram(): Program {
  const cached = runtimeProgramCache.get();
  if (cached) {
    return cached.program;
  }

  throw new Error("ECMAScript runtime declarations have not been loaded");
}

export async function ensureEcmaScriptRuntimeProgram(): Promise<Program> {
  return (await runtimeProgramCache.ensure()).program;
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  return runtimeProgramCache.hasNode(node);
}
