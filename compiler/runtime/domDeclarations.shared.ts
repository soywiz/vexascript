import type { Node, Program } from "compiler/ast/ast";
import { cacheProgram } from "./programCache";
import {
  collectProgramNodes,
  DeclarationProgramCache,
  parseDeclarationProgram,
  type CachedDeclarationProgram
} from "./declarationProgramCache";
import { getRuntimeDeclarationsHost } from "./declarationHost";

export const TYPESCRIPT_DOM_DECLARATION_FILE_NAME = "dom.d.ts";
const DOM_CACHE_SALT = "dom-runtime-v1";

interface CachedDomProgram extends CachedDeclarationProgram {
  filePath: string;
}

function normalizeDomSourceForParser(source: string): string {
  return source.replace(/`[^`]*`/g, "string");
}

const domProgramCache = new DeclarationProgramCache<CachedDomProgram>(async () => {
  const declaration = await getRuntimeDeclarationsHost().loadDomDeclarations();
  const program = await cacheProgram(
    declaration.filePath,
    `${DOM_CACHE_SALT}:${declaration.source}`,
    async () =>
      parseDeclarationProgram(
        normalizeDomSourceForParser(declaration.source),
        "Embedded DOM declarations"
      )
  );

  return {
    filePath: declaration.filePath,
    program,
    nodes: collectProgramNodes(program)
  };
});

export function getDomDeclarationFilePath(): string {
  return domProgramCache.get()?.filePath ?? TYPESCRIPT_DOM_DECLARATION_FILE_NAME;
}

export async function ensureDomProgram(): Promise<Program> {
  return (await domProgramCache.ensure()).program;
}

export function isDomRuntimeNode(node: Node): boolean {
  return domProgramCache.hasNode(node);
}
