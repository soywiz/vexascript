import type { Program } from "../../compiler/ast/ast";
import { parseSource } from "../../compiler/pipeline/parse";
import DOM_RUNTIME_DECLARATIONS from "../../compiler/runtime/dom.d.ts?text";

export const TYPESCRIPT_DOM_DECLARATION_FILE_NAME = "dom.d.ts";

let domProgram: Program | null = null;

export function getDomDeclarationFilePath(): string {
  return TYPESCRIPT_DOM_DECLARATION_FILE_NAME;
}

export async function ensureDomProgram(): Promise<Program> {
  if (domProgram) {
    return domProgram;
  }
  const parsed = parseSource(DOM_RUNTIME_DECLARATIONS, { language: "typescript" });
  if (!parsed.ast) {
    throw new Error("Unable to parse embedded DOM declarations");
  }
  domProgram = parsed.ast;
  return domProgram;
}

export function isDomRuntimeNode(_node: unknown): boolean {
  return false;
}
