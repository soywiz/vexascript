/**
 * Browser-compatible replacement for compiler/runtime/ecmascriptDeclarations.ts.
 * Instead of reading the bundled TypeScript runtime declarations from disk, they are inlined via
 * Vite's ?raw import so the worker bundle is fully self-contained.
 */

import rawSource from "../../../../compiler/runtime/es2025.d.ts?raw";
import { parseSource } from "compiler/pipeline/parse";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";

export const TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME = "es2025.d.ts";

let cachedProgram: Program | null = null;
let cachedNodes: WeakSet<object> | null = null;

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => nodes.add(node));
  return nodes;
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  return TYPESCRIPT_RUNTIME_DECLARATION_FILE_NAME;
}

export function getEcmaScriptRuntimeProgram(): Program {
  if (cachedProgram) return cachedProgram;
  const parsed = parseSource(rawSource, { language: "typescript" });
  if (!parsed.ast) {
    const errors = [
      ...(parsed.parserIssues ?? []).map((i) => i.message),
      ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
      ...(parsed.fatalError ? [parsed.fatalError] : []),
    ];
    throw new Error(
      `ECMAScript declarations failed to parse: ${errors.join("; ")}`
    );
  }
  cachedProgram = parsed.ast;
  cachedNodes = collectNodes(cachedProgram);
  return cachedProgram;
}

export async function ensureEcmaScriptRuntimeProgram(): Promise<Program> {
  return getEcmaScriptRuntimeProgram();
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  if (!cachedProgram || !cachedNodes) return false;
  return cachedNodes.has(node);
}
